<h1 align="center">LongCore</h1>

<p align="center">
  <strong>Hardware Control Center for the MECHREVO Jiaolong 16 Pro (2023)</strong><br>
  <em>Independent fork of JiaolongControl — UI redesigned, hardened, re-versioned at 0.1.0</em>
</p>

<p align="center">
  <img src="Doc/Main.png" alt="Main window" width="800" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/.NET-10.0-512BD4?logo=dotnet" alt=".NET">
  <img src="https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs" alt="Vue">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

LongCore is a Windows desktop control center (WPF + WebView2 + Vue 3) for laptops of the
MECHREVO Jiaolong (Ryzen 7945HX + RTX 4060) family. It talks to the embedded controller (EC)
and ACPI/WMI layer directly, and adds safety guardrails on top of what the stock console offers.

> **This is an independent fork.** It is not affiliated with or endorsed by MECHREVO.
> Versioning restarts at 0.1.0 and does not follow the upstream 10.x line.
> 中文说明见 [README.md](README.md) · 机型声明 [SUPPORTED_HARDWARE.md](docs/SUPPORTED_HARDWARE.md) ·
> 免责声明 [DISCLAIMER.md](docs/DISCLAIMER.md) · 已知问题 [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)

## Features

### CPU
- Power limits — SPL / SPPT, AC/DC split, max frequency, turbo toggle
- Temperature wall — 60 °C to 105 °C
- Ryzen SMU: Curve Optimizer (all-core / per-core), PBO scalar, clocks & voltage

### GPU
- NVIDIA overclock (core/memory offset) via NVAPI
- Discrete-only / Hybrid graphics mode switching (requires reboot)

### Fan
- Custom fan curves (separate CPU/GPU or merged), unit = 100 RPM per step
- Smart auto-fan with cross-cooling algorithm, ramp-rate limiting and hysteresis
- **EC write guardrails** — address whitelist, redundant-write throttling, and a
  crash watchdog that restores automatic fan control after an abnormal exit

### Performance modes & hotkeys
- Four-state pill switch: Performance / Balance / Quiet / Custom (custom SPL/SPPT overlay)
- Windows power plan follows the selected mode (configurable, via `powercfg`)
- **Fn hotkey takeover** — the chassis performance key cycles modes and shows an on-screen
  display; other Fn keys keep firmware default behavior (configurable)

### UI
- Redesigned single-line status banner with inline mode pills (background video removed)
- Temperature semantic color scale: ≤70 °C blue → 70–80 °C cyan → 80–90 °C orange → >90 °C red
- Lucide line-icon set, design tokens, dark/light themes synchronized into Arco Design

## Supported hardware

| Component | Tested |
|---|---|
| Model | MECHREVO Jiaolong 16 Pro 2023 (MRID6), BIOS MRID6_23_V33 |
| CPU | AMD Ryzen 9 7945HX |
| GPU | NVIDIA RTX 4060 (laptop) |
| EC | Chip ID 0x55 family, index protocol at ports 0x4E/0x4F |

Other Jiaolong 16 Pro [2023] variants are *expected* to work but are untested.
The WMI interface is model-specific (`MICommonInterface.InstanceName='ACPI\PNP0C14\MIFS_0'`);
on unsupported machines the app starts with monitoring degraded and hardware writes disabled.
See [SUPPORTED_HARDWARE.md](docs/SUPPORTED_HARDWARE.md) before use.

## Build from source

Prerequisites: .NET 10 SDK (Windows), Node.js 24.15+ (see Client/.nvmrc), Windows x64. Administrator is required at runtime.

```bat
:: Frontend (vue-tsc + vite) — outputs to bin\publish\WebRoot
cd JiaoLongControl\Client && npm ci && npm run build

:: Backend
cd ..\..
dotnet build JiaoLongControl\JiaoLongControl.csproj -c Release

:: Protocol regression tests (golden samples captured from real hardware)
dotnet run --project ProtocolCodecTest\ProtocolCodecTest.csproj -c Release
```

CI runs the same checks on GitHub Actions (`.github/workflows/ci.yml`).

> **Run frontend commands from `JiaoLongControl/Client`** — the repo root has no `package.json`.
> Full development conventions: [AGENTS.md](AGENTS.md).

### Repository layout

This is a **single git root** holding both the app and the research layer:

| Path | Contents |
|---|---|
| `JiaoLongControl/Client/` | Vue 3 frontend (Vite + Arco + ECharts + Pinia) |
| `JiaoLongControl/Server/` | .NET WPF host (WebView2 bridge / WMI / EC / SMU) |
| `installer/` | Inno Setup packaging scripts |
| [`research/`](research/README.md) | **Protocol research layer**: reverse-engineering, hardware probe data, upstream audit, decision records |

The research layer was formerly a separate repository; it was merged here in 2026-09 with **full history preserved**.

## Installer

```bat
:: Requires Inno Setup 6 (iscc on PATH)
installer\build-installer.cmd
:: → installer\Output\LongCore-0.1.0-setup.exe
```

## Architecture notes

- **Frontend** Vue 3 + Arco Design + Tailwind 4 + ECharts, loaded into WebView2 from `WebRoot/`
- **Bridge** COM-visible controllers exposed to JS via `window.chrome.webview.hostObjects.bridge`
- **Protocol** `MICommonInterface` WMI method (32-byte request frames, 30-byte responses with
  `00 80` header and command-code echo — validated on every call, one retry on mismatch)
- **EC access** signed vendor driver (`JiaoLongDriver64.sys`) for fan control;
  PawnIO-signed blobs for AMD SMU / NVIDIA telemetry
- **Docs** reverse-engineering notes and the full WMI protocol live in [../docs](../docs) (Chinese)

## License

MIT — inherited from upstream. Vendor driver binaries (`JiaoLongDriver64.*`, PawnIO `*.bin`)
remain the property of their respective owners; see `Drivers/PawnIO/PawnIO.LICENSE.txt`.
