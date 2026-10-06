import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseScript } from '@babel/parser'
import { describe, expect, it } from 'vitest'

/**
 * 闸门：页面组件的 <script setup> 里不得有顶层 await（2026-10-06「切页卡顿」根因）。
 *
 * 一旦顶层 await 回来，页面即成为 Vue 的 async setup 组件，App.vue 的 <Suspense>
 * 必须等它全部 resolve 才挂载新页 —— 功能完全正常，只是又卡了，人工复审极难发现，
 * 所以只能靠自动化守住。
 *
 * 为什么必须走 AST：本仓库大量注释里写着「顶层 await」这五个字
 * （GPU.vue / CPU.vue / RyzenSmu.vue / docs/KNOWN_ISSUES.md），任何文本扫描都会误报，
 * 且注释文案会随文档演进漂移。AST 天然区分两件事：
 *   - `await load()` 直接落在 Program.body        → 违规
 *   - `void (async () => { await load() })()`     → 在 FunctionExpression 体内，合法
 *
 * 依赖说明：@vue/compiler-sfc 与 @babel/parser 都是既有传递依赖（vue 编译链），不新增依赖。
 */

/**
 * vitest 下 import.meta.url 不是 file: URL（transform 后被改写），fileURLToPath 会抛
 * "The URL must be of scheme file"，所以从 cwd 往上找带 src/pages 的那层，避开该坑。
 */
const resolvePagesDir = (): string => {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'src', 'pages')
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), 'src', 'pages')
}

const PAGES_DIR = resolvePagesDir()

/** 递归扫目录，不硬编码文件名 —— 新增页面自动纳入检查。 */
const listVueFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return listVueFiles(full)
      return entry.isFile() && entry.name.endsWith('.vue') ? [full] : []
    })
    .sort()

/** 只够用的一次性节点视图：babel 的节点类型不逐字段展开，只看 type/start/end/子节点。 */
interface AstNode {
  type: string
  start: number | null
  end: number | null
  [key: string]: unknown
}

const asNode = (value: unknown): AstNode | null => {
  if (typeof value !== 'object' || value === null) return null
  return typeof (value as { type?: unknown }).type === 'string' ? (value as AstNode) : null
}

/** 函数边界：进了函数体，await 就不再是顶层 await（哪怕函数体本身就是 async）。 */
const FUNCTION_BOUNDARIES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
])

/** 这些键挂在节点上但不是子节点，遍历时跳过。 */
const NON_CHILD_KEYS = new Set(['extra', 'loc', 'errors', 'comments', 'tokens'])

interface AwaitSite {
  node: AstNode
  reason: string
}

/** 从 Program.body 往下走，撞到函数边界就停；返回所有顶层 await。 */
const findTopLevelAwaits = (body: readonly unknown[]): AwaitSite[] => {
  const found: AwaitSite[] = []
  const visit = (node: AstNode): void => {
    if (node.type === 'AwaitExpression') found.push({ node, reason: 'AwaitExpression' })
    // for await (...) 在 AST 里是 ForOfStatement.await=true，没有 AwaitExpression 节点，
    // 只查 AwaitExpression 会漏掉它 —— 而它同样让 setup 变成异步。
    if (node.type === 'ForOfStatement' && node.await === true)
      found.push({ node, reason: 'for await (...)' })
    if (FUNCTION_BOUNDARIES.has(node.type)) return
    for (const key of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const item of value) {
          const child = asNode(item)
          if (child) visit(child)
        }
      } else {
        const child = asNode(value)
        if (child) visit(child)
      }
    }
  }
  for (const statement of body) {
    const node = asNode(statement)
    if (node) visit(node)
  }
  return found
}

const offsetToPosition = (source: string, offset: number): { line: number; column: number } => {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

const shortCode = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat
}

interface Violation {
  file: string
  line: number
  column: number
  reason: string
  code: string
}

interface InspectResult {
  /** 参与检查的页面（真正含 <script setup> 的）。 */
  checked: string[]
  violations: Violation[]
  /** SFC 层或 setup 源码解析失败 —— 会让本闸门变成瞎子，必须当失败报出来。 */
  issues: string[]
}

const inspectPage = (file: string): InspectResult => {
  const displayPath = relative(PAGES_DIR, file).split(sep).join('/')
  const source = readFileSync(file, 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: file })
  const issues = errors.map((err) => `${displayPath}: SFC 解析报错 ${String(err.message ?? err)}`)
  const setup = descriptor.scriptSetup
  // 没有 <script setup> 的页面不是 async setup 组件，与本闸门无关。
  if (!setup) return { checked: [], violations: [], issues }
  if (!setup.loc) {
    issues.push(`${displayPath}: <script setup> 缺少 loc，无法定位行号`)
    return { checked: [displayPath], violations: [], issues }
  }

  let program: ReturnType<typeof parseScript>
  try {
    program = parseScript(setup.content, { sourceType: 'module', plugins: ['typescript'] })
  } catch (err) {
    issues.push(
      `${displayPath}: <script setup> 无法解析为 AST（${err instanceof Error ? err.message : String(err)}）`,
    )
    return { checked: [displayPath], violations: [], issues }
  }

  const violations = findTopLevelAwaits(program.program.body).map(({ node, reason }) => {
    const start = node.start ?? 0
    const end = node.end ?? start
    const { line, column } = offsetToPosition(source, setup.loc.start.offset + start)
    return {
      file: displayPath,
      line,
      column,
      reason,
      code: shortCode(setup.content.slice(start, end)),
    }
  })

  return { checked: [displayPath], violations, issues }
}

const pagesUnderTest = (): { files: string[]; all: InspectResult[] } => {
  const files = listVueFiles(PAGES_DIR)
  return { files, all: files.map(inspectPage) }
}

const formatViolations = (violations: Violation[]): string =>
  violations.map((v) => `  ${v.file}:${v.line}:${v.column}  ${v.reason} → ${v.code}`).join('\n')

describe('页面组件顶层 await 闸门（2026-10-06 切页卡顿）', () => {
  it('src/pages 下每个页面的 <script setup> 顶层都没有 await', () => {
    const { files, all } = pagesUnderTest()

    // 路径写错 / 目录改名时这里会先炸，避免 0 个文件 → 0 条断言 → 永远绿。
    expect(existsSync(PAGES_DIR)).toBe(true)
    expect(files.length).toBeGreaterThan(0)

    const checked = all.flatMap((result) => result.checked)
    expect(checked.length).toBeGreaterThan(0)

    const violations = all.flatMap((result) => result.violations)
    expect(
      violations,
      violations.length === 0
        ? '页面 <script setup> 里没有顶层 await（<Suspense> 可立即挂载新页）'
        : [
            '发现顶层 await：这些页面会成为 async setup 组件，',
            'App.vue 的 <Suspense> 必须等它们全部 resolve 才挂载新页（切页卡顿回归）。',
            '改成 `void (async () => { ... })()` 后台补齐，或把 await 挪进具名函数体。',
            '',
            formatViolations(violations),
          ].join('\n'),
    ).toEqual([])
  })

  it('页面 SFC 与 setup 源码全部可解析（解析失败等于闸门失明，必须暴露）', () => {
    const { all } = pagesUnderTest()
    const issues = all.flatMap((result) => result.issues)
    expect(
      issues,
      issues.length === 0
        ? '全部页面的 SFC 与 <script setup> 均可解析'
        : ['出现解析失败，本闸门无法检查这些页面：', ...issues.map((line) => `  ${line}`)].join(
            '\n',
          ),
    ).toEqual([])
  })

  it('检测器自检：抓顶层 await，不误报函数体内 await / 注释与字符串里的 await 字样', () => {
    const topLevel = (code: string) =>
      findTopLevelAwaits(parseScript(code, { sourceType: 'module' }).program.body)

    // 必须抓到
    expect(topLevel('await load()')).toHaveLength(1)
    expect(topLevel('const v = await load()')).toHaveLength(1)
    expect(topLevel('for await (const c of chunks) { use(c) }')).toHaveLength(1)
    expect(topLevel('if (a) { await load() } else { await load2() }')).toHaveLength(2)

    // 2026-10-06 的修法本体：await 在 FunctionExpression 体内，不是 Program.body 顶层
    expect(topLevel('void (async () => { await load() })()')).toHaveLength(0)
    expect(topLevel('const f = async () => await load()')).toHaveLength(0)
    expect(topLevel('async function f() { await load() }')).toHaveLength(0)
    expect(topLevel('const o = { async m() { await load() } }')).toHaveLength(0)
    // 本仓库注释里到处是「顶层 await」这五个字，文本扫描会在这里集体误报
    expect(topLevel('// 顶层 await 会把本页变成 async setup 组件')).toHaveLength(0)
    expect(topLevel("const hint = 'await load()'")).toHaveLength(0)
  })
})
