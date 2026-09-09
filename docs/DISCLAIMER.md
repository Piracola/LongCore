# 免责声明（Disclaimer）

## 中文

**请完整阅读后使用。使用本软件即表示您已理解并接受以下条款。**

1. **硬件风险自担。** LongCore 直接向嵌入式控制器（EC）与 ACPI/WMI 层写入数据，用于
   控制风扇转速、功耗墙、温度墙等硬件行为。不正确的设置（例如高温下锁定低转速、
   激进的功耗/电压参数）**可能导致过热、降频、死机，极端情况下可能造成硬件损坏**。
   因使用本软件造成的任何直接或间接损失，作者不承担责任。

2. **非官方产品。** 本项目是 JiaolongControl 的独立社区 fork，与机械革命（MECHREVO）、
   AMD、NVIDIA 无任何隶属或合作关系。"蛟龙"等名称仅用于描述目标硬件。

3. **保修提示。** 修改功耗/电压/风扇行为可能影响厂商保修评估。请在了解您的保修条款后
   自行决定是否使用。

4. **不提供担保。** 本软件按"现状"提供，不附带任何明示或默示的担保（包括但不限于
   适销性与特定用途适用性）。详见 MIT 许可证全文。

5. **第三方二进制。** 软件分发中包含的 `JiaoLongDriver64.*` 与 PawnIO `*.bin`
   为各自权利人的财产，随包分发仅为还原官方控制中心功能。使用前可自行审计。

6. **安全设计有限承诺。** 项目内置了 EC 写入白名单、写入节流、崩溃后风扇自动模式恢复
   等护栏（详见 `docs/` 与源码注释），但这些措施不构成对任何故障后果的保证。

## English (summary)

LongCore writes directly to the embedded controller and ACPI/WMI layer to control fan
speed, power and temperature limits. Incorrect settings can cause overheating, instability
or hardware damage. Use at your own risk — the authors take no responsibility for any
damage. This is an independent community fork, not affiliated with MECHREVO, AMD or NVIDIA.
Provided "as is" without warranty of any kind (MIT license). Modifying hardware behavior
may affect your warranty. Third-party driver binaries remain property of their owners.
