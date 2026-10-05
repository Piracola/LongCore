/**
 * Visual QA screenshot harness: mock WebView2 bridge + capture pages.
 * Usage: node scripts/visual-shot.mjs
 */
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 可选参数(不传时行为与旧版完全一致):
//   --out=<dir>    输出目录, 相对 Client/(默认 .visual-qa)
const argv = process.argv.slice(2)
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const outDir = path.join(root, argValue('out') ?? '.visual-qa')
await mkdir(outDir, { recursive: true })

const mockConfig = {
  Version: 'qa',
  App: {
    BootMinimized: false,
    BootAdvancedFanControlSystem: true,
    BootAdvancedCPUSystem: false,
    BootAdvancedGPUSystem: false,
    BootSetRyzenSumCurveOptimizerAll: true,
    Theme: 'dark',
    SyncWindowsPowerPlan: true,
    HotkeyEnabled: true,
  },
  // 只有一份 CPU 参数（原「均衡/性能/节能/自定义」四方案表已废除，见 types/config.ts CpuSectionType）
  Cpu: {
    Custom: {
      CpuLongPower: 55,
      CpuShortPower: 80,
      CpuTempWall: 90,
      CpuMaxFrequency: 5000,
      CpuTurbo: true,
    },
  },
  Gpu: {
    GpuClock: 1800,
    MemoryClock: 8000,
    PowerLimit: 140,
    CoreClockOffset: 0,
    MemoryClockOffset: 0,
    VoltageBoostPercent: 0,
  },
  Fan: {
    Enabled: false,
    FanCurveMerge: true,
    TempAttackS: 5,
    TempReleaseS: 60,
    TempHysteresisC: 5,
    CpuFanCurve: [
      { temp: 40, speed: 1800 },
      { temp: 60, speed: 2800 },
      { temp: 80, speed: 4200 },
      { temp: 90, speed: 5200 },
    ],
    GpuFanCurve: [
      { temp: 40, speed: 1600 },
      { temp: 70, speed: 3200 },
      { temp: 85, speed: 4800 },
    ],
  },
  Log: {
    Level: 'INFO',
    CommandDebug: false,
    FlushIntervalS: 2,
  },
  Smu: {
    StapmLimit: 54,
    StapmTime: 300,
    FastLimit: 65,
    SlowLimit: 60,
    SlowTime: 300,
    PptLimitRsmu: 54,
    VrmCurrentMp1: 90000,
    VrmCurrentRsmu: 90000,
    TdcLimitMp1: 75000,
    TdcLimitRsmu: 75000,
    EdcLimitMp1: 120000,
    EdcLimitRsmu: 120000,
    TempLimitMp1: 95,
    TempLimitRsmu: 95,
    PboScalar: 5,
    OcClk: 0,
    OcVolt: 1000,
    CurveOptimizerAll: -15,
    // 逐核只记录、开机不下发：这里放几个非 0 值，用来验证重启后表单确实被填回
    PerCoreCurve: [-15, -12, -10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    PerCoreOcClk: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
}

const bridgeScript = `
function hostOk(data) {
  return {
    toJson: () => JSON.stringify({ Success: true, Message: 'ok', Data: data === undefined ? null : data }),
  };
}
const config = ${JSON.stringify(mockConfig)};
window.__qaConfig = config;
const handlers = {
  'ConfigCtrl.GetConfig': () => hostOk(window.__qaConfig),
  'ConfigCtrl.SetConfig': () => hostOk(null),
  'CPU.GetPhysicalCoreCount': () => hostOk(16),
  'CPU.GetCpuInfo': () =>
    hostOk({ Name: 'AMD Ryzen 9 8945HX', Cores: 16, Threads: 32, BaseFreqMhz: 2500 }),
  'CPU.GetCPUThermometer': () => hostOk(68),
  'CPU.GetCpuUsage': () => hostOk(32),
  'CPU.GetCpuFrequency': () => hostOk(4200),
  'CPU.GetCpuVoltage': () => hostOk(1.15),
  'CPU.GetCustomMode': () => hostOk(true),
  'RyzenSmu.GetSmuTelemetry': () =>
    hostOk({ Ppt: 42.5, Tdc: 48.2, Edc: 72.1, Temp: 74.5, FreqMhz: 4300, Usage: 28 }),
  'Fan.GetFanSpeed': () => hostOk({ CPUFanSpeed: 2800, GPUFanSpeed: 2100 }),
  'NvidiaGpu.GetGpuName': () => hostOk('RTX 4070'),
  'NvidiaGpu.GetGpuDriverVersion': () => hostOk('560.00'),
  'NvidiaGpu.GetGpuDriverDate': () => hostOk('2026-01-01'),
  'NvidiaGpu.GetGpuMemoryTotal': () => hostOk('8 GB'),
  'NvidiaGpu.GetGpuBusWidth': () => hostOk('128-bit'),
  'NvidiaGpu.GetGpuUtilization': () => hostOk(18),
  'NvidiaGpu.GetGpuMemoryUtilization': () => hostOk(22),
  'NvidiaGpu.GetGpuCoreClock': () => hostOk(1800),
  'NvidiaGpu.GetGpuMemoryClock': () => hostOk(8000),
  'NvidiaGpu.GetGpuFanSpeed': () => hostOk(2100),
  'NvidiaGpu.GetGpuTemperature': () => hostOk(62),
  // 契约（v4 §14.11）：AutoFan.IsRunning 必须 Success:true + Data=<bool>（见下方 Object.assign 处的说明）
  'AutoFan.IsRunning': () => hostOk(false),
  'AutoFan.Start': () => hostOk(null),
  'AutoFan.Stop': () => hostOk(null),
  'PerformanceMode.Get': () => hostOk(2),
  'PerformanceMode.Set': () => hostOk(null),
  'SystemInfo.GetSystemOverview': () =>
    hostOk({
      CpuTemp: 68,
      GpuTemp: 62,
      CpuUsage: 32,
      GpuUsage: 18,
      FanSpeed: 2800,
      CpuName: 'AMD Ryzen 9 8945HX',
      GpuName: 'RTX 4070',
    }),
  'LogoLight.Get': () => hostOk('Open'),
  'LogoLight.Set': () => hostOk(null),
  'AutoStart.IsEnabled': () => hostOk(true),
  'AutoStart.Enable': () => hostOk(null),
  'AutoStart.Disable': () => hostOk(null),
  'NvidiaGpu.GetGpuName': () => hostOk('RTX 4070'),
  'NvidiaGpu.GetGpuDriverVersion': () => hostOk('560.70'),
  'NvidiaGpu.GetGpuDriverDate': () => hostOk('2025-01-01'),
  'NvidiaGpu.GetGpuMemoryTotal': () => hostOk('8192 MB'),
  'NvidiaGpu.GetGpuBusWidth': () => hostOk('128 bit'),
  'NvidiaGpu.GetGpuUtilization': () => hostOk(18),
  'NvidiaGpu.GetGpuMemoryUtilization': () => hostOk(22),
  'NvidiaGpu.GetGpuCoreClock': () => hostOk(2100),
  'NvidiaGpu.GetGpuMemoryClock': () => hostOk(8000),
  'NvidiaGpu.GetGpuTemperature': () => hostOk(62),
  'NvidiaGpu.GetGpuFanSpeed': () => hostOk(2100),
  'NvidiaGpu.GetGpuCoreClockRange': () => hostOk({ Min: 900, Max: 2500 }),
  'NvidiaGpu.GetGpuMemoryClockRange': () => hostOk({ Min: 4000, Max: 10000 }),
  'NvidiaGpu.GetGpuPowerLimitRange': () => hostOk({ Min: 80, Max: 160 }),
  'NvidiaGpu.GetClockOffsetRange': () => hostOk({ Core: { Min: -200, Max: 300 }, Memory: { Min: -500, Max: 1500 } }),
  'NvidiaGpu.GetClockOffsets': () => hostOk({ Core: 0, Memory: 0 }),
  'NvidiaGpu.GetVoltageBoostPercent': () => hostOk(0),
  'Power.GetCPUMaxFrequency': () => hostOk({ ac: 5200, dc: 5200 }),
  'Power.GetTurboEnabled': () => hostOk({ ac: true, dc: true }),
};

/* ---- 已应用功能看板（概览页）用到的回读 getter 与移除方法 ----
 * makeNs 的 fallback 会把**未登记**的方法当成功返回（假绿），所以看板用到的
 * 每一个方法都必须在这里显式登记，否则截图里的看板全是"绿的"。
 * 反向验证：--fail-readback=<rawNamespace.Method>（如 AutoFan.IsRunning）
 * 让指定 getter 失败 —— 看板必须显示「读取失败」，移除必须报失败，绝不显示「已移除」。
 */
window.__qaFailReadback = ${JSON.stringify(argValue('fail-readback'))};
function qaRead(key, value) {
  if (window.__qaFailReadback === key) {
    return { toJson: () => JSON.stringify({ Success: false, Message: '注入的读取失败', Data: null }) };
  }
  return hostOk(value);
}
Object.assign(handlers, {
  // 回读 getter（raw.* 命名空间，与 bridge.ts 的包装层调用一致）
  'CPU.GetCustomMode': () => qaRead('CPU.GetCustomMode', true),
  'Power.GetCPUMaxFrequency': () => qaRead('Power.GetCPUMaxFrequency', { ac: 5400, dc: 5400 }),
  // mockConfig 的 CpuTurbo=true，这里故意回读 false → 看板演示「配置开着、硬件没写进去」
  'Power.GetTurboEnabled': () => qaRead('Power.GetTurboEnabled', { ac: false, dc: false }),
  // AutoFan.IsRunning：**必须** Success:true + Data=<bool>，与后端契约一致（v4 §14.11）。
  // 后端 2026-10-06 之前把运行态塞进 Success（没在跑 = Success:false + Data:false），
  // 而这里的 mock 恒返回 Success:true —— mock 与真机不一致，看板 fan.curve 的用例在真机上
  // 根本不可达却一直是绿的（假绿现场）。改的是后端（IsRunning 恒 true），mock 侧不要反过来写。
  'AutoFan.IsRunning': () => qaRead('AutoFan.IsRunning', false),
  'LogoLight.Get': () => qaRead('LogoLight.Get', 1),
  'AutoStart.IsEnabled': () => qaRead('AutoStart.IsEnabled', true),
  'PerformanceMode.Get': () => qaRead('PerformanceMode.Get', 2),
  'GPU.Get': () => qaRead('GPU.Get', 0),
  'NvidiaGpu.GetClockOffsets': () => qaRead('NvidiaGpu.GetClockOffsets', { CoreMhz: 0, MemoryMhz: 0 }),
  'NvidiaGpu.GetVoltageBoostPercent': () => qaRead('NvidiaGpu.GetVoltageBoostPercent', 0),
  'NvidiaGpu.GetGpuPowerPolicy': () =>
    qaRead('NvidiaGpu.GetGpuPowerPolicy', {
      CurrentWatts: 140,
      MinWatts: 80,
      DefaultWatts: 140,
      MaxWatts: 160,
    }),
  // 看板「移除」会用到的写入方法
  'CPU.SetCustomMode': () => hostOk(null),
  'Power.ResetCPUMaxFrequency': () => hostOk(null),
  'Power.EnableTurbo': () => hostOk(null),
  'Fan.RemoveFanSpeed': () => hostOk(null),
  'LogoLight.Set': () => hostOk(null),
  'AutoStart.Disable': () => hostOk(null),
  'NvidiaGpu.ResetClockOffsets': () => hostOk(null),
  'NvidiaGpu.SetVoltageBoostPercent': () => hostOk(null),
  'GPU.Set': () => hostOk(null),
});

function makeNs(pathParts) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then') return undefined;
        const key = [...pathParts, prop].join('.');
        return (...args) => {
          if (handlers[key]) return handlers[key](...args);
          return hostOk(true);
        };
      },
    },
  );
}

const rootBridge = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      if (handlers[prop]) return handlers[prop];
      return makeNs([prop]);
    },
  },
);

window.chrome = {
  webview: {
    hostObjects: { bridge: rootBridge },
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  },
};
`

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  // mode 非 development: 关掉 vite-plugin-vue-devtools 浮层, 否则它会出现在截图里
  mode: 'test',
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error',
})
await server.listen()
const url = 'http://127.0.0.1:5199/'

const browser = await chromium.launch({
  headless: true,
  executablePath: edgePath,
  args: ['--disable-gpu'],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
})
await context.addInitScript(bridgeScript)
const page = await context.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

async function forceTheme(theme) {
  await page.evaluate((t) => {
    if (window.__qaConfig?.App) window.__qaConfig.App.Theme = t
    document.documentElement.dataset.theme = t
    if (t === 'dark') document.body.setAttribute('arco-theme', 'dark')
    else document.body.removeAttribute('arco-theme')
    try {
      localStorage.setItem('jl-theme', t)
    } catch {
      // localStorage 在隐私模式/受限上下文可能抛错, 忽略即可
    }
  }, theme)
}

// Prefer click navigation over re-init for each page
async function gotoPage(id, theme) {
  await forceTheme(theme)
  await page.evaluate(
    ({ id, t }) => {
      localStorage.setItem('jl-ui-page', id)
      if (window.__qaConfig?.App) window.__qaConfig.App.Theme = t
      document.documentElement.dataset.theme = t
      if (t === 'dark') document.body.setAttribute('arco-theme', 'dark')
      else document.body.removeAttribute('arco-theme')
    },
    { id, t: theme },
  )
  const labels = {
    home: '概览',
    cpu: 'CPU',
    gpu: 'GPU',
    smu: 'SMU',
    'fan-curve': '风扇曲线',
    settings: '系统',
  }
  const btn = page.locator(`button[aria-label="${labels[id]}"]`)
  if (await btn.count()) await btn.first().click()
  await page.waitForTimeout(700)
}

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// 侧栏项数：2026-10-06 删掉「风扇」页与整个「灯效」页后应为 6（截图不能自证项数，这里直接数 DOM）
const navCount = await page.locator('aside[aria-label="主导航"] button.rail-btn').count()
console.log(`nav items: ${navCount}`)
if (navCount !== 6) throw new Error(`侧栏项数应为 6，实际 ${navCount}`)

// Dark theme captures
await page.evaluate(() => {
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.setAttribute('arco-theme', 'dark')
})
await gotoPage('home', 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'home-dark.png') })
console.log('saved home-dark')

// 已应用功能看板在概览页下半页：滚到底再拍一张，确认表体（意图/实测/无法还原）逐行渲染
await page.evaluate(() => {
  const el = document.querySelector('.no-scrollbar.overflow-y-auto') || document.scrollingElement
  if (el) el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'home-dark-bottom.png') })
console.log('saved home-dark-bottom')

await gotoPage('smu', 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'smu-dark.png') })
console.log('saved smu-dark')
await page.evaluate(() => {
  const el = document.querySelector('.no-scrollbar.overflow-y-auto') || document.scrollingElement
  if (el) el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'smu-dark-bottom.png') })
console.log('saved smu-dark-bottom')

await gotoPage('settings', 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'settings-dark.png') })
console.log('saved settings-dark')

await gotoPage('cpu', 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'cpu-dark.png') })
console.log('saved cpu-dark')

for (const id of ['gpu', 'fan-curve']) {
  await gotoPage(id, 'dark')
  await page.mouse.move(400, 400)
  await page.screenshot({ path: path.join(outDir, `${id}-dark.png`) })
  console.log(`saved ${id}-dark`)
}

// Light theme captures
await page.evaluate(() => {
  document.documentElement.dataset.theme = 'light'
  document.documentElement.setAttribute('arco-theme', 'light')
  document.body.removeAttribute('arco-theme')
})
await gotoPage('smu', 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'smu-light.png') })
console.log('saved smu-light')

await gotoPage('settings', 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'settings-light.png') })
console.log('saved settings-light')

await gotoPage('cpu', 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'cpu-light.png') })
console.log('saved cpu-light')

await browser.close()
await server.close()

// 旁挂元数据: docs/证据清单.md 要求截图的来源 = 提交号 + 主题 + 视口 + DPR + 工具版本,
// 缺任一项即不可用作证据。缺这个文件, 出的图就还是 "provenance unknown"。
function gitHead() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
  } catch {
    // 无 git 或受限环境: 不阻塞出图, 但必须显式标记为不可自证
    return 'unknown'
  }
}

function gitDirty() {
  try {
    return execSync('git status --porcelain', { cwd: root }).toString().trim().length > 0
  } catch {
    return null
  }
}

const manifest = {
  commit: gitHead(),
  // 脏树出图时 commit 不足以定位代码状态，必须显式标出来
  dirty: gitDirty(),
  outDir: path.relative(root, outDir).replaceAll('\\', '/'),
  themes: ['dark', 'light'],
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  browser: edgePath ?? 'unknown',
  capturedAt: new Date().toISOString(),
  tool: 'scripts/visual-shot.mjs',
  bridge: 'mocked (window.chrome.webview.hostObjects.bridge)',
  caveat: '静态呈现: 不含真实硬件状态、部分失败、键盘焦点、轮询稳定性',
}
await writeFile(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log('done →', outDir)
