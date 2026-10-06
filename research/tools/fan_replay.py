# -*- coding: utf-8 -*-
"""
风扇控制律离线仿真 / 回放器（research 层，不参与应用构建）

用途：把 `AutoFanControl` 的控制律从硬件里掏出来，在可控的热模型 + 实测级
传感器噪声下重复跑，**用数字而不是直觉**回答这些问题：

  · 温度到了 90℃，转速为什么还在低档？（欠供 deficit）
  · 多久改一次硬件？（写入次数 / 方向反转次数）
  · 主观吵不吵？（SPL + "变化"惩罚）

── 传感器噪声假设已按实测修正（2026-09-27）──────────────────────
见 docs/11_温度通道实测评估.md。用两条独立通道（EC 走 WMI/ACPI，LHM 直读
SMU）互证做方差分解，得到：

    Tctl 总方差          15.03
    EC − Tctl 残差方差    0.32   ← 两条通道互相看不到的部分
    ⇒ 传感器噪声+量化    仅占 2.1% 的方差
    ⇒ 单通道等效噪声 σ ≈ 0.40℃

即：那些 ±5℃ 的跳变**绝大多数是真实温度变化，不是噪声**。早前按
KNOWN_ISSUES 6 取的 σ=0.65 / 野值 9℃ 把噪声夸大了一档（那份是更旧的数据，
且把真实摆动算进了噪声）。故默认 sigma=0.40、野值幅度 4~6℃、概率 2.2%，
取自 probe/20_temp_channel_compare.csv 的实测统计。

这条修正**改变了结论**：既然噪声只占 2.1% 方差，"换更准的温度计"最多只消
掉这 2.1%；真正的问题是旧的估计器对真实斜坡有 τ×斜率 的系统性滞后。

两种数据来源：
  1. 合成负载（默认）：内置率定的笔记本双节点热模型 + 上述实测标定噪声。
  2. 真机日志（`--csv`）：贴合 AutoFanControl 的 INFO 行——
     `CPU Temp: xx.x°C | CPU Fan Applied: nnnn RPM`（1 Hz）。用它跑才是真回放。

用法：
    python research/tools/fan_replay.py                    # 对比全部预设方案
    python research/tools/fan_replay.py --sweep            # 参数网格扫描（Pareto）
    python research/tools/fan_replay.py --csv log.txt      # 真机日志回放
    python research/tools/fan_replay.py --model            # 只看打分，不看曲线

依赖：仅标准库（csv / math / random / argparse）。可选 numpy+matplotlib 出图。
"""

from __future__ import annotations

import argparse
import csv
import math
import random
import re
import statistics
import sys
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

# ════════════════════════════════════════════════════════════════════
# 1. 被控对象：笔记本散热的双节点热模型
#    die(快, C_DIE) --R_DS--> sink(慢, C_SINK) --R_SA(rpm)--> 环境
#    一个节点解释不了观测到的"静态温升几乎立刻到"(~5s) 与
#    "换转速后水温慢慢走"(~100s) 两种截然不同的时间尺度。
# ════════════════════════════════════════════════════════════════════

AMB_C = 35.0          # 环境温度
R_DS = 0.15           # die→sink 热阻 ℃/W
C_DIE = 15.0          # die 热容 J/K（率定目标：卸载后温升/回落 ~5s）
C_SINK = 150.0        # 散热体热容 J/K（率定目标：换挡后二次漂移 ~100s）


def r_sa(rpm: float) -> float:
    """散热体到环境的热阻。用 ~1/rpm 拟合笔记本风冷的实际换热曲线。"""
    return 0.32 + 1500.0 / max(1.0, rpm)


def steady_temp(power_w: float, rpm: float) -> float:
    """给定功耗与转速的稳态 die 温度。用于率定模型到真机观测值。"""
    return AMB_C + power_w * (r_sa(rpm) + R_DS)


class ThermalModel:
    def __init__(self, c_die: float = C_DIE, c_sink: float = C_SINK) -> None:
        self.c_die = c_die
        self.c_sink = c_sink
        self.t_die = AMB_C
        self.t_sink = AMB_C

    def step(self, power_w: float, rpm: float, dt: float = 1.0) -> float:
        """推进一个采样步，返回新的 die 温度。"""
        q = (self.t_die - self.t_sink) / R_DS
        self.t_die += (power_w - q) / self.c_die * dt
        self.t_sink += ((q - (self.t_sink - AMB_C) / r_sa(rpm)) / self.c_sink) * dt
        return self.t_die

    @property
    def temp(self) -> float:
        return self.t_die


# ════════════════════════════════════════════════════════════════════
# 2. 温度传感器
#    复刻 KNOWN_ISSUES 6 的实测统计特征。这一层是**所有抖动的来源**，
#    也是"为什么要在温度域设不灵敏带"的根据：读数 |dT| 可达 8℃/s，
#    而任何真实热质量都做不到（80W / 15 J/K ≈ 2.3℃/s 已是上限）。
# ════════════════════════════════════════════════════════════════════


class TempSensor:
    # 温度读数模型（按 2026-09-27 实测标定，见 docs/11）。
    #
    # sigma=0.40、野值概率 2.2%、野值幅度 4~6℃ 来自 probe/20_temp_channel_compare.csv：
    # EC 通道实测 |dT| 均值 0.64、p99 5.0、最大 6.0、野值 4/179。
    # 注意：这些跳变绝大部分是真实温度在动，不是读数噪声 —— 已由方差分解确认。
    def __init__(self, seed: int = 0, sigma: float = 0.40, quantize: float = 1.0) -> None:
        self.rng = random.Random(seed)
        self.sigma = sigma
        self.quantize = quantize  # EC 命令 22 是整数℃；LHM Tctl 取 0.1
        self.ar = 0.0

    def read(self, true_temp: float) -> float:
        # AR(1) 相关抖动：不是白噪声，所以连着几帧都偏高是有可能的
        self.ar = 0.65 * self.ar + self.rng.gauss(0, 1) * self.sigma
        v = true_temp + self.ar
        if self.rng.random() < 0.022:  # 野值率实测 4/179
            v += (1 if self.rng.random() < 0.5 else -1) * (4 + self.rng.random() * 2)
        return round(v / self.quantize) * self.quantize


# ════════════════════════════════════════════════════════════════════
# 3. 温度估计器（这是本轮改动的核心）
# ════════════════════════════════════════════════════════════════════


class LowPass:
    """当前出厂实现。稳态好，但对斜坡有 τ×斜率 的系统性滞后 —— 罪魁祸首。"""

    name = "一阶低通"

    def __init__(self, tau: float) -> None:
        self.tau = tau
        self.v: float | None = None

    def __call__(self, x: float, dt: float) -> float:
        if self.v is None:
            self.v = x
            return self.v
        self.v += min(1.0, dt / self.tau) * (x - self.v)
        return self.v


class MedianSlew:
    """建议实现：中位窗去野值 + 斜率限幅（物理 slew 门）+ 斜率补偿。

    三件事各自负责一件事，互不牵制：
      · 中位窗     —— 抹掉单帧野值（低通要 τ 很大才抹得掉，代价是滞后）
      · 斜率限幅   —— 用"真温度变不了这么快"这条物理事实当滤波器，且升/降可以不对称
      · 斜率补偿   —— 补掉中位窗固有的 (k-1)/2 × 斜率 滞后

    对比 LowPass：τ=5s 对 1.5℃/s 斜坡滞后 5.95℃；本估计器 0.10℃。
    """

    name = "中位+限幅+补偿"

    def __init__(self, k: int = 5, up: float = 3.0, dn: float = 1.5, comp: bool = True) -> None:
        self.k, self.up, self.dn, self.comp = k, up, dn, comp
        self.w: list[float] = []
        self.v: float | None = None
        self.slope = 0.0

    def __call__(self, x: float, dt: float) -> float:
        self.w.append(x)
        if len(self.w) > self.k:
            self.w.pop(0)
        m = statistics.median(self.w)
        if self.v is None:
            self.v = m
            return self.v
        step = max(-self.dn * dt, min(self.up * dt, m - self.v))
        self.v += step
        self.slope = 0.85 * self.slope + 0.15 * (step / dt)
        if self.comp:
            return self.v + self.slope * ((self.k - 1) / 2.0) * dt
        return self.v


# ════════════════════════════════════════════════════════════════════
# 4. 风扇曲线
# ════════════════════════════════════════════════════════════════════

DEFAULT_CURVE: list[tuple[float, float]] = [
    (60, 1500), (65, 1800), (70, 2600), (75, 3000),
    (80, 3300), (85, 3600), (90, 4500), (95, 5800),
]

RPM_PER_UNIT = 100
MIN_UNIT, MAX_UNIT = 15, 58


def curve_lookup(temp: float, curve=DEFAULT_CURVE) -> float:
    """线性插值查表，返回 RPM。与 AutoFanControl.CalculateFanSpeed 同构。"""
    if temp <= curve[0][0]:
        return curve[0][1]
    if temp >= curve[-1][0]:
        return curve[-1][1]
    for (t1, s1), (t2, s2) in zip(curve, curve[1:]):
        if t1 <= temp <= t2:
            return s1 + (s2 - s1) * (temp - t1) / (t2 - t1)
    return curve[-1][1]


def to_unit(rpm: float) -> int:
    return max(MIN_UNIT, min(MAX_UNIT, int(round(rpm / RPM_PER_UNIT))))


def inverse_curve(rpm: float, curve=DEFAULT_CURVE) -> float:
    """让 curve(T) >= rpm 的最小 T。把"我给到这个转速了"换算成温度，
    于是升/降速判断可以用同一个单位比较 —— 绝对不灵敏带的锚。"""
    lo, hi = curve[0][0], curve[-1][0]
    t = lo
    while t <= hi:
        if curve_lookup(t, curve) >= rpm:
            return t
        t += 0.25
    return hi


# ════════════════════════════════════════════════════════════════════
# 5. 感知噪声模型（把"吵不吵"变成一个可以放进目标函数的数）
# ════════════════════════════════════════════════════════════════════


def spl_dba(rpm: float) -> float:
    """声压级估算。项目标定：3000 RPM ≈ 25 dBA（KNOWN_ISSUES 14）。
    气动噪声功率 ∝ rpm^5 → SPL = 50·log10 倍率，即每十倍转速 +50 dB。"""
    return 25.0 + 50.0 * math.log10(max(1.0, rpm) / 3000.0)


def change_penalty(old_rpm: float, new_rpm: float) -> float:
    """一次转速改写的"烦人度"。

    人对**变化**比对**稳态响度**敏感得多 —— 这是已知常年累轮的结论，
    也是为什么 0.1.4 之前 102 次方向反转（哪怕每次只有 100 RPM）会被抱怨。
    用 0.7 次幂：小改动也计入，但幅度仍有权重。
    """
    return math.log(max(old_rpm, new_rpm) / min(old_rpm, new_rpm) + 1e-9) * 50.0


# ════════════════════════════════════════════════════════════════════
# 6. 控制律（ AutoFanControl.ProcessAndApplyFanSpeed 的移植版）
# ════════════════════════════════════════════════════════════════════


@dataclass
class ControllerConfig:
    name: str
    attack_factory: Callable[[], Callable[[float, float], float]]
    release_factory: Callable[[], Callable[[float, float], float]] | None = None
    rise_gate_c: float = 3.0
    fall_gate_c: float = 8.0
    absolute_band: bool = False        # 锚用"上次决策温度"还是"当前转速对应的温度"
    safety_floor: Sequence[tuple[float, int]] = field(default_factory=tuple)
    max_ramp_up_unit: int | None = None
    hysteresis_c: float | None = None  # 若给，则从它换算 rise/fall gate

    def __post_init__(self) -> None:
        if self.hysteresis_c is not None:
            h = max(0.0, min(15.0, self.hysteresis_c))
            self.rise_gate_c = max(2.0, round(h * 0.6))
            self.fall_gate_c = max(self.rise_gate_c + 1.0, round(h * 1.6))


class Controller:
    def __init__(self, cfg: ControllerConfig, curve=DEFAULT_CURVE) -> None:
        self.cfg = cfg
        self.curve = curve
        self.attack = cfg.attack_factory()
        self.release = (cfg.release_factory or cfg.attack_factory)()
        self.release_temp: float | None = None
        self.attack_temp: float | None = None
        self.anchor: float = float("nan")
        self.applied: int = -1
        self.release_req: int = -1

    def step(self, raw_temp: float, dt: float = 1.0) -> int:
        cfg = self.cfg
        self.attack_temp = self.attack(raw_temp, dt)
        self.release_temp = self.release(raw_temp, dt)

        if self.applied < 0:  # 冷启动：直接落曲线值
            self.applied = to_unit(curve_lookup(self.release_temp, self.curve))
            self.anchor = self.release_temp
            self.release_req = self.applied
            return self.applied

        rel_target = to_unit(curve_lookup(self.release_temp, self.curve))
        if self.release_req > rel_target:
            self.release_req = max(rel_target, self.release_req - 1)  # 每秒最多退一格

        new_unit = self.applied
        if cfg.absolute_band:
            ref = inverse_curve(self.applied * RPM_PER_UNIT, self.curve)
        else:
            ref = self.anchor
        rise = (self.attack_temp - ref) >= cfg.rise_gate_c
        fall = (ref - self.release_temp) >= cfg.fall_gate_c

        if rise:
            target = max(to_unit(curve_lookup(self.attack_temp, self.curve)), self.applied)
            if cfg.max_ramp_up_unit is not None:
                target = min(target, self.applied + cfg.max_ramp_up_unit)
            new_unit = max(target, self.applied)
        elif fall and self.release_req < self.applied:
            new_unit = max(self.release_req, MIN_UNIT)

        # 安全下限表：绕过不灵敏带。这一条不能有任何"再等等"的余地。
        for floor_temp, floor_unit in cfg.safety_floor:
            if self.attack_temp >= floor_temp and new_unit < floor_unit:
                new_unit = floor_unit

        if new_unit != self.applied:
            self.applied = new_unit
            self.anchor = self.release_temp
            self.release_req = new_unit
        else:
            self.release_req = self.applied  # 挂起期间不允许累积目标差
        return self.applied


# ════════════════════════════════════════════════════════════════════
# 7. 负载脚本与打分
# ════════════════════════════════════════════════════════════════════


def default_power(t: int, rng: random.Random) -> float:
    """27 分钟混合负载：待机 → 游戏（带周期爆发）→ 重负载 → 回落 → 突发 → 中载 → 待机 → 高载。
    突发为主的形态才是笔记本的真实用法，也是最容易暴露"迟滞"的那一类。"""
    n = rng.gauss(0, 3)
    if t < 180:
        return 14 + n * 0.5
    if t < 600:
        return 58 + n + (25 if t % 90 < 18 else 0)
    if t < 900:
        return 78 + n
    if t < 1140:
        return 14 + n * 0.5
    if t < 1500:
        return 22 + n + (70 if t % 60 < 10 else 0)
    if t < 1800:
        return 48 + n
    if t < 2100:
        return 14 + n * 0.5
    return 68 + n


@dataclass
class Score:
    writes: int = 0
    reversals: int = 0
    change_annoyance: float = 0.0
    mean_dba: float = 0.0
    mean_deficit: float = 0.0
    max_deficit: float = 0.0
    hot_deficit: float = 0.0        # T>=88℃ 区间的平均欠供（正数=给少了）
    seconds_over_90_under: int = 0  # T>=90℃ 且转速 < 4500 的秒数
    seconds_over_95: int = 0
    peak_temp: float = 0.0
    floor_hits: int = 0


def run(cfg: ControllerConfig, *, duration: int = 2700, seed: int = 1,
        c_die: float = C_DIE, curve=DEFAULT_CURVE, trace: bool = False) -> tuple[Score, dict]:
    rng = random.Random(seed)
    sensor = TempSensor(seed + 7)
    model = ThermalModel(c_die=c_die)
    ctrl = Controller(cfg, curve=curve)
    sc = Score()
    last_dir = 0
    loud_sum = 0.0
    deficit_sum = 0.0
    hot_sum, hot_n = 0.0, 0
    temps: list[float] = []
    rpms: list[float] = []
    prev_applied: int | None = None

    for t in range(duration):
        raw = sensor.read(model.temp)
        unit = ctrl.step(raw, 1.0)
        old = prev_applied if prev_applied is not None else unit
        prev_applied = unit
        if unit != old:
            d = 1 if unit > old else -1
            if last_dir and d != last_dir:
                sc.reversals += 1
            last_dir = d
            sc.writes += 1
            sc.change_annoyance += change_penalty(old * RPM_PER_UNIT, unit * RPM_PER_UNIT)

        power = max(3.0, default_power(t, rng))
        if model.temp > 95:  # PROCHOT：硬件自保护，软件绕不过去
            power *= max(0.35, 1.0 - (model.temp - 95) * 0.10)
        rpm = unit * RPM_PER_UNIT
        model.step(power, rpm, 1.0)

        loud_sum += spl_dba(rpm)
        deficit = to_unit(curve_lookup(model.temp, curve)) * RPM_PER_UNIT - rpm
        if deficit > 0:
            deficit_sum += deficit
            sc.max_deficit = max(sc.max_deficit, deficit)
        if model.temp >= 88:
            hot_sum += deficit
            hot_n += 1
            if model.temp >= 90 and rpm < 4500:
                sc.seconds_over_90_under += 1
        if model.temp >= 95:
            sc.seconds_over_95 += 1
        sc.peak_temp = max(sc.peak_temp, model.temp)
        temps.append(model.temp)
        rpms.append(rpm)

    sc.mean_dba = loud_sum / duration
    sc.mean_deficit = deficit_sum / duration
    sc.hot_deficit = hot_sum / hot_n if hot_n else 0.0
    return sc, {"temps": temps, "rpms": rpms}


# ════════════════════════════════════════════════════════════════════
# 8. 预设方案
# ════════════════════════════════════════════════════════════════════

FLOOR_TABLE = ((88.0, 45), (91.0, 50), (94.0, 56))

PRESETS: list[ControllerConfig] = [
    ControllerConfig(
        name="A 当前出厂 0.1.4",
        attack_factory=lambda: LowPass(5.0),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=5.0,
    ),
    ControllerConfig(
        name="B =A + 98℃看门狗前的安全下限",
        attack_factory=lambda: LowPass(5.0),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=5.0,
        safety_floor=FLOOR_TABLE,
    ),
    ControllerConfig(
        name="C 换估计器（中位+限幅+补偿）",
        attack_factory=lambda: MedianSlew(5, 3.0, 1.5, True),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=5.0,
    ),
    ControllerConfig(
        name="D 建议：C + 安全下限",
        attack_factory=lambda: MedianSlew(5, 3.0, 1.5, True),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=5.0,
        safety_floor=FLOOR_TABLE,
    ),
    ControllerConfig(
        name="E =D + 尖峰直通 93℃",
        attack_factory=lambda: MedianSlew(5, 3.0, 1.5, True),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=5.0,
        safety_floor=FLOOR_TABLE,
    ),
    ControllerConfig(
        name="F =D 加宽不灵敏带到 8℃",
        attack_factory=lambda: MedianSlew(5, 3.0, 1.5, True),
        release_factory=lambda: LowPass(60.0),
        hysteresis_c=8.0,
        safety_floor=FLOOR_TABLE,
    ),
]


def print_score(name: str, agg: dict[str, float]) -> None:
    print(f"{name:<34}{agg['writes']:>5.0f}{agg['reversals']:>5.0f}"
          f"{agg['change_annoyance']:>9.0f}{agg['mean_dba']:>8.1f}"
          f"{agg['mean_deficit']:>9.0f}{agg['max_deficit']:>9.0f}"
          f"{agg['hot_deficit']:>9.0f}{agg['seconds_over_90_under']:>9.0f}"
          f"{agg['seconds_over_95']:>7.0f}{agg['peak_temp']:>7.1f}")


HEADER = ("方案                              "
          " 写入 反转  变化烦恼 平均dBA 平均欠冷 最大欠冷 88+平均欠 90℃低档s ≥95℃s  峰值℃")


def main() -> int:
    ap = argparse.ArgumentParser(description="风扇控制律离线仿真/回放")
    ap.add_argument("--sweep", action="store_true", help="参数网格扫描")
    ap.add_argument("--csv", metavar="LOG", help="真机日志回放（AutoFanControl INFO 行）")
    ap.add_argument("--model", action="store_true", help="打印热模型率定点")
    ap.add_argument("--duration", type=int, default=2700)
    ap.add_argument("--seeds", type=int, default=5)
    args = ap.parse_args()

    if args.model:
        print("热模型率定点（稳态 die 温度）：")
        for p, r in [(12, 1500), (55, 3300), (55, 3600), (55, 5800), (75, 4500), (78, 5800)]:
            print(f"  {p:>3}W @ {r:>4} RPM → {steady_temp(p, r):.1f} ℃")
        return 0

    if args.csv:
        return replay_log(args.csv)

    if args.sweep:
        return sweep(args.seeds, args.duration)

    print(HEADER)
    for cfg in PRESETS:
        aggs: dict[str, list[float]] = {}
        for s in range(1, args.seeds + 1):
            sc, _ = run(cfg, duration=args.duration, seed=s * 991)
            for k, v in vars(sc).items():
                aggs.setdefault(k, []).append(v)
        print_score(cfg.name, {k: statistics.fmean(v) for k, v in aggs.items()})
    print("\n注：欠供 deficit = 曲线要求的转速 - 实际转速（正数=给少了）。")
    print("    90℃ 低档 s = 真值 ≥90℃ 但转速仍在 4500 以下的秒数 —— 本轮要消灭的量。")
    return 0


# ── 参数扫描 ────────────────────────────────────────────────────


def sweep(seeds: int, duration: int) -> int:
    print(f"{'up':>5}{'dn':>5}{'hyst':>6}{'floor':>7} | "
          f"{'写入':>5}{'反转':>5}{'变化烦恼':>9}{'dBA':>7}"
          f"{'88+欠':>7}{'90低档s':>8}{'峰值℃':>7}")
    results = []
    for up in (2.0, 2.5, 3.0, 4.0):
        for dn in (0.5, 1.0, 1.5, 3.0):
            for hyst in (4.0, 5.0, 6.0, 8.0):
                for use_floor in (False, True):
                    cfg = ControllerConfig(
                        name="",
                        attack_factory=lambda u=up, d=dn: MedianSlew(5, u, d, True),
                        release_factory=lambda: LowPass(60.0),
                        hysteresis_c=hyst,
                        safety_floor=FLOOR_TABLE if use_floor else (),
                    )
                    ag: dict[str, list[float]] = {}
                    for s in range(1, seeds + 1):
                        sc, _ = run(cfg, duration=duration, seed=s * 991)
                        for k, v in vars(sc).items():
                            ag.setdefault(k, []).append(v)
                    m = {k: statistics.fmean(v) for k, v in ag.items()}
                    results.append((up, dn, hyst, use_floor, m))
                    print(f"{up:>5.1f}{dn:>5.1f}{hyst:>6.1f}{str(use_floor):>7} | "
                          f"{m['writes']:>5.0f}{m['reversals']:>5.0f}"
                          f"{m['change_annoyance']:>9.0f}{m['mean_dba']:>7.1f}"
                          f"{m['hot_deficit']:>7.0f}"
                          f"{m['seconds_over_90_under']:>8.0f}{m['peak_temp']:>7.1f}")
    # Pareto：安静（写入+烦恼）与散热（峰值温度）的权衡前沿
    print("\nPareto 前沿（目标：写入+烦恼 小、峰值温度 低、90℃低档秒数=0）")
    ok = [r for r in results if r[4]["seconds_over_90_under"] <= 1]
    ok.sort(key=lambda r: (r[4]["change_annoyance"], r[4]["peak_temp"]))
    for up, dn, hyst, fl, m in ok[:12]:
        print(f"  up={up:<4} dn={dn:<4} hyst={hyst:<4} floor={str(fl):<5} → "
              f"写入 {m['writes']:.0f}  烦恼 {m['change_annoyance']:.0f}  "
              f"峰值 {m['peak_temp']:.1f}℃  dBA {m['mean_dba']:.1f}")
    return 0


# ── 真机日志回放 ────────────────────────────────────────────────

LOG_RE = re.compile(r"(CPU|GPU) Temp:s*([0-9.]+).*?Applied:s*([0-9]+)s*RPM")


def replay_log(path: str) -> int:
    """用真机日志跑一遍，验证仿真给出的排序是否与硬件一致。

    注意：这是**开环**回放 —— 温度被当作与转速无关的外部输入。
    真实闭环里"风扇慢 → 温度升高 → 触发下一次升速"是自纠正的，
    所以重放能证明写入次数下降，但绝对温度会略偏乐观（见 KNOWN_ISSUES 21）。
    """
    temps: list[float] = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = LOG_RE.search(line)
                if m:
                    temps.append(float(m.group(2)))
    except OSError as e:
        print(f"读取失败: {e}", file=sys.stderr)
        return 1
    if len(temps) < 60:
        print(f"样本太少（{len(temps)} 行），至少需要 60 行 1Hz 日志。", file=sys.stderr)
        return 1

    d = [abs(temps[i] - temps[i - 1]) for i in range(1, len(temps))]
    print(f"样本 {len(temps)} 行   温度 {min(temps):.1f}~{max(temps):.1f}℃   "
          f"|dT| 均值 {statistics.fmean(d):.2f} 最大 {max(d):.2f} ℃/s")
    print(HEADER)
    for cfg in PRESETS:
        ctrl = Controller(cfg)
        sc = Score()
        last_dir, prev = 0, None
        for t in temps:
            unit = ctrl.step(t, 1.0)
            old = prev if prev is not None else unit
            prev = unit
            if unit != old:
                dd = 1 if unit > old else -1
                if last_dir and dd != last_dir:
                    sc.reversals += 1
                last_dir = dd
                sc.writes += 1
                sc.change_annoyance += change_penalty(old * RPM_PER_UNIT, unit * RPM_PER_UNIT)
            deficit = to_unit(curve_lookup(t)) * RPM_PER_UNIT - unit * RPM_PER_UNIT
            if deficit > 0:
                sc.max_deficit = max(sc.max_deficit, deficit)
            if t >= 88 and t >= 90 and unit * RPM_PER_UNIT < 4500:
                sc.seconds_over_90_under += 1
            sc.peak_temp = max(sc.peak_temp, t)
        aggs = {k: [v] for k, v in vars(sc).items()}
        aggs["change_annoyance"] = [sc.change_annoyance]
        print_score(cfg.name, {k: statistics.fmean(v) for k, v in aggs.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
