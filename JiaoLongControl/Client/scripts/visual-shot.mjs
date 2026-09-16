/**
 * Visual QA screenshot harness: mock WebView2 bridge + capture pages.
 * Usage: node scripts/visual-shot.mjs
 */
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.visual-qa')
await mkdir(outDir, { recursive: true })

const mockConfig = {
  Version: 'qa',
  App: {
    BootMinimized: false,
    BootAdvancedFanControlSystem: true,
    BootAdvancedCPUSystem: false,
    BootAdvancedGPUSystem: false,
    BootSetRyzenSumCurveOptimizerAll: true,
    BootKeyboardGradient: false,
    Theme: 'dark',
    SyncWindowsPowerPlan: true,
    HotkeyEnabled: true,
  },
  Cpu: {
    CpuProfile: 'Performance',
    Default: {
      CpuLongPower: 45,
      CpuShortPower: 65,
      CpuTempWall: 95,
      CpuMaxFrequency: 4800,
      CpuTurbo: true,
    },
    Performance: {
      CpuLongPower: 75,
      CpuShortPower: 95,
      CpuTempWall: 95,
      CpuMaxFrequency: 5200,
      CpuTurbo: true,
    },
    Saving: {
      CpuLongPower: 35,
      CpuShortPower: 45,
      CpuTempWall: 85,
      CpuMaxFrequency: 4200,
      CpuTurbo: false,
    },
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
    FanCurveMerge: false,
    ManualFanSpeed: 2800,
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
  'CPU.GetCpuInfo': () => hostOk({ Name: 'AMD Ryzen 9 8945HX', Cores: 16, Threads: 32 }),
  'CPU.GetCPUThermometer': () => hostOk(68),
  'CPU.GetCpuUsage': () => hostOk(32),
  'CPU.GetCpuFrequency': () => hostOk(4200),
  'CPU.GetCpuVoltage': () => hostOk(1.15),
  'CPU.GetCustomMode': () => hostOk(true),
  'RyzenSmu.GetSmuTelemetry': () =>
    hostOk({ Ppt: 42.5, Tdc: 48.2, Edc: 72.1, Temp: 74.5, FreqMhz: 4300, Usage: 28 }),
  'Fan.GetFanSpeed': () => hostOk({ Cpu: 2800, Gpu: 2100, Max: 2800 }),
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
  'Keyboard.GetColor': () => hostOk({ R: 20, G: 180, B: 220 }),
  'Keyboard.SetColor': () => hostOk(null),
  'Keyboard.GetMode': () => hostOk(1),
  'Keyboard.SetMode': () => hostOk(null),
  'Keyboard.GetLightBrightness': () => hostOk(3),
  'Keyboard.SetLightBrightness': () => hostOk(null),
  'KeyboardGradient.IsRunning': () => hostOk(false),
  'KeyboardGradient.Start': () => hostOk(null),
  'KeyboardGradient.Stop': () => hostOk(null),
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
    } catch {}
  }, theme)
}

// Prefer click navigation over re-init for each page
async function gotoPage(n, theme) {
  await forceTheme(theme)
  await page.evaluate(
    ({ n, t }) => {
      localStorage.setItem('jl-ui-page', String(n))
      if (window.__qaConfig?.App) window.__qaConfig.App.Theme = t
      document.documentElement.dataset.theme = t
      if (t === 'dark') document.body.setAttribute('arco-theme', 'dark')
      else document.body.removeAttribute('arco-theme')
    },
    { n, t: theme },
  )
  // click rail button by aria-label
  const labels = {
    1: '主页',
    2: '中央处理器',
    3: '图形处理器',
    4: 'Ryzen SMU',
    5: '风扇曲线',
    6: '风扇',
    7: '键盘',
    8: '设置',
  }
  const btn = page.locator(`button[aria-label="${labels[n]}"]`)
  if (await btn.count()) await btn.first().click()
  await page.waitForTimeout(700)
}

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// Dark theme captures
await page.evaluate(() => {
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.setAttribute('arco-theme', 'dark')
})
await gotoPage(4, 'dark')
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

await gotoPage(8, 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'settings-dark.png') })
console.log('saved settings-dark')

await gotoPage(2, 'dark')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'cpu-dark.png') })
console.log('saved cpu-dark')

// Light theme captures
await page.evaluate(() => {
  document.documentElement.dataset.theme = 'light'
  document.documentElement.setAttribute('arco-theme', 'light')
  document.body.removeAttribute('arco-theme')
})
await gotoPage(4, 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'smu-light.png') })
console.log('saved smu-light')

await gotoPage(8, 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'settings-light.png') })
console.log('saved settings-light')

await gotoPage(2, 'light')
await page.mouse.move(400, 400)
await page.screenshot({ path: path.join(outDir, 'cpu-light.png') })
console.log('saved cpu-light')

await browser.close()
await server.close()
console.log('done →', outDir)
