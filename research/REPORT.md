# 机械革命蛟龙 16 Pro 控制中心 —— 逆向分析报告

> 目标文件：`蛟龙游戏控制中心Setup.exe`（90,956,224 字节）
> 结论：**可行，而且比预想简单 —— 硬件控制走标准 ACPI WMI，不需要内核驱动。**

---

## 一、安装包容器破解

| 项目 | 结果 |
|---|---|
| 打包方式 | Inno Setup **6.3.0**（32 位 PE stub，11 个节区，PE 主体止于 `0xCE800`） |
| 现成工具 | `innoextract 1.9` **不支持** 6.3.0（报 `Unexpected setup data version`），无可用新版构建 |
| 自研解包 | PE 之后是单条 **LZMA1 裸流**：props=`0x5D`(lc3/lp0/pb2)、dict=8MB、数据起始 `+9` |
| 压缩率 | 89,113,491 → **170,816,676** 字节明文 |
| 明文结构 | **371 个 PE 文件首尾相接**（用 DOS stub 特征串可精确定位每个起点） |
| 文件命名 | Inno 头区在 `0x55CAFEC`，仍为加密/未知压缩（**未破解**）；但改用 **PE 版本资源**（OriginalFilename / FileDescription）成功还原了全部文件名 |

产物：`extract/setup_stream.bin`（170MB 明文流）、`extract/files/`（371 个已命名文件）、`extract/files/_index.json`（索引）。
工具脚本在 `tools/`：`decompress_stream.py`、`carve2.py`、`api_dump.py`。

---

## 二、软件组成

- **GamingControlCenter** v0.3.15.0 —— .NET 6 WPF 应用（MaterialDesignThemes），主程序集
- 签名者：**Shenzhen Bitland Information Technology Co., Ltd.**（深圳比特兰德，ODM/方案商）
- `NvAPIWrapper.dll` —— NVIDIA GPU 控制封装
- `BLDFnHotkeyUtility.exe` / `BLDHotKeyService.exe` —— 热键工具与服务
- 随包携带 `windowsdesktop-runtime-6.0.5-win-x64.exe`、完整 PowerShell SDK 与 `Microsoft.Management.Infrastructure`
- `蛟龙游戏控制中心.dll`（首页那个 64 位）实为 .NET **apphost 启动器**，不是硬件库

---

## 三、硬件 API 面（核心结论）

### 3.1 主通道：ACPI WMI，无驱动

```
命名空间 : root\WMI
类       : MICommonInterface
实例名   : ACPI\PNP0C14\MIFS_0        ← PNP0C14 = ACPI WMI 设备
调用方式 : ManagementObject.InvokeMethod() + GetMethodParameters()
            （代码内可见 `SetMethod inparms:`、`ExcMethod` 包装）
```

热键/快捷键走 **WMI 事件**：

```
事件类 : HID_EVENT20        (SELECT * FROM HID_EVENT20)
       : OSDEvents
字段   : EventDetail        （日志串 `wMIEventName:` / `eVENTvalue:`）
机制   : ManagementEventWatcher + EventArrived
```

### 3.2 已识别的能力域

| 能力 | 代码内标识 |
|---|---|
| 性能模式 | `AirPlaneMode` / `BalanceMode` / `CustomMode` / `DiscreteMode`（独显直连）/ `HybridMode` / `FastestMode` / `SetAP_PerformaceMode` |
| 风扇 | `CPUFanSpeed` / `MaxFanSpeedButton` / `FanSpeedAdd|Sub` / `Set_FanSpeed` |
| 功耗与温度 | `SPLSlider` / `SPPTSlider` / `CPUTempWallSlider` / `Set_CPUTempWall` / `GetCPUTemp` |
| GPU 超频 | `GPUCoreClockSlider` / `ClockDomainInfo` / `IClockFrequencies` / `GPUClockService` |
| 键盘灯效 | `SetSP_KeyboardColor` / `SetSP_KeyboardLightBrightness` / `SetSP_Ambientlight` / `KeyBoardColorComBox` |
| 开关位 | `FnLock` / `NumLock` / `CapsLock` / `TPMode`（触控板）/ `SetSP_GraphicsDirect` |
| GPU 状态 | `GetPstatesLevel0Settings` / `ChangePstatesLevel0Settings`（P-states） |
| 硬件监控 | `Win32_Processor` / `Win32_VideoController` / `Win32_PhysicalMemory` / `Win32_DiskDrive` / `Win32_NetworkAdapter` / `Win32_PerfFormattedData_PerfOS_Processor` |

> 注：`#FFDAECFC`、`#FFDCECFC` 是 WPF 的 ARGB 颜色常量，**不是** EC 端口码 —— 本套件未发现直接的 EC I/O（WinRing0 / inpoutx64）调用。

---

## 四、可行性判断

**可以做，且成本低。** 关键在于：硬件访问全部在**用户态 WMI**，第三方工具无需自研驱动、无需逆向 IOCTL。

需要注意：

1. 静态分析只能给出**调用点**，方法名与参数语义（数值含义、取值范围）必须在真机上枚举确认。
2. `root\WMI:MICommonInterface` 的方法定义在 **ACPI SSDT / MOF** 里，随 BIOS 变化，**不同批次可能不同**。
3. 写操作（`InvokeMethod` 的 Set 分支）应先做只读枚举，避免写入非法值。

---

## 五、建议路线

1. **真机导出接口定义**（一台蛟龙 16 Pro，管理员权限）：
   ```powershell
   Get-CimClass -Namespace root\WMI -ClassName 'MICommonInterface' |
     Select-Object -ExpandProperty CimClassMethods |
     Format-List Name, Parameters
   ```
   同时用 `Get-CimInstance -Namespace root\WMI -ClassName MICommonInterface` 取实例名。
2. **抓热键事件**：订阅 `SELECT * FROM HID_EVENT20`，按 Fn+组合键记录 `EventDetail` 原始值。
3. **反编译主程序集**（最快路径）：用 ILSpy / dnSpy 打开 `GamingControlCenter`，读 `BLD.WMIOperation` 下 `ExcMethod` 的调用点，即可得到「每个按钮 ↔ WMI 方法名 + 参数」的完整映射。
4. **建映射表 + 开源实现**：C#/Rust/Python 均可，纯 `System.Management` 调用即可，无需驱动。
5. **多机型适配**：把接口定义按 BIOS 版本/机型做成 profile 表。

---

## 六、合规提示

- 逆向用于**互操作**通常属合法范畴，但**不要**在开源项目中再分发厂商的二进制、证书或资源（字体、图片）。
- 接口名称、调用序列属于事实信息；建议在仓库中以文档形式记录，代码里只保留自研实现。
