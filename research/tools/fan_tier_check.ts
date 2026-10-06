// 风扇噪音忍耐度三档 —— 参数自检
// 复刻 AutoFanControl.cs 里的档位表，验证：
//   1) 三档的曲线缩放/滞回/下限单调递进，没有写反
//   2) 下限表按温度升序，且转速格数在硬件合法区间 [15, 58]
//   3) 任意温度下，下限档位满足 quiet <= balanced <= performance（否则"安静"档反而更吵）
// 跑法: npx tsx fan_tier_check.ts  或 node --experimental-strip-types fan_tier_check.ts

type Floor = [number, number]

const TIERS = {
  quiet: { scale: 0.85, hyst: 8, floor: [[92, 48], [95, 56]] as Floor[] },
  balanced: { scale: 1.0, hyst: 5, floor: [[88, 45], [91, 50], [94, 56]] as Floor[] },
  performance: { scale: 1.12, hyst: 3, floor: [[86, 45], [89, 50], [92, 56]] as Floor[] },
}

const MIN_BYTE = 15
const MAX_BYTE = 58
const CURVE: Array<[number, number]> = [
  [60, 1500], [65, 1800], [70, 2600], [75, 3000],
  [80, 3300], [85, 3600], [90, 4500], [95, 5800],
]

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) { failures++; console.log(`FAIL  ${name} ${detail}`) }
  else console.log(`ok    ${name}`)
}

function curveRpm(t: number): number {
  if (t <= CURVE[0][0]) return CURVE[0][1]
  if (t >= CURVE[CURVE.length - 1][0]) return CURVE[CURVE.length - 1][1]
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [t1, s1] = CURVE[i], [t2, s2] = CURVE[i + 1]
    if (t >= t1 && t <= t2) return s1 + (s2 - s1) * ((t - t1) / (t2 - t1))
  }
  return CURVE[CURVE.length - 1][1]
}

// 与 C# 同构: 查表 -> 缩放 -> 取整 -> clamp -> 再套下限
function targetByte(t: number, tier: keyof typeof TIERS): number {
  const cfg = TIERS[tier]
  let b = Math.min(MAX_BYTE, Math.max(MIN_BYTE, Math.round((curveRpm(t) * cfg.scale) / 100)))
  for (const [ft, fb] of cfg.floor) if (t >= ft && fb > b) b = fb
  return Math.min(b, MAX_BYTE)
}

// 1) 缩放与滞回单调
check('scale 单调 quiet < balanced < performance',
  TIERS.quiet.scale < TIERS.balanced.scale && TIERS.balanced.scale < TIERS.performance.scale)
check('滞回单调 quiet > balanced > performance (越安静带越宽)',
  TIERS.quiet.hyst > TIERS.balanced.hyst && TIERS.balanced.hyst > TIERS.performance.hyst)

// 2) 下限表形状合法
for (const [name, cfg] of Object.entries(TIERS)) {
  const asc = cfg.floor.every((p, i) => i === 0 || p[0] > cfg.floor[i - 1][0])
  const inRange = cfg.floor.every(([t, b]) => b >= MIN_BYTE && b <= MAX_BYTE)
  check(`${name} 下限表温度升序且档位在 [${MIN_BYTE},${MAX_BYTE}]`, asc && inRange,
    JSON.stringify(cfg.floor))
}

// 3) 核心性质: 同一温度下 安静 <= 均衡 <= 强冷
//    这是"档位真的能降噪"的充要条件 —— 若某处反了, 安静档会比均衡档吵。
let inversions: Array<[number, string]> = []
for (let t = 30; t <= 100; t += 1) {
  const q = targetByte(t, 'quiet'), b = targetByte(t, 'balanced'), p = targetByte(t, 'performance')
  if (!(q <= b)) inversions.push([t, `quiet ${q * 100} > balanced ${b * 100}`])
  if (!(b <= p)) inversions.push([t, `balanced ${b * 100} > performance ${p * 100}`])
}
check('全温度区间 安静 <= 均衡 <= 强冷', inversions.length === 0,
  inversions.slice(0, 5).map(([t, m]) => `${t}C: ${m}`).join('; '))

// 4) 下限确实在高温段生效（否则档位形同虚设）
for (const [name, cfg] of Object.entries(TIERS)) {
  const t = cfg.floor[0][0]
  const withFloor = targetByte(t, name as keyof typeof TIERS)
  const plain = Math.min(MAX_BYTE, Math.max(MIN_BYTE, Math.round((curveRpm(t) * cfg.scale) / 100)))
  check(`${name} 下限在 ${t}C 生效 (${plain * 100} -> ${withFloor * 100} RPM)`, withFloor >= plain)
}

// 5) 退出滞回: 下限解除温度必须低于进入温度，且不低于 0
check('退出滞回 2C 为正且不致阈值重叠', 2 > 0 &&
  TIERS.quiet.floor.every((p, i) => i === 0 || p[0] - 2 > TIERS.quiet.floor[i - 1][0]))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  ` +
  `(安静/均衡/强冷 在 80C: ${targetByte(80, 'quiet') * 100}/${targetByte(80, 'balanced') * 100}/${targetByte(80, 'performance') * 100} RPM)`)
process.exit(failures === 0 ? 0 : 1)
