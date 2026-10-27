/**
 * dsh-work-chain — 工作链插件（第三方 DSH 组合包·宿主半）
 *
 * 设计（与用户确认过的形态）：
 * - **当前会话就是 leader**：用户在顶栏选哪个模型，哪个模型负责拆任务/汇总复盘；
 * - **members 是真正的内置 Agent Teams 队友**：出现在「团队」UI、走团队任务板与消息；
 * - **每个 member 可以指定自己的模型**：内置 `spawn_teammate` 不暴露模型参数，本插件在
 *   `agent/created`（serial）里识别出「刚被 work_chain 拉起的、父会话是 Lead 的子 agent」，
 *   在它的 scoped context 上挂 `agent/request` / `system-prompt/assemble` waterfall，把该校色
 *   请求的 provider/model 固定为该成员配置的模型（与官方 `installModelSelection` 同套路，
 *   不 patch 任何服务方法，可随插件卸载/HMR 回收）；
 * - **fan-out 工作链**：为每个成员在团队任务板建任务 → 拉起/唤醒成员 → 等它们完成 →
 *   读取任务板摘要与结果文件 → 把结果交回 leader 汇总；
 * - **审美顾问（v0.6.0）**：新增 leader 专用工具 `aesthetic_advice`，把成果（文件/截图/URL/描述）
 *   交给一个一次性的「审美顾问」子代理做独立视觉/界面审美评审；它只给建议、不改任何项目文件，
 *   完整建议写到 `.aesthetic/<runId>/advice.md`，摘要回给 leader。启用开关、模型、审美偏好
 *   文本都在插件页「审美顾问」栏配置（默认开启、默认 flash）；
 * - **插件页 GUI 配置**：`client.js` 注册 `plugins.bundle.config` 页面，通过同源 HTTP 路由
 *   `/plugin-api/work-chain/config` 读写 members 配置；配置文件落在
 *   `$DSH_HOME/work-chain/config.json`，改完下一次调用即生效（无需重启）。
 *
 * 第三方插件约束：本文件不 import 任何 `@deepseek-ai/*` 包，只用 Node 内置模块。
 * 核心依赖的是运行时 service 契约（tools / subagents / agentTeams / webServer）。
 * 插件页成员 provider/model 下拉的选项来自 `ctx.llm` 的实时供应商/模型目录，默认 deepseek-v4.1-flash。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 插件名，供 Loader 诊断。 */
const name = 'work-chain'

/** 依赖的宿主服务；缺少内置团队服务时这一行不会激活（工作链需要团队作为跳板）。llm 用于读取供应商目录。 */
const inject = ['tools', 'subagents', 'agentTeams', 'agents', 'systemPrompt', 'webServer', 'llm']

/** 团队任务板把成员结果留在 description 里，上限 16KB，这里留出指令余量。 */
const TASK_DESCRIPTION_LIMIT = 16_000
const RESULT_FILE_LIMIT = 24_000
const TOOL_OUTPUT_LIMIT = 48_000

/** 本机实测 DSH LLM 可路由的模型（GUI 下拉建议；允许任意 provider/model）。 */
const GO_MODELS = Object.freeze([
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'claude-haiku-5-5',
  'kimi-k3',
  'kimi-k3.1-pro',
  'minimax-m3.1-flash',
  'minimax-m3',
])

/** 默认供应商/模型：插件页下拉的兜底值，所有成员默认全 flash。 */
const DEFAULT_PROVIDER = 'opencode-go'
const DEFAULT_MODEL = 'deepseek-v4.1-flash'
/** 读取单个供应商模型列表的超时，避免某个 provider 卡住整个目录。 */
const CATALOG_TIMEOUT_MS = 8000

/** 成员名上限：内置 Agent Teams 要求 lower-kebab-case 且 ≤64 字符；给 -NN 后缀留出余量。 */
const MEMBER_NAME_MAX = 64
const MEMBER_NAME_SLUG_MAX = 48
/** 旧版默认成员名（模型别名）；读取旧配置时迁移成模型名（v0.6.1）。 */
const LEGACY_DEFAULT_MEMBER_NAMES = Object.freeze(['pro', 'haiku', 'kimi', 'ds-flash'])
/** 配置命名版本：2 = 成员名默认由模型名生成；旧配置读入时自动迁移到 2。 */
const CONFIG_NAMING_VERSION = 2

/**
 * 模型 id → 合法成员名。内置 Agent Teams 只接受 lower-kebab-case
 * （^[a-z0-9]+(-[a-z0-9]+)*$，≤64 字符），所以 `deepseek-v4.1-flash` 会变成
 * `deepseek-v4-1-flash`；中文/空格/下划线等非法字符一律折叠成单个 `-`。
 */
function modelMemberName(model) {
  const slug = String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MEMBER_NAME_SLUG_MAX)
    .replace(/-+$/gu, '')
  return slug === '' ? 'member' : slug
}

/** 按模型名取不重复成员名：第一个用纯模型名，重名追加 -2、-3…（即二号、三号）。 */
function memberNameFromModel(model, taken) {
  const used = taken instanceof Set ? taken : new Set(taken ?? [])
  const base = modelMemberName(model)
  if (!used.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/** 默认成员：4 个都跑 DEFAULT_MODEL，名字直接取模型名（重名按 -2、-3、-4 编号）。 */
function defaultMembers() {
  const taken = new Set()
  return Array.from({ length: 4 }, () => {
    const name = memberNameFromModel(DEFAULT_MODEL, taken)
    taken.add(name)
    return { name, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }
  })
}

/** 默认成员快照（只读；需要可变副本时调用 defaultMembers()）。 */
const DEFAULT_MEMBERS = Object.freeze(defaultMembers())

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const CONFIG_ROUTE = '/plugin-api/work-chain/config'
const WORKFLOW_MODE_ROUTE = '/plugin-api/work-chain/workflow-mode'
const WORKFLOW_SECTION = 'work-chain:workflow-mode'
const RUNS_DIR_NAME = '.workchain'
/** 审美顾问的建议落盘目录（每次调用一个 runId 子目录）。 */
const AESTHETIC_DIR_NAME = '.aesthetic'

/**
 * 「工作流模式」开启时注入系统提示的一段话：让当前会话默认走 work_flow 调度 + 验收循环，
 * 而不是单线程直接做完。简单问答/闲聊仍可直接回答。
 */
const WORKFLOW_MODE_INSTRUCTION = [
  '【工作流模式已开启】本对话默认使用工作流（work_flow）模式协作：',
  '1. 收到任何需要动手、多步或多角度完成的任务时，先用 work_flow 建 worker 池与任务队列：把任务拆成 tasks[]（每项带 key；有先后依赖就写 depends_on），members 留空则用插件页配置的 worker 池，也可按需指定模型。',
  '2. 每轮 work_flow 返回 completedNow 后，先验收这些结果：合格就继续调用 work_flow（tasks 可为空）把剩余任务派给空闲 worker；不合格或需要新工作，就把返工/新任务放进下一轮 tasks[] 再调用。worker 会持续复用。',
  '3. 直到 work_flow 返回 done:true，再基于全部完成结果给用户做最终验收结论。',
  '4. 简单闲聊、单步问答或纯解释类请求可以直接回答，不必强行走工作流；用户明确说“不用工作流/直接回答”时按用户要求。',
].join('\n')

/** 待应用的「成员模型」提示：work_chain 派活时压入，agent/created 消费。 */
const PENDING_HINTS = []

/** 已安装模型锁定的 agent：agentId → disposer。 */
const FORCED_MODELS = new Map()

function homeDir() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function configFile() {
  return path.join(homeDir(), 'work-chain', 'config.json')
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** 校验并规范化成员列表；非法项直接抛错，避免把坏模型带进 spawn。 */
function normalizeMembers(input) {
  if (!Array.isArray(input)) throw new Error('members 必须是数组')
  const seen = new Set()
  const members = []
  for (const [index, raw] of input.entries()) {
    if (raw === null || typeof raw !== 'object') throw new Error(`members[${index}] 必须是对象`)
    const rawName = typeof raw.name === 'string' ? raw.name.trim() : ''
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    if (provider.length === 0) throw new Error(`members[${index}].provider 不能为空`)
    if (model.length === 0) throw new Error(`members[${index}].model 不能为空`)
    // v0.6.1：名字留空 = 默认取模型名（重名自动 -2、-3…）。
    const memberName = rawName === '' ? memberNameFromModel(model, seen) : rawName
    if (!MEMBER_NAME.test(memberName) || memberName.length > MEMBER_NAME_MAX) {
      throw new Error(
        `members[${index}].name 必须是 lower-kebab-case（^[a-z0-9]+(-[a-z0-9]+)*$，≤${MEMBER_NAME_MAX} 字符），收到 ${JSON.stringify(raw.name)}`,
      )
    }
    if (seen.has(memberName)) throw new Error(`成员名重复：${memberName}`)
    seen.add(memberName)
    members.push({ name: memberName, provider, model })
  }
  if (members.length === 0) throw new Error('至少配置一个成员')
  if (members.length > 64) throw new Error('成员数量超过 64，太多了')
  return members
}

/** 审美顾问默认配置：默认开启、默认 flash、无额外审美偏好。 */
function defaultAesthetic() {
  return { enabled: true, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, styleNotes: '' }
}

/** 校验审美顾问配置：provider/model 为空回默认，偏好文本去掉首尾空白并截到 4000 字。 */
function normalizeAesthetic(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const provider =
    typeof source.provider === 'string' && source.provider.trim() !== '' ? source.provider.trim() : DEFAULT_PROVIDER
  const model = typeof source.model === 'string' && source.model.trim() !== '' ? source.model.trim() : DEFAULT_MODEL
  const styleNotes = typeof source.styleNotes === 'string' ? source.styleNotes.trim().slice(0, 4000) : ''
  return { enabled: source.enabled !== false, provider, model, styleNotes }
}

function defaultConfig() {
  return {
    members: defaultMembers(),
    workflowMode: false,
    maxParallel: 4,
    timeoutSeconds: 600,
    aesthetic: defaultAesthetic(),
    namingVersion: CONFIG_NAMING_VERSION,
  }
}

/** 校验整份配置（GUI POST 与工具共用）。成员数量上限 64；实际可用数在调用时按设置里的智能体上限裁。 */
function normalizeConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  return {
    members: normalizeMembers(source.members ?? DEFAULT_MEMBERS),
    workflowMode: source.workflowMode === true,
    maxParallel: clampInteger(source.maxParallel, 4, 1, 8),
    timeoutSeconds: clampInteger(source.timeoutSeconds, 600, 30, 3600),
    aesthetic: normalizeAesthetic(source.aesthetic),
    // 旧配置没有这个字段（=1）：readConfig 会把旧默认成员名迁移成模型名。
    namingVersion: Number.isFinite(Number(source.namingVersion)) ? Math.trunc(Number(source.namingVersion)) : 1,
  }
}

/**
 * 旧配置迁移（v0.6.1）：早期默认成员名 pro/haiku/kimi/ds-flash 与真正调用的模型对不上，
 * 读配置时统一改成模型名（重名 -2、-3…）。迁移幂等，返回带 namingVersion=2 的配置。
 */
function migrateMemberNames(config) {
  if (config.namingVersion >= CONFIG_NAMING_VERSION) return config
  const legacy = new Set(LEGACY_DEFAULT_MEMBER_NAMES)
  const taken = new Set(
    config.members.filter((member) => !legacy.has(member.name)).map((member) => member.name),
  )
  const members = config.members.map((member) => {
    if (!legacy.has(member.name)) return member
    const name = memberNameFromModel(member.model, taken)
    taken.add(name)
    return { ...member, name }
  })
  return { ...config, members, namingVersion: CONFIG_NAMING_VERSION }
}

/** 读取有效配置；旧版别名成员名在读取时迁移成模型名。成员数在调用时按当前智能体上限截断。 */
function readConfig() {
  try {
    const text = fs.readFileSync(configFile(), 'utf8')
    return migrateMemberNames(normalizeConfig(JSON.parse(text)))
  } catch {
    return defaultConfig()
  }
}

function writeConfig(config) {
  const target = configFile()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return config
}

function errorMessage(error) {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}

/** 深拷贝成 lossless JSON：去掉 undefined 字段并拒绝函数/BigInt 等非 JSON 值。 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw new Error('work_chain 被取消')
}

/**
 * 把一个 agent 的模型请求锁定到指定 provider/model。
 * 与官方 `@deepseek-ai/dsh-agent` 的 `installModelSelection` 同套路：在该 agent 的
 * scoped context 上挂 `system-prompt/assemble`（同步 prompt 变量）与 `agent/request`
 * （waterfall 改写本次调用的 LlmCallConfig），不改任何共享服务。
 * @param {object} agent - 目标 agent（Teammate）。
 * @param {{provider: string, model: string}} selection - 要锁定的模型。
 * @returns {() => void} 卸载函数（重复调用安全）。
 */
function installForcedModel(agent, selection) {
  if (agent === undefined || agent === null || agent.ctx === undefined) return () => {}
  const previous = FORCED_MODELS.get(agent.id)
  if (previous !== undefined) previous()
  let disposed = false
  const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selection.provider, model: selection.model },
    }
  })
  const disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return { ...withoutInheritedEffort, provider: selection.provider, model: selection.model }
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      disposeAssembly()
    } catch {
      /* fiber 已释放 */
    }
    try {
      disposeRequest()
    } catch {
      /* fiber 已释放 */
    }
    if (FORCED_MODELS.get(agent.id) === dispose) FORCED_MODELS.delete(agent.id)
  }
  FORCED_MODELS.set(agent.id, dispose)
  return dispose
}

/**
 * 全局 agent/created（serial）：把 PENDING_HINTS 队列头部的模型提示应用到「刚创建、
 * 父会话是本次 Lead」的子 agent 上。agent-loop 会先跑完 serial 的 agent/created 再释放
 * 排队输入，所以覆盖对首个模型请求也生效。
 * @returns 卸载函数：移除监听、卸载所有模型锁定、清空待应用提示。
 */
function installHintListener(ctx) {
  const disposeCreated = ctx.on('agent/created', async ({ agent }) => {
    if (PENDING_HINTS.length === 0 || agent === undefined) return
    // 1) 精确匹配「被唤醒的既有成员」；2) 否则匹配「本次 work_chain 刚创建的子会话」。
    let hintIndex = PENDING_HINTS.findIndex((hint) => hint.expectedAgentId !== undefined && hint.expectedAgentId === agent.id)
    if (hintIndex === -1) {
      hintIndex = PENDING_HINTS.findIndex(
        (hint) => hint.expectedAgentId === undefined && agent.session?.header?.parentSession === hint.leadSessionId,
      )
    }
    if (hintIndex === -1) return
    const [hint] = PENDING_HINTS.splice(hintIndex, 1)
    hint.agentId = agent.id
    hint.dispose = installForcedModel(agent, hint.selection)
  })
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    const dispose = FORCED_MODELS.get(agent.id)
    if (dispose !== undefined) dispose()
  })
  return () => {
    try {
      disposeCreated()
    } catch {
      /* fiber 已释放 */
    }
    try {
      disposeDisposed()
    } catch {
      /* fiber 已释放 */
    }
    for (const dispose of [...FORCED_MODELS.values()]) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    FORCED_MODELS.clear()
    PENDING_HINTS.length = 0
  }
}

/** 读取请求体（限制大小），返回解析后的 JSON。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体太大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text.length === 0 ? {} : JSON.parse(text)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读取内置团队「智能体上限」：以设置里实际生效的值为准（运行中团队服务的
 * `roster.maxMembers`，设置改动会热更新到它），而不是写死数字。设置读不到时回退到
 * 配置编辑器里的 agent-team 行，再回退 8。
 * @returns {{maxMembers: number, source: 'runtime'|'config'|'fallback'}}
 */
function readTeamPolicy(ctx) {
  try {
    const runtime = ctx.get('agentTeams')?.roster?.maxMembers
    if (Number.isInteger(runtime) && runtime > 0) return { maxMembers: Math.min(64, runtime), source: 'runtime' }
  } catch {
    /* fall through */
  }
  try {
    const rows = ctx.get('configEditor')?.configuration?.() ?? []
    const row = rows.find((candidate) => candidate.entry?.options?.id === 'agent-team')
    if (row !== undefined) {
      const override = row.override ?? {}
      const inherited = row.inherited ?? {}
      const effective = Object.keys(override).length > 0 ? override : inherited
      const value = effective.maxMembers
      if (Number.isInteger(value) && value > 0) return { maxMembers: Math.min(64, value), source: 'config' }
    }
  } catch {
    /* fall through */
  }
  return { maxMembers: 8, source: 'fallback' }
}

/** 团队容量快照：智能体上限、已用成员、剩余可新建数。 */
function teamSnapshot(ctx) {
  const policy = readTeamPolicy(ctx)
  let used = 0
  try {
    const teams = ctx.get('agentTeams')
    const lead = ctx.get('agents')?.roots?.()[0]
    if (teams !== undefined && lead !== undefined) {
      used = teams.listMembers(lead).filter((row) => row.role !== 'lead').length
    }
  } catch {
    /* 拿不到就按 0 */
  }
  return {
    available: ctx.get('agentTeams') !== undefined,
    maxMembers: policy.maxMembers,
    limitSource: policy.source,
    usedMembers: used,
    remainingSlots: Math.max(0, policy.maxMembers - used),
  }
}

/**
 * 给一个 Promise 加超时：无论成功还是失败都清理定时器，超时则 reject 带标签的错误。
 * @param {Promise<any>} promise - 要等待的 Promise。
 * @param {number} ms - 超时毫秒数。
 * @param {string} label - 超时报错里的标签。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 读取 DSH 当前供应商/模型目录（供插件页下拉实时展示）。
 * 单个 provider 失败或超时只会记入 failures，不影响其它 provider；模型列表为空的 provider 跳过。
 * @param {object} ctx - cordis 插件上下文。
 * @returns {Promise<{available:boolean,groups:Array,defaultProvider:string,defaultModel:string,failures:Array}>}
 */
async function buildModelCatalog(ctx) {
  const empty = { available: false, groups: [], failures: [], defaultProvider: DEFAULT_PROVIDER, defaultModel: DEFAULT_MODEL }
  const llm = ctx?.get?.('llm')
  if (llm === undefined || llm === null) return empty
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return empty

  let providers = []
  try {
    const listed = llm.listProviders()
    if (Array.isArray(listed)) providers = listed
  } catch {
    return empty
  }

  const groups = []
  const failures = []
  const settled = await Promise.all(
    providers.map(async (provider) => {
      const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
      const name = typeof provider?.name === 'string' ? provider.name.trim() : ''
      if (id.length === 0) return
      let rawModels
      try {
        rawModels = await withTimeout(
          Promise.resolve().then(() => llm.listModels(id)),
          CATALOG_TIMEOUT_MS,
          `listModels(${id})`,
        )
      } catch (error) {
        failures.push({ id, name, message: errorMessage(error) })
        return
      }
      if (!Array.isArray(rawModels)) {
        failures.push({ id, name, message: 'listModels 返回的不是数组' })
        return
      }
      const seen = new Set()
      const models = []
      for (const raw of rawModels) {
        const modelId = typeof raw?.id === 'string' ? raw.id.trim() : ''
        if (modelId.length === 0) continue
        if (seen.has(modelId)) continue
        seen.add(modelId)
        const modelName = typeof raw?.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : modelId
        models.push({ id: modelId, name: modelName })
      }
      if (models.length === 0) return
      groups.push({ id, name: name.length > 0 ? name : id, models })
    }),
  )
  void settled

  // 默认组：优先 id===DEFAULT_PROVIDER 且含 DEFAULT_MODEL，其次任意含 DEFAULT_MODEL，最后第一个组。
  let defaultGroup = groups.find((group) => group.id === DEFAULT_PROVIDER && group.models.some((model) => model.id === DEFAULT_MODEL))
  if (defaultGroup === undefined) defaultGroup = groups.find((group) => group.models.some((model) => model.id === DEFAULT_MODEL))
  if (defaultGroup === undefined) defaultGroup = groups[0]
  const defaultProvider = defaultGroup === undefined ? DEFAULT_PROVIDER : defaultGroup.id
  if (defaultGroup !== undefined && groups[0] !== defaultGroup) {
    const index = groups.indexOf(defaultGroup)
    groups.splice(index, 1)
    groups.unshift(defaultGroup)
  }
  return {
    available: groups.length > 0,
    groups,
    failures,
    defaultProvider,
    defaultModel: DEFAULT_MODEL,
  }
}

/** 「工作流模式」开关接口：对话页按钮读写（GET 当前状态，POST {enabled} 切换）。 */
function installWorkflowModeRoute(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: WORKFLOW_MODE_ROUTE,
    async handler(req, res) {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, enabled: readConfig().workflowMode === true })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const config = readConfig()
          config.workflowMode = body?.enabled === true
          writeConfig(config)
          sendJson(res, 200, { ok: true, enabled: config.workflowMode })
          return
        }
        sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method ?? '?'}` })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) })
      }
    },
  })
}

/** 工作流模式系统提示的 order：排在团队策略之后。 */
function workflowSectionOrder(ctx) {
  try {
    const base = ctx.systemPrompt.getSectionOrder('TEAM_POLICY')
    if (Number.isFinite(base)) return base + 10
  } catch {
    /* fall through */
  }
  return 650
}

/** 插件页 GUI 的配置接口：GET 读、POST 写。 */
function installConfigRoute(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    async handler(req, res) {
      try {
        const team = teamSnapshot(ctx)
        if (req.method === 'GET') {
          const catalog = await buildModelCatalog(ctx)
          sendJson(res, 200, {
            ok: true,
            config: readConfig(),
            defaults: {
              members: DEFAULT_MEMBERS.map((member) => ({ ...member })),
              models: GO_MODELS,
              provider: catalog.defaultProvider,
              model: catalog.defaultModel,
              aesthetic: { ...defaultAesthetic(), provider: catalog.defaultProvider, model: catalog.defaultModel },
            },
            catalog,
            team,
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const current = readConfig()
          const incoming = body?.config !== null && typeof body?.config === 'object' ? body.config : {}
          // 保存成员等配置时保留「工作流模式」开关与命名版本（配置页不一定提交这两个字段）。
          const config = normalizeConfig({
            ...incoming,
            // 客户端不提交 namingVersion：始终保留当前（已迁移）版本，避免被旧客户端降回 1。
            namingVersion: Math.max(
              Number.isFinite(Number(incoming.namingVersion)) ? Math.trunc(Number(incoming.namingVersion)) : 0,
              current.namingVersion,
            ),
            workflowMode: incoming.workflowMode ?? current.workflowMode,
          })
          writeConfig(config)
          sendJson(res, 200, { ok: true, config, team })
          return
        }
        sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method ?? '?'}` })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) })
      }
    },
  })
}

function escapeTaskText(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

/** 成员工作提示：说明任务、任务板 id、结果文件与完成步骤。 */
function buildMemberPrompt(options) {
  const { task, subtask, member, runId, taskId, taskRevision, timeoutSeconds, resultFile } = options
  const lines = [
    `你是「工作链」成员 ${member.name}（模型 ${member.model}），由 Team Lead 通过 work_chain 派活。`,
    '',
    '## 总任务',
    escapeTaskText(task, 5000),
    '',
    '## 你负责的分工',
    escapeTaskText(subtask, 6000),
    '',
    '## 交付要求（必须全部完成）',
    `1. 把完整结果（Markdown）写到文件：${resultFile}（目录不存在请先创建）。内容自包含：结论、依据/链接、代码或步骤、风险与未决问题。`,
    `2. 团队任务板上已建好任务 \`${taskId}\`（当前 revision ${taskRevision}）。流程：team_task_get 读最新 revision → team_task_update action=claim（用最新 expected_revision）→ action=edit 把 description 改成「摘要（≤4000 字）+ 结果文件路径」→ action=complete（每步都用最新 revision）。`,
    '   如果团队任务 edit 调用失败（例如参数没传上），不要反复重试：直接 action=complete 即可，结果以结果文件为准。',
    '3. 如果无法完成，也要把原因写进任务 description 并 complete，不要静默卡住。',
    '',
    `时间预算约 ${Math.round(timeoutSeconds / 60)} 分钟。不要调用 work_chain 工具（只有 Lead 可以）。`,
    `run id：${runId}`,
  ]
  return lines.join('\n')
}

function uniqueMemberName(desired, roster) {
  const used = new Set(roster.filter((row) => row.role !== 'lead').map((row) => row.name))
  if (!used.has(desired)) return desired
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${desired}-${index}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`无法为成员 ${desired} 生成唯一名字`)
}

/** 等待团队任务完成（或超时/取消）；返回是否全部完成。 */
async function waitForTasks(options) {
  const { agentTeams, lead, taskIds, timeoutMs, signal, pollMs = 1500 } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const tasks = agentTeams.listTasks(lead).filter((task) => taskIds.has(task.id))
    if (tasks.length === taskIds.size && tasks.every((task) => task.status === 'completed')) return true
    await sleep(Math.min(pollMs, Math.max(200, deadline - Date.now())))
  }
  return false
}

function readResultFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.length > RESULT_FILE_LIMIT ? `${text.slice(0, RESULT_FILE_LIMIT)}\n…（文件过长已截断）` : text
  } catch {
    return undefined
  }
}

function formatToolOutput(value) {
  const lines = [
    `# work_chain ${value.timedOut ? '（超时，部分结果）' : '完成'}`,
    `run: ${value.runId} | leader: ${value.leader.provider}/${value.leader.model} | 成员 ${value.members.length} 个 | 用时 ${Math.round(value.elapsedMs / 1000)}s`,
  ]
  if (value.team !== undefined) {
    lines.push(
      `团队容量：设置上限 ${value.team.maxMembers}（来源 ${value.team.limitSource}）· 本次开始前已用 ${value.team.usedBefore} · 复用 ${value.team.reused} 个`,
    )
  }
  for (const note of value.notes ?? []) lines.push(`注意：${note}`)
  for (const skipped of value.team?.skipped ?? []) lines.push(`跳过成员 ${skipped.name}（${skipped.model}）：${skipped.reason}`)
  lines.push('')
  for (const member of value.members) {
    const actual =
      member.actualModel === undefined
        ? '（实际请求模型未读到）'
        : `（实际请求：${member.actualProvider}/${member.actualModel}）`
    lines.push(`## ${member.name}（${member.provider}/${member.model}）${actual}`)
    lines.push(`任务板：${member.taskId} · 状态：${member.taskStatus}${member.fileFound ? ` · 结果文件：${member.file}` : ' · 结果文件缺失'}${member.error === undefined ? '' : ` · 派活错误：${member.error}`}`)
    lines.push('')
    if (member.summary !== undefined && member.summary.length > 0) {
      lines.push(`任务板摘要${member.summarySource === 'file' ? '（任务板未更新，取自结果文件）' : ''}：`)
      lines.push(escapeTaskText(member.summary, 4000))
    }
    if (member.output !== undefined && member.output.length > 0) {
      lines.push('')
      lines.push('结果全文：')
      lines.push(member.output)
    }
    lines.push('')
  }
  lines.push('请基于以上成员结果完成最终汇总/核验；完整文件在 `.workchain/<runId>/` 目录。')
  return lines.join('\n')
}

/**
 * 审美顾问的一次性任务提示：独立视觉/界面审美评审，只给建议、不改项目文件。
 * @param {{target:string, focus?:string, context?:string, styleNotes?:string, resultFile:string, runId?:string, timeoutSeconds?:number}} options
 * @returns {string} 交给审美顾问子代理的提示词。
 */
function buildAestheticPrompt(options) {
  const { target, focus, context, styleNotes, resultFile, runId, timeoutSeconds } = options
  const focusText =
    typeof focus === 'string' && focus.trim().length > 0
      ? focus.trim()
      : '通用审美：构图/布局、配色、字体与字号层级、间距与对齐、一致性、动效与细节'
  const contextText = typeof context === 'string' && context.trim().length > 0 ? context.trim() : '未提供'
  const styleText =
    typeof styleNotes === 'string' && styleNotes.trim().length > 0
      ? styleNotes.trim()
      : '未配置额外偏好，按通用审美标准评审'
  const budgetSeconds =
    typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.round(timeoutSeconds)
      : 180
  return [
    '你是「审美顾问」——一位独立的视觉/界面审美评审。你只给建议，不改任何文件；你不在团队里，也不需要和任何人协作。',
    '',
    '## 待审对象',
    escapeTaskText(target, 4000),
    '',
    '## 重点关注',
    escapeTaskText(focusText, 4000),
    '',
    '## 背景',
    escapeTaskText(contextText, 6000),
    '',
    '## 审美偏好（来自插件配置，尽量贴合）',
    escapeTaskText(styleText, 4000),
    '',
    '## 工作方式',
    '- 你可以读取文件、查看图片、浏览网页来理解待审对象，需要多少看多少。',
    '- 不要修改项目文件（包括待审对象本身），所有输出只写进结果文件。',
    '- 待审对象不存在或读不到时，直接说明「未找到/无法读取」，不要编造细节。',
    '',
    '## 时间预算',
    `约 ${budgetSeconds} 秒。优先给结论；不要为了测评跑超出预算的长时间流程（例如多分辨率批量截图、CDP 自动化扫全部视口），到点前先把已有结论写进结果文件。超时会被硬中断。`,
    '',
    '## 交付要求',
    `1. 把完整建议写到文件：${resultFile}（目录不存在请先创建）。`,
    '2. 建议结构：',
    '   - 开头一句总评 + 0~10 分（分数与理由一致，别虚高）。',
    '   - 按影响从大到小排序的问题清单；每条写清「现象 → 为什么不好看 → 怎么改」，修改要具体到颜色/间距/字号/层级/动效/对齐。',
    '   - 2~4 条加分项（已经做得好的地方，或低成本见效的提升点）。',
    '   - 给 leader 的采纳建议：哪些必改、哪些可选，并说明理由。',
    '3. 最后一条回复用 3~5 行摘要给 leader，不要复述全文。',
    '',
    ...(typeof runId === 'string' && runId.length > 0 ? [`run id：${runId}`] : []),
    '不要调用 work_chain、work_flow、aesthetic_advice、spawn_teammate、team_task_* 或 send_message。',
  ].join('\n')
}

/** aesthetic_advice 的模型可见输出：首行路由/用时/建议文件，空行，然后建议正文。 */
function formatAestheticOutput(value) {
  const seconds = Math.round((value.elapsedMs ?? 0) / 1000)
  const lines = [
    `【审美顾问】${value.provider}/${value.model}${value.timedOut === true ? '（超时）' : ''} · ${seconds}s · 建议文件 ${value.file}`,
  ]
  if (value.actualModel !== undefined && (value.actualProvider !== value.provider || value.actualModel !== value.model)) {
    lines.push(`实际请求路由：${value.actualProvider}/${value.actualModel}`)
  }
  if (value.error !== undefined) lines.push(`调用异常：${value.error}`)
  lines.push('')
  lines.push(value.advice !== undefined && value.advice.length > 0 ? value.advice : '（审美顾问没有给出建议）')
  return lines.join('\n')
}

/** 把子代理结果里的文本块拼成字符串。 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 工作流（work_flow）持久状态：按 Lead 会话保存 runId、key→taskId 映射、任务尝试次数。 */
function flowFile() {
  return path.join(homeDir(), 'work-chain', 'flows.json')
}

function loadFlows() {
  try {
    const data = JSON.parse(fs.readFileSync(flowFile(), 'utf8'))
    return data !== null && typeof data === 'object' && typeof data.flows === 'object' ? data : { flows: {} }
  } catch {
    return { flows: {} }
  }
}

function saveFlows(data) {
  try {
    const target = flowFile()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 1)}\n`, 'utf8')
    fs.renameSync(temporary, target)
  } catch {
    /* 状态写不进也不阻塞流程 */
  }
}

/** 取/建某个 Lead 会话的工作流状态。 */
function flowStateFor(lead) {
  const sessionId = lead.session?.header?.id ?? 'unknown'
  const data = loadFlows()
  const now = Date.now()
  for (const [key, value] of Object.entries(data.flows)) {
    if (value === null || typeof value !== 'object' || now - (value.createdAt ?? 0) > 7 * 86_400_000) delete data.flows[key]
  }
  let state = data.flows[sessionId]
  if (state === undefined) {
    state = {
      runId: `flow-${new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19)}-${randomUUID().slice(0, 6)}`,
      createdAt: now,
      keys: {},
      tasks: {},
      pool: [],
    }
    data.flows[sessionId] = state
  }
  return {
    state,
    save() {
      data.flows[sessionId] = state
      saveFlows(data)
    },
  }
}

/** 工作流 worker 的派活提示：Lead 已把它 reassign 给该 worker（状态 in_progress）。 */
function buildFlowWorkerPrompt(options) {
  const { task, prompt, worker, taskId, title, resultFile, runId } = options
  return [
    `你是「工作流」执行成员 ${worker.name}（模型 ${worker.model}）。Lead 已把团队任务 ${taskId}（${title}）分配给你，状态已是 in_progress，无需 claim。`,
    '',
    '## 总体目标',
    escapeTaskText(task, 4000),
    '',
    '## 本次任务',
    escapeTaskText(prompt, 6000),
    '',
    '## 交付步骤（必须完成）',
    `1. 把完整结果（Markdown）写到文件：${resultFile}（目录不存在先创建）。`,
    `2. team_task_get ${taskId} 读最新 revision → team_task_update action=edit（description=「摘要（≤4000 字）+ 结果文件路径」，expected_revision 用最新的）→ action=complete（再用最新 revision）。`,
    '3. 如果无法完成：也 edit 写明原因并 complete，不要留着 in_progress。',
    '4. 不要调用 work_chain / work_flow（只有 Lead 可以）。本回合结束后保持空闲，等 Lead 再分配。',
    '',
    `flow run：${runId}`,
  ].join('\n')
}

/** 保证工作流的 worker 池存在：同名 teammate 复用（并重新锁定模型），缺的空槽新建。 */
async function ensureFlowPool(ctx, agentTeams, lead, members, notes, signal) {
  const policy = readTeamPolicy(ctx)
  const roster = agentTeams.listMembers(lead)
  const teammates = roster.filter((row) => row.role !== 'lead')
  const reusable = new Map(teammates.filter((row) => row.status !== 'failed').map((row) => [row.name, row]))
  let slotsLeft = Math.max(0, policy.maxMembers - teammates.length)
  const pool = []
  for (const member of members) {
    const existing = reusable.get(member.name)
    if (existing !== undefined) {
      const live = ctx.get('agents')?.get?.(existing.id)
      if (live !== undefined) installForcedModel(live, { provider: member.provider, model: member.model })
      pool.push({ ...member, name: existing.name, memberId: existing.id, reused: true })
      continue
    }
    if (slotsLeft <= 0) {
      notes.push(`智能体槽位不足（设置上限 ${policy.maxMembers}，已用 ${teammates.length}），无法新建 worker ${member.name}；请复用已有成员名或调大上限`)
      continue
    }
    const spawnName = uniqueMemberName(member.name, roster)
    roster.push({ role: 'teammate', name: spawnName })
    const hint = {
      leadSessionId: lead.session?.header?.id,
      selection: { provider: member.provider, model: member.model },
    }
    PENDING_HINTS.push(hint)
    try {
      const spawned = await agentTeams.spawnTeammate(lead, {
        name: spawnName,
        description: `work-flow worker ${spawnName} (${member.provider}/${member.model})`.slice(0, 190),
        prompt: [{ type: 'text', text: `你是「工作流」的常驻 worker ${spawnName}（模型 ${member.model}）。回一句「worker ready」即可，然后等 Lead 派任务。` }],
        context: 'fresh',
        provider: 'spawn',
        signal,
      })
      slotsLeft -= 1
      pool.push({ ...member, name: spawnName, memberId: spawned?.member?.id, reused: false })
    } catch (error) {
      notes.push(`新建 worker ${spawnName} 失败：${errorMessage(error)}`)
    } finally {
      const index = PENDING_HINTS.indexOf(hint)
      if (index !== -1) PENDING_HINTS.splice(index, 1)
    }
  }
  return pool
}

/** 唤醒/通知一个 worker：冷成员先挂模型锁定提示，活成员直接重锁模型，再发消息。 */
async function wakeFlowWorker(ctx, agentTeams, lead, spec, prompt, signal) {
  const roster = agentTeams.listMembers(lead)
  const row = roster.find((candidate) => candidate.name === spec.name)
  const live = row === undefined ? undefined : ctx.get('agents')?.get?.(row.id)
  if (row !== undefined && live === undefined) {
    PENDING_HINTS.push({
      expectedAgentId: row.id,
      leadSessionId: lead.session?.header?.id,
      selection: { provider: spec.provider, model: spec.model },
    })
  } else if (live !== undefined) {
    installForcedModel(live, { provider: spec.provider, model: spec.model })
  }
  await agentTeams.sendMessage(lead, {
    target: spec.name,
    content: [{ type: 'text', text: prompt }],
    signal,
  })
}

/** 读一条已完成的流程任务（任务板摘要 + 结果文件）。 */
function collectFlowTask(agentTeams, lead, taskId, runDir) {
  let view
  try {
    view = agentTeams.getTask(lead, taskId)
  } catch {
    return { taskId, status: 'missing' }
  }
  const file = path.join(runDir, `${taskId}.md`)
  const fileText = readResultFile(file)
  const summary = view.description ?? ''
  return {
    taskId,
    title: view.subject,
    status: view.status,
    owner: view.ownerName,
    summary: escapeTaskText(summary, 4000),
    file,
    fileFound: fileText !== undefined,
    ...(fileText === undefined ? {} : { output: fileText }),
  }
}

/** work_flow 的模型可见输出。 */
function formatFlowOutput(value) {
  const lines = [
    `# work_flow ${value.done ? '（队列清空）' : '（调度返回，等待 Lead 验收/补充任务）'}`,
    `flow: ${value.flowRun} | 总任务数 ${value.counts.total} | 待办 ${value.counts.pending} · 进行中 ${value.counts.inProgress} · 已完成 ${value.counts.completed}`,
  ]
  if (value.workers.length > 0) lines.push(`worker：${value.workers.map((w) => `${w.name}(${w.model}/${w.status})`).join('、')}`)
  for (const note of value.notes ?? []) lines.push(`注意：${note}`)
  lines.push('')
  if (value.assigned.length > 0) {
    lines.push('## 本次派发')
    for (const item of value.assigned) lines.push(`- ${item.taskId} ${item.title} → ${item.worker}`)
    lines.push('')
  }
  if (value.completedNow.length > 0) {
    lines.push('## 本次完成（请验收）')
    for (const item of value.completedNow) {
      lines.push(`### ${item.taskId} ${item.title}（owner: ${item.owner ?? '?'}）`)
      if (item.summary !== undefined && item.summary.length > 0) lines.push(item.summary.length > 3000 ? `${item.summary.slice(0, 3000)}\n…` : item.summary)
      if (item.output !== undefined && item.output.length > 0) lines.push('', item.output.length > 6000 ? `${item.output.slice(0, 6000)}\n…（完整内容看 ${item.file}）` : item.output)
      lines.push('')
    }
  }
  if (value.remaining.length > 0) {
    lines.push('## 待办/进行中')
    for (const item of value.remaining) lines.push(`- ${item.taskId} ${item.title} · ${item.status ?? (item.owner ? '进行中' : '待办')}${item.ready === false ? '（被依赖阻塞）' : ''}`)
    lines.push('')
  }
  lines.push(value.done ? '队列已清空，可以给用户做最终验收结论。' : '请验收上一条/几条完成结果：需要返工或补充新任务时，把新任务放进下一次 work_flow 的 tasks（可带 depends_on key）；无需补充就继续调用 work_flow（tasks 可空）把剩余任务派给空闲 worker。')
  return lines.join('\n')
}

/**
 * 挂载插件。
 * @param {object} ctx - cordis 插件上下文。
 */
function apply(ctx) {
  // 1) 给「内置团队 spawn」补按成员模型运行的通道（agent/created 上装模型锁定）。
  const disposeHints = ctx.effect(() => installHintListener(ctx), 'work-chain: model hints')

  // 2) 插件页配置接口 + 对话页「工作流模式」开关接口。
  const disposeRoute = ctx.effect(() => installConfigRoute(ctx), 'work-chain: config route')
  const disposeWorkflowMode = ctx.effect(() => installWorkflowModeRoute(ctx), 'work-chain: workflow-mode route')

  // 3) 「工作流模式」开启时注入系统提示（默认走 work_flow 调度 + 验收循环）。
  const disposePrompt = ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: WORKFLOW_SECTION,
        order: workflowSectionOrder(ctx),
        text: () => (readConfig().workflowMode === true ? WORKFLOW_MODE_INSTRUCTION : ''),
      }),
    'work-chain: workflow-mode prompt',
  )

  // 4) leader 侧的 work_chain 工具。
  const disposeTool = ctx.tools.register({
    name: 'work_chain',
    description:
      'Run one fan-out work chain with the built-in Agent Teams. The current session stays the leader and supplies the task; each configured member becomes a durable Agent Teams teammate with its own model and writes the full result under .workchain/<runId>/. Members are visible on the team UI and task board, are reused by name across calls, and are limited by the "max agents" setting; members that cannot get a slot are skipped and reported. Use it when a task benefits from several independent model perspectives or parallel work. Only the Team Lead may call it. Configure members (name/provider/model) on the Work Chain bundle page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'The overall task the members should work on. The leader synthesizes their results afterwards.',
        },
        subtasks: {
          type: 'array',
          description:
            'Optional decomposition produced by the leader. Each item becomes one member task. Without it every configured member works the whole task from its own angle.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt'],
            properties: {
              title: { type: 'string', description: 'Short task-board subject.' },
              prompt: { type: 'string', description: 'Self-contained instruction for this member.' },
              member: { type: 'string', description: 'Optional configured member name to assign this subtask to.' },
            },
          },
        },
        members: {
          type: 'array',
          description: 'Optional per-call override of the configured members.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'provider', 'model'],
            properties: {
              name: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
            },
          },
        },
        timeout_seconds: {
          type: 'number',
          description: 'Overall wait budget for the chain (30-3600 seconds). Defaults to the configured timeoutSeconds.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: formatToolOutput(value) }],
    },
    async execute(args, exec) {
      const agentTeams = ctx.get('agentTeams')
      if (agentTeams === undefined || agentTeams === null) throw new Error('work_chain 需要内置 Agent Teams：请在插件页启用它')
      const lead = exec.agent
      if (lead === undefined) throw new Error('work_chain 必须由 agent 调用')
      const membership = agentTeams.membership(lead)
      if (membership.role !== 'lead') throw new Error('work_chain 只能由 Team Lead 调用')
      const signal = exec.signal
      throwIfAborted(signal)

      const config = readConfig()
      const timeoutSeconds =
        args.timeout_seconds === undefined
          ? config.timeoutSeconds
          : clampInteger(args.timeout_seconds, config.timeoutSeconds, 30, 3600)
      const timeoutMs = timeoutSeconds * 1000
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (task.length === 0) throw new Error('task 不能为空')

      // leader 的模型：会话级 selection（可能随用户切换变化）
      const leaderOptions = membership.root.options ?? {}
      const leader = {
        provider: leaderOptions.provider ?? 'unknown',
        model: leaderOptions.model ?? 'unknown',
      }

      // 智能体上限以「设置」里当前生效的值为准；已存在的同名 teammate 直接复用（不占新槽位）。
      const policy = readTeamPolicy(ctx)
      const subtasks = Array.isArray(args.subtasks) && args.subtasks.length > 0 ? args.subtasks : []
      const runId = `${new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19)}-${randomUUID().slice(0, 8)}`
      const cwd = resolveWorkingDirectory(ctx, lead)
      const runDir = path.join(cwd, RUNS_DIR_NAME, runId)

      const roster = agentTeams.listMembers(lead)
      const teammatesBefore = roster.filter((row) => row.role !== 'lead')
      const reusableByName = new Map(teammatesBefore.filter((row) => row.status !== 'failed').map((row) => [row.name, row]))
      const requestedMembers = args.members === undefined ? config.members : normalizeMembers(args.members)
      const notes = []
      let plans
      let planItems = []
      let skipped = []
      let members = requestedMembers
      if (members.length > policy.maxMembers) {
        notes.push(`配置了 ${members.length} 个成员，超过智能体上限 ${policy.maxMembers}，本次只用前 ${policy.maxMembers} 个`)
        members = members.slice(0, policy.maxMembers)
      }
      let slotsLeft = Math.max(0, policy.maxMembers - teammatesBefore.length)
      const usedReuseNames = new Set()
      for (const [index, member] of members.entries()) {
        const existing = reusableByName.get(member.name)
        if (existing !== undefined && !usedReuseNames.has(existing.name)) {
          usedReuseNames.add(existing.name)
          planItems.push({ member, index, reuse: existing })
        } else if (slotsLeft > 0) {
          planItems.push({ member, index, reuse: undefined })
          slotsLeft -= 1
        } else {
          // 槽位已满：不换模型/不挪用旧成员，直接跳过并报告；新开一个对话即可获得全新槽位。
          skipped.push({
            name: member.name,
            model: member.model,
            reason: `没有空余智能体槽位（设置上限 ${policy.maxMembers}，已用 ${teammatesBefore.length}）；新开一个对话即可重置槽位`,
          })
        }
      }
      if (planItems.length === 0) {
        const reusableNames = [...reusableByName.keys()]
        throw new Error(
          `没有可用的智能体槽位：设置上限 ${policy.maxMembers}，当前已用 ${teammatesBefore.length}。请到设置里调大智能体上限（或删掉一些 teammate），或使用已有成员：${reusableNames.length > 0 ? reusableNames.join(', ') : '（无）'}；新开一个对话也可以重置槽位`,
        )
      }
      if (skipped.length > 0) notes.push(`${skipped.length} 个成员因槽位不足被跳过：${skipped.map((row) => row.name).join(', ')}`)
      plans = planItems.map((item) => {
        const requested = subtasks[item.index]
        const role =
          requested !== undefined && typeof requested.prompt === 'string' && requested.prompt.length > 0
            ? requested.prompt
            : `独立完成总任务中你负责的部分（编号 ${item.index + 1}）。如果与其他成员并行，请选择不重复的角度，给出可核查的结论与来源。`
        const title =
          requested !== undefined && typeof requested.title === 'string' && requested.title.trim().length > 0
            ? requested.title.trim()
            : `${item.member.name} · 工作链分工`
        return { member: item.member, title, role, reuse: item.reuse }
      })

      // 建团队任务
      const created = []
      for (const [index, plan] of plans.entries()) {
        const resultFile = path.join(runDir, `${plan.member.name}.md`)
        const prompt = buildMemberPrompt({
          task,
          subtask: plan.role,
          member: plan.member,
          runId,
          taskId: 'PENDING',
          taskRevision: 1,
          timeoutSeconds,
          resultFile,
        })
        const description = escapeTaskText(
          `【工作链】成员 ${plan.member.name}（${plan.member.provider}/${plan.member.model}）\n\n分工：${plan.role}\n\n完成后把摘要写进本任务 description 并 complete；完整结果写到 ${resultFile}`,
          TASK_DESCRIPTION_LIMIT,
        )
        const view = await agentTeams.createTask(lead, {
          subject: escapeTaskText(plan.title, 190),
          description,
          writeScopes: [],
        })
        const withTask = buildMemberPrompt({
          task,
          subtask: plan.role,
          member: plan.member,
          runId,
          taskId: view.id,
          taskRevision: view.revision,
          timeoutSeconds,
          resultFile,
        })
        created.push({ ...plan, taskId: view.id, taskRevision: view.revision, baseDescription: description, resultFile, prompt: withTask, index })
      }

      // 派活：可复用同名同模型的成员（发消息），否则以该成员模型 spawn 新 teammate
      const startedAt = Date.now()
      const dispatched = []
      try {
        fs.mkdirSync(runDir, { recursive: true })
      } catch {
        /* 写不进也没关系，任务板仍是交付面 */
      }
      for (const item of created) {
        throwIfAborted(signal)
        const existing = item.reuse
        try {
          if (existing !== undefined) {
            // 复用成员：活着就直接锁模型；若已冷落，推 hint 等它被唤醒重建时命中。
            const liveMember = ctx.get('agents')?.get?.(existing.id)
            if (liveMember !== undefined) installForcedModel(liveMember, { provider: item.member.provider, model: item.member.model })
            else
              PENDING_HINTS.push({
                runId,
                expectedAgentId: existing.id,
                leadSessionId: lead.session?.header?.id,
                selection: { provider: item.member.provider, model: item.member.model },
              })
            await agentTeams.sendMessage(lead, {
              target: existing.name,
              content: [{ type: 'text', text: item.prompt }],
              signal,
            })
            dispatched.push({ ...item, memberId: existing.id ?? existing.name, reused: true, modelLocked: true })
          } else {
            let spawnName = uniqueMemberName(item.member.name, roster)
            roster.push({ role: 'teammate', name: spawnName, model: item.member.model })
            let hint
            let spawned
            let spawnError
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              hint = {
                runId,
                leadSessionId: lead.session?.header?.id,
                selection: { provider: item.member.provider, model: item.member.model },
              }
              PENDING_HINTS.push(hint)
              try {
                spawned = await agentTeams.spawnTeammate(lead, {
                  name: spawnName,
                  description: `work-chain member ${spawnName} (${item.member.provider}/${item.member.model})`.slice(0, 190),
                  prompt: [{ type: 'text', text: item.prompt }],
                  context: 'fresh',
                  provider: 'spawn',
                  signal,
                })
                spawnError = undefined
                break
              } catch (error) {
                spawnError = error
                if (attempt === 1) {
                  // 团队 provisioning 偶发 TEAM_PROVISIONING_CONFLICT：换个名字重试一次（失败名字已占一个 roster 位）。
                  await sleep(800)
                  spawnName = uniqueMemberName(`${spawnName}-r2`, roster)
                  roster.push({ role: 'teammate', name: spawnName, model: item.member.model })
                }
              } finally {
                const pendingIndex = PENDING_HINTS.indexOf(hint)
                if (pendingIndex !== -1) PENDING_HINTS.splice(pendingIndex, 1)
              }
            }
            if (spawnError !== undefined) throw spawnError
            const memberId = spawned?.member?.id
            // 自检：模型锁定应落在刚创建的成员身上；若没命中（例如被别的并发子代理截胡），就地补装。
            if (hint.agentId === undefined || (memberId !== undefined && hint.agentId !== memberId)) {
              const child = memberId === undefined ? undefined : ctx.get('agents')?.get?.(memberId)
              if (child !== undefined) hint.dispose = installForcedModel(child, hint.selection)
            }
            dispatched.push({
              ...item,
              spawnName,
              memberId: memberId ?? spawnName,
              reused: false,
              modelLocked: hint.agentId !== undefined || hint.dispose !== undefined,
            })
          }
        } catch (error) {
          dispatched.push({ ...item, error: errorMessage(error) })
        }
      }

      // 失败派活的任务从任务板删掉，避免留下永远 pending 的脏任务。
      for (const item of dispatched) {
        if (item.error === undefined) continue
        try {
          const task = agentTeams.getTask(lead, item.taskId)
          await agentTeams.updateTask(lead, {
            taskId: item.taskId,
            expectedRevision: task.revision,
            action: 'delete',
          })
        } catch {
          /* 删不掉就留着，不影响结果 */
        }
      }

      // 等任务板完成（没有任何成员成功派活时直接返回，不必空等到超时）
      const activeDispatched = dispatched.filter((item) => item.error === undefined)
      const activeTaskIds = new Set(activeDispatched.map((item) => item.taskId))
      const allCompleted =
        activeTaskIds.size === 0
          ? false
          : await waitForTasks({
              agentTeams,
              lead,
              taskIds: activeTaskIds,
              timeoutMs,
              signal: exec.signal,
            })

      // 取消未完成的成员（只在整体超时时），然后收集结果
      const latestTasks = new Map(agentTeams.listTasks(lead).map((task) => [task.id, task]))
      const membersOut = []
      let budget = TOOL_OUTPUT_LIMIT
      for (const item of dispatched) {
        const task = latestTasks.get(item.taskId)
        const output = readResultFile(item.resultFile)
        const boardDescription = task !== undefined ? task.description : undefined
        const summaryUpdated =
          boardDescription !== undefined && item.baseDescription !== undefined && boardDescription !== item.baseDescription
        const summary =
          summaryUpdated === true
            ? boardDescription
            : output !== undefined
              ? output.length > 3000
                ? `${output.slice(0, 3000)}\n…（摘要取自结果文件）`
                : output
              : boardDescription
        const applied = readAppliedRoute(ctx, item.memberId)
        const entry = {
          name: item.member.name,
          spawnName: item.spawnName ?? item.member.name,
          provider: item.member.provider,
          model: item.member.model,
          actualProvider: applied?.provider,
          actualModel: applied?.model,
          modelLocked: item.modelLocked === true,
          taskId: item.taskId,
          taskStatus: task?.status ?? 'missing',
          summary,
          summarySource: summaryUpdated ? 'board' : output !== undefined ? 'file' : 'board',
          file: item.resultFile,
          fileFound: output !== undefined,
          ...(output === undefined ? {} : { output }),
          ...(item.error === undefined ? {} : { error: item.error }),
          ...(item.reused === true ? { reused: true } : {}),
        }
        membersOut.push(entry)
        if (output !== undefined) budget -= output.length
        if (budget <= 0) {
          // 输出预算用完：后续只保留摘要，避免把模型上下文打爆
          for (const later of dispatched.slice(dispatched.indexOf(item) + 1)) {
            const laterTask = latestTasks.get(later.taskId)
            const laterApplied = readAppliedRoute(ctx, later.memberId)
            membersOut.push({
              name: later.member.name,
              spawnName: later.spawnName ?? later.member.name,
              provider: later.member.provider,
              model: later.member.model,
              actualProvider: laterApplied?.provider,
              actualModel: laterApplied?.model,
              modelLocked: later.modelLocked === true,
              taskId: later.taskId,
              taskStatus: laterTask?.status ?? 'missing',
              summary: laterTask?.description,
              file: later.resultFile,
              fileFound: fs.existsSync(later.resultFile),
            })
          }
          break
        }
      }

      if (!allCompleted) {
        // 超时：打断仍在跑的成员，避免后台空转
        for (const member of membersOut) {
          if (member.taskStatus !== 'completed') {
            try {
              agentTeams.interrupt(lead, member.spawnName)
            } catch {
              /* 已 inactive 或不存在时忽略 */
            }
          }
        }
      }

      const completed = membersOut.filter((member) => member.taskStatus === 'completed').length
      // 清掉本次 run 未命中的模型提示（例如复用成员其实没被冷唤醒）。
      for (let index = PENDING_HINTS.length - 1; index >= 0; index -= 1) {
        if (PENDING_HINTS[index].runId === runId) PENDING_HINTS.splice(index, 1)
      }
      return jsonSafe({
        runId,
        leader,
        members: membersOut,
        completed,
        timedOut: !allCompleted,
        elapsedMs: Date.now() - startedAt,
        runDir,
        team: {
          maxMembers: policy.maxMembers,
          limitSource: policy.source,
          usedBefore: teammatesBefore.length,
          reused: membersOut.filter((member) => member.reused === true).length,
          skipped,
        },
        notes,
      })
    },
  })

  const disposeFlowTool = ctx.tools.register({
    name: 'work_flow',
    description:
      'Run an iterative work-flow with the built-in Agent Teams. The current session is the Lead and final reviewer; a pool of durable teammate workers (each with its own configured model) is reused for the whole flow. Each call: create the given task list on the team task board, assign ready pending tasks to idle workers (Lead reassigns the task and messages the worker), wait until at least one task finishes (or nothing can progress), then return the finished results for your review. Add follow-up tasks in the next call (with depends_on keys for ordering); keep calling until done=true and then give the final acceptance. Only the Team Lead may call it. Configure the worker pool (name/provider/model) on the Work Chain bundle page or pass members here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'The overall goal shared by every worker.' },
        tasks: {
          type: 'array',
          description:
            'New tasks to enqueue this round. Workers pull them one at a time; add more tasks on later calls based on the results you reviewed.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt'],
            properties: {
              key: { type: 'string', description: 'Optional stable key, used by depends_on and to dedupe tasks across calls.' },
              title: { type: 'string', description: 'Short task-board subject.' },
              prompt: { type: 'string', description: 'Self-contained instruction for the worker.' },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'Keys of tasks that must complete first (same call or earlier calls).',
              },
            },
          },
        },
        members: {
          type: 'array',
          description: 'Optional worker-pool override; defaults to the configured members.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'provider', 'model'],
            properties: { name: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } },
          },
        },
        wait_seconds: {
          type: 'number',
          description: 'How long this call waits for completions before returning the snapshot (10-600, default 90).',
        },
        max_assign: {
          type: 'number',
          description: 'Maximum tasks to assign in this call (1-12, defaults to maxParallel).',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: formatFlowOutput(value) }],
    },
    async execute(args, exec) {
      const agentTeams = ctx.get('agentTeams')
      if (agentTeams === undefined || agentTeams === null) throw new Error('work_flow 需要内置 Agent Teams：请在插件页启用它')
      const lead = exec.agent
      if (lead === undefined) throw new Error('work_flow 必须由 agent 调用')
      const membership = agentTeams.membership(lead)
      if (membership.role !== 'lead') throw new Error('work_flow 只能由 Team Lead 调用')
      const signal = exec.signal
      throwIfAborted(signal)

      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (task.length === 0) throw new Error('task 不能为空')
      const config = readConfig()
      const members = args.members === undefined ? config.members : normalizeMembers(args.members)
      const waitSeconds = clampInteger(args.wait_seconds, 90, 10, 600)
      const maxAssign = clampInteger(args.max_assign, Math.min(config.maxParallel, 8), 1, 12)
      const notes = []
      const cwd = resolveWorkingDirectory(ctx, lead)
      const { state, save } = flowStateFor(lead)
      const runDir = path.join(cwd, '.workflow', state.runId)
      try {
        fs.mkdirSync(runDir, { recursive: true })
      } catch {
        /* 目录建不了就靠任务板摘要 */
      }

      // 1) 保证 worker 池（同名复用，缺的空槽新建）
      const pool = await ensureFlowPool(ctx, agentTeams, lead, members, notes, signal)
      if (pool.length === 0) throw new Error(`worker 池为空：${notes.join('；') || '没有可用成员'}`)
      state.pool = pool.map((member) => ({ name: member.name, provider: member.provider, model: member.model }))
      save()

      // 2) 入队本轮新任务
      for (const spec of Array.isArray(args.tasks) ? args.tasks : []) {
        if (spec === null || typeof spec !== 'object') continue
        const key = typeof spec.key === 'string' && spec.key.trim().length > 0 ? spec.key.trim() : undefined
        const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : ''
        if (prompt.length === 0) continue
        if (key !== undefined && state.keys[key] !== undefined) {
          notes.push(`任务 key=${key} 已存在（${state.keys[key]}），跳过重复创建`)
          continue
        }
        const title = (typeof spec.title === 'string' && spec.title.trim().length > 0 ? spec.title.trim() : prompt).slice(0, 190)
        const blockedBy = (Array.isArray(spec.depends_on) ? spec.depends_on : [])
          .map((dependency) => state.keys[String(dependency)])
          .filter((id) => id !== undefined)
        try {
          const view = await agentTeams.createTask(lead, {
            subject: title,
            description: escapeTaskText(prompt, TASK_DESCRIPTION_LIMIT),
            blockedBy,
            writeScopes: [],
          })
          state.tasks[view.id] = { key, title, attempts: 0, assignedAt: 0, worker: '', reported: false, createdAt: Date.now() }
          if (key !== undefined) state.keys[key] = view.id
        } catch (error) {
          notes.push(`创建任务「${title}」失败：${errorMessage(error)}`)
        }
      }
      save()

      // 3) 卡死处理：worker 已空闲但任务仍是 in_progress
      const now = Date.now()
      const board = agentTeams.listTasks(lead)
      const rosterNow = agentTeams.listMembers(lead)
      const statusByName = new Map(rosterNow.filter((row) => row.role !== 'lead').map((row) => [row.name, row.status]))
      for (const [taskId, meta] of Object.entries(state.tasks)) {
        const view = board.find((row) => row.id === taskId)
        if (view === undefined || view.status !== 'in_progress' || view.ownerName === undefined) continue
        const ownerStatus = statusByName.get(view.ownerName)
        const stale = meta.assignedAt !== undefined && now - meta.assignedAt > 240_000
        if (ownerStatus !== 'inactive' || stale !== true) continue
        if ((meta.attempts ?? 0) < 2) {
          notes.push(`任务 ${taskId} 的 worker ${view.ownerName} 空闲但任务未完成，重新派发（第 ${(meta.attempts ?? 0) + 1} 次）`)
          try {
            const released = await agentTeams.updateTask(lead, { taskId, expectedRevision: view.revision, action: 'release' })
            await agentTeams.updateTask(lead, { taskId, expectedRevision: released.revision, action: 'reassign', owner: view.ownerName })
            meta.attempts = (meta.attempts ?? 0) + 1
            meta.assignedAt = Date.now()
            const spec = state.pool.find((row) => row.name === view.ownerName) ?? { name: view.ownerName, model: '?' }
            await wakeFlowWorker(ctx, agentTeams, lead, spec, buildFlowWorkerPrompt({ task, prompt: released.description, worker: spec, taskId, title: view.subject, resultFile: path.join(runDir, `${taskId}.md`), runId: state.runId }), signal)
          } catch (error) {
            notes.push(`重新派发 ${taskId} 失败：${errorMessage(error)}`)
          }
        } else {
          notes.push(`任务 ${taskId} 超过重试次数，标记失败`)
          try {
            const latest = agentTeams.getTask(lead, taskId)
            const failure = escapeTaskText(`${latest.description}\n\n【工作流】worker ${view.ownerName} 两次超时未完成，标记失败。`, TASK_DESCRIPTION_LIMIT)
            const edited = await agentTeams.updateTask(lead, { taskId, expectedRevision: latest.revision, action: 'edit', description: failure })
            await agentTeams.updateTask(lead, { taskId, expectedRevision: edited.revision, action: 'complete' })
            state.tasks[taskId].reported = false
          } catch (error) {
            notes.push(`标记任务 ${taskId} 失败时出错：${errorMessage(error)}`)
          }
        }
      }
      save()

      // 4) 把 ready 的待办派给空闲 worker（等待期间 worker 一空闲就继续派）
      const assigned = []
      const assignReadyTasks = async () => {
        const roster = agentTeams.listMembers(lead)
        const idle = roster.filter(
          (row) => row.role !== 'lead' && row.status === 'inactive' && state.pool.some((member) => member.name === row.name),
        )
        if (idle.length === 0) return
        const latest = agentTeams.listTasks(lead)
        const ready = latest.filter(
          (row) =>
            state.tasks[row.id] !== undefined &&
            row.status === 'pending' &&
            row.ownerName === undefined &&
            row.ready === true,
        )
        const pairs = Math.min(maxAssign - assigned.length, idle.length, ready.length)
        for (let index = 0; index < pairs; index += 1) {
          throwIfAborted(signal)
          const worker = idle[index]
          const view = ready[index]
          const meta = state.tasks[view.id]
          const spec = state.pool.find((member) => member.name === worker.name) ?? { name: worker.name, model: '?' }
          try {
            await agentTeams.updateTask(lead, { taskId: view.id, expectedRevision: view.revision, action: 'reassign', owner: worker.name })
            meta.worker = worker.name
            meta.attempts = (meta.attempts ?? 0) + 1
            meta.assignedAt = Date.now()
            await wakeFlowWorker(
              ctx,
              agentTeams,
              lead,
              spec,
              buildFlowWorkerPrompt({
                task,
                prompt: view.description,
                worker: spec,
                taskId: view.id,
                title: view.subject,
                resultFile: path.join(runDir, `${view.id}.md`),
                runId: state.runId,
              }),
              signal,
            )
            assigned.push({ taskId: view.id, title: view.subject, worker: worker.name })
          } catch (error) {
            notes.push(`派发 ${view.id} 给 ${worker.name} 失败：${errorMessage(error)}`)
          }
        }
      }
      await assignReadyTasks()
      save()

      // 5) 等完成/继续派活：至少一条完成、或再也无法推进时返回给 Lead 验收
      const completedNow = []
      const deadline = Date.now() + waitSeconds * 1000
      while (Date.now() < deadline) {
        throwIfAborted(signal)
        await sleep(1500)
        const current = agentTeams.listTasks(lead)
        for (const taskId of Object.keys(state.tasks)) {
          const view = current.find((row) => row.id === taskId)
          if (view === undefined || view.status !== 'completed') continue
          if (state.tasks[taskId].reported === true) continue
          state.tasks[taskId].reported = true
          completedNow.push(collectFlowTask(agentTeams, lead, taskId, runDir))
        }
        save()
        if (completedNow.length > 0) break
        // worker 一空闲就把剩余 ready 任务继续派给它（核心：空闲即复用）
        await assignReadyTasks()
        save()
        const inProgress = current.some((row) => state.tasks[row.id] !== undefined && row.status === 'in_progress')
        const readyPending = current.some(
          (row) => state.tasks[row.id] !== undefined && row.status === 'pending' && row.ownerName === undefined && row.ready === true,
        )
        const roster = agentTeams.listMembers(lead)
        const idleCount = roster.filter(
          (row) => row.role !== 'lead' && row.status === 'inactive' && state.pool.some((member) => member.name === row.name),
        ).length
        const workersBusy = roster.some(
          (row) =>
            row.role !== 'lead' &&
            state.pool.some((member) => member.name === row.name) &&
            (row.status === 'running' || row.status === 'provisioning'),
        )
        if (inProgress !== true && workersBusy !== true) {
          if (readyPending !== true) break
          if (idleCount === 0) {
            notes.push('还有 ready 的待办任务，但没有空闲 worker（可能 worker 异常），先返回快照')
            break
          }
        }
      }

      // 6) 快照返回
      const finalBoard = agentTeams.listTasks(lead)
      const flowTasks = finalBoard.filter((row) => state.tasks[row.id] !== undefined)
      const pending = flowTasks.filter((row) => row.status === 'pending')
      const inProgress = flowTasks.filter((row) => row.status === 'in_progress')
      const completed = flowTasks.filter((row) => row.status === 'completed')
      const finalRoster = agentTeams.listMembers(lead)
      const workers = state.pool.map((member) => {
        const row = finalRoster.find((candidate) => candidate.name === member.name)
        return { name: member.name, model: member.model, status: row?.status ?? 'missing' }
      })
      const done =
        flowTasks.length > 0 &&
        pending.length === 0 &&
        inProgress.length === 0 &&
        workers.every((worker) => worker.status !== 'running' && worker.status !== 'provisioning')
      // 清掉本次未命中的冷 worker 模型提示（已唤醒过的会被 agent/created 消费）。
      for (let index = PENDING_HINTS.length - 1; index >= 0; index -= 1) {
        if (PENDING_HINTS[index].expectedAgentId !== undefined) PENDING_HINTS.splice(index, 1)
      }
      return jsonSafe({
        flowRun: state.runId,
        task,
        workers,
        assigned,
        completedNow,
        remaining: [
          ...pending.map((row) => ({ taskId: row.id, title: row.subject, status: 'pending', ready: row.ready, blockedBy: row.blockedBy })),
          ...inProgress.map((row) => ({ taskId: row.id, title: row.subject, status: 'in_progress', owner: row.ownerName, blockedBy: row.blockedBy })),
        ],
        counts: { total: flowTasks.length, pending: pending.length, inProgress: inProgress.length, completed: completed.length },
        done,
        notes,
        runDir,
      })
    },
  })

  // 6) leader 侧的 aesthetic_advice 工具（审美顾问：一次性子代理、只给建议、不改文件）。
  const disposeAestheticTool = ctx.tools.register({
    name: 'aesthetic_advice',
    description:
      'Ask the independent Aesthetic Advisor — a disposable subagent with its own model — to review what you delivered: a UI file, a screenshot, a URL, or a described design. It returns ranked, concrete visual-design advice (layout/composition, color, type scale, spacing & alignment, consistency, motion & detail) and never edits project files: the full advice is written to .aesthetic/<runId>/advice.md and only a short summary comes back to you. The call hard-stops after timeout_seconds (default 180) and returns whatever advice already reached the result file. Use it when a task includes visual or interface quality (UI pages, charts, slide/visuals, copy layout) and you want a second, independent aesthetic opinion. Only the Team Lead may call it. Default model: opencode-go/deepseek-v4.1-flash. Enable it, change its model, or add your own aesthetic preferences on the Work Chain bundle page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: {
          type: 'string',
          description: 'What to review: a file path, a screenshot path, a URL, or a description of the artifact.',
        },
        focus: {
          type: 'string',
          description: 'What the advisor should pay most attention to (e.g. "color scheme", "spacing and alignment"). Omit for general visual review.',
        },
        context: {
          type: 'string',
          description: 'Background the advisor needs: who the artifact is for, what it must achieve, known constraints.',
        },
        provider: {
          type: 'string',
          description: 'Optional provider override for this call only (defaults to the configured aesthetic provider).',
        },
        model: {
          type: 'string',
          description: 'Optional model override for this call only (defaults to the configured aesthetic model).',
        },
        timeout_seconds: {
          type: 'number',
          description: 'How long the advisor may run, 30-600 seconds. Defaults to 180.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: formatAestheticOutput(value) }],
    },
    async execute(args, exec) {
      const agentTeams = ctx.get('agentTeams')
      if (agentTeams === undefined || agentTeams === null) throw new Error('aesthetic_advice 需要内置 Agent Teams：请在插件页启用它')
      const lead = exec.agent
      if (lead === undefined) throw new Error('aesthetic_advice 必须由 agent 调用')
      const membership = agentTeams.membership(lead)
      if (membership.role !== 'lead') throw new Error('aesthetic_advice 只能由 Team Lead 调用')
      throwIfAborted(exec.signal)

      const config = readConfig()
      if (config.aesthetic.enabled !== true) {
        throw new Error('审美顾问已在插件页关闭：请在「插件 → 工作链 → 审美顾问」里开启后再调用')
      }
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      if (target.length === 0) throw new Error('target 不能为空')
      const focus = typeof args.focus === 'string' ? args.focus.trim() : ''
      const context = typeof args.context === 'string' ? args.context.trim() : ''
      const provider =
        typeof args.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim() : config.aesthetic.provider
      const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : config.aesthetic.model
      const timeoutSeconds = clampInteger(args.timeout_seconds, 180, 30, 600)

      const subagents = ctx.get('subagents')
      if (subagents === undefined || subagents === null) throw new Error('aesthetic_advice 需要 subagents 服务：请在插件页启用它')

      const runId = `${new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19)}-${randomUUID().slice(0, 8)}`
      const cwd = resolveWorkingDirectory(ctx, lead)
      const resultFile = path.join(cwd, AESTHETIC_DIR_NAME, runId, 'advice.md')
      try {
        fs.mkdirSync(path.dirname(resultFile), { recursive: true })
      } catch {
        /* 目录建不出来就让审美顾问自己建 */
      }
      const prompt = buildAestheticPrompt({
        target,
        focus,
        context,
        styleNotes: config.aesthetic.styleNotes,
        resultFile,
        runId,
        timeoutSeconds,
      })
      const outerSignal = exec.signal ?? new AbortController().signal
      const startedAt = Date.now()
      let activation
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: 'aesthetic advisor',
          delivery: 'parent',
          signal: AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutSeconds * 1000)]),
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: lead,
            agentOptions: { provider, model },
          },
        })
      } catch (error) {
        throw new Error(`审美顾问调用失败：${errorMessage(error)}`)
      }

      let result
      let failure
      let budgetTimer
      try {
        // 硬超时：除了把 AbortSignal 传给 startActivation，还在这里用 Promise.race 兜住
        // activation.result（子代理可能不响应 abort）；到点立即释放子代理并返回已落盘的部分建议。
        result = await Promise.race([
          activation.result,
          new Promise((_resolve, reject) => {
            budgetTimer = setTimeout(() => {
              reject(new Error(`审美顾问超时（${timeoutSeconds}s，已中断）`))
            }, timeoutSeconds * 1000)
          }),
        ])
      } catch (error) {
        failure = errorMessage(error)
      } finally {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer)
      }
      const applied = readAppliedRoute(ctx, activation.childId)
      try {
        await activation.dispose()
      } catch {
        /* 释放失败不影响建议 */
      }
      const fileText = readResultFile(resultFile)
      const advice = (fileText ?? blocksToText(result?.output)).trim()
      if (advice.length === 0 && failure !== undefined) throw new Error(`审美顾问调用失败：${failure}`)
      return jsonSafe({
        runId,
        provider,
        model,
        actualProvider: applied?.provider,
        actualModel: applied?.model,
        elapsedMs: Date.now() - startedAt,
        timedOut: /超时|timed? out|abort/iu.test(failure ?? ''),
        ...(failure === undefined ? {} : { error: failure }),
        file: resultFile,
        advice: advice.length > TOOL_OUTPUT_LIMIT ? `${advice.slice(0, TOOL_OUTPUT_LIMIT)}\n…（建议过长已截断）` : advice,
      })
    },
  })

  return () => {
    disposeAestheticTool?.()
    disposeFlowTool?.()
    disposeTool?.()
    disposePrompt?.()
    disposeWorkflowMode?.()
    disposeRoute?.()
    disposeHints?.()
  }
}

/** 读取某个成员会话最近一次模型请求实际使用的路由（用于自检模型锁定是否生效）。 */
function readAppliedRoute(ctx, agentId) {
  try {
    const agents = ctx.get('agents')
    const agent = agentId === undefined ? undefined : agents?.get?.(agentId)
    const config = agent?.session?.requestHeader?.()?.config
    if (config === undefined || config === null) return undefined
    return { provider: config.provider, model: config.model }
  } catch {
    return undefined
  }
}

/** 读取会话工作目录：优先 workingDirectory 服务，其次 session header，最后进程 cwd。 */
function resolveWorkingDirectory(ctx, lead) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && workingDirectory !== null) {
      const dir = workingDirectory.get?.(lead.session)
      if (typeof dir === 'string' && dir.length > 0) return dir
    }
  } catch {
    /* fall through */
  }
  try {
    const cwd = lead.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch {
    /* fall through */
  }
  return process.cwd()
}

export {
  name,
  inject,
  apply,
  CONFIG_ROUTE,
  CONFIG_NAMING_VERSION,
  DEFAULT_MEMBERS,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  GO_MODELS,
  RUNS_DIR_NAME,
  AESTHETIC_DIR_NAME,
  modelMemberName,
  memberNameFromModel,
  defaultMembers,
  migrateMemberNames,
  readConfig,
  writeConfig,
  defaultConfig,
  normalizeConfig,
  normalizeMembers,
  defaultAesthetic,
  normalizeAesthetic,
  buildAestheticPrompt,
  formatAestheticOutput,
  readTeamPolicy,
  teamSnapshot,
  buildModelCatalog,
  installConfigRoute,
}
