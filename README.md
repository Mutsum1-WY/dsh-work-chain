# dsh-work-chain（工作链）

把 **当前会话当 leader**、把**多个指定模型的成员**当手下，靠内置 **Agent Teams**（任务板/名册）做协调的 fan-out 工作流插件。适合「让几个不同模型并行干活、leader 汇总」的场景，比如：并行调研/多视角 review/分工写代码。

成员都是**常驻 Agent Teams 队友**（`team` 模式；v0.7.0 起移除了一次性子代理的 `rotate` 模式）：出现在团队 UI、跨调用同名复用、受设置里智能体上限约束；每个成员按自己配置的模型运行，leader 汇总结果。

> **v0.6.0 新增「审美顾问」**：leader 可以用 `aesthetic_advice` 把成果（网页/界面、截图、URL 或文字描述）交给一个**独立的审美评审子代理**，拿回「总评分数 + 按影响排序的具体修改建议」；它**只给建议、不改任何文件**，开关/模型/审美偏好都在插件配置卡片里。详见下文「审美顾问（`aesthetic_advice`，v0.6.0）」。

> **v0.6.1 改成员命名**：成员名默认直接取所选**模型名**（`deepseek-v4.1-flash` → `deepseek-v4-1-flash`，因为 DSH 队友名只接受 lower-kebab-case）；同名自动编号 `-2`、`-3`…（即二号、三号）。旧配置里的 `pro` / `haiku` / `kimi` / `ds-flash` 读入时会按模型名自动迁移。详见下文「成员命名（v0.6.1）」。

> **v0.7.0 移除 rotate 模式**：只保留 `team`（常驻 Agent Teams 队友）模式。插件页不再有「成员模式」选择，`work_chain` 也没有 `mode` 参数；旧配置里的 `mode` 字段会被忽略。想让成员并行更多就调大设置里的智能体上限，或新开一个对话重置槽位。升级后**刷新一次插件页**（旧缓存页面可能还显示模式单选，它提交的 `mode` 会被新宿主忽略）。

> **v0.8.0 审美顾问算进可调用成员**：启用审美顾问后，它以固定名字 **`aesthetic`** 出现在可调用成员里（插件页成员区会多一行，成员计数含它），**不占团队智能体槽位**。`work_chain` 里用 `subtasks[].member: "aesthetic"`、`work_flow` 里用 `tasks[].member: "aesthetic"` 就能把任务派给它；不点名时不会自动跑。详见下文「审美顾问」与「成员生命周期」。

## 它怎么工作（一句话版）

1. 你在顶栏把当前会话切到想当 leader 的模型；
2. 在「插件」页 → 已安装插件 → **工作链** 的配置卡片里配好 members（provider / model；name 已按模型名自动预填，也可手改）；
3. 对 agent 说「用工作链做 XXX」（或直接让它调 `work_chain`）；
4. 插件为每个成员在团队名册里建/复用 teammate，按各自模型运行；
5. 成员把完整结果写到 `.workchain/<runId>/<member>.md`，并把摘要写进团队任务板；
6. 插件收集结果（任务板摘要 + 结果文件）交回 leader 汇总。

> leader 不是插件另开的进程，就是当前这个会话；它负责拆任务（可在 `work_chain` 的 `subtasks` 里传拆解结果）和最后汇总。

## 为什么能「每个 member 不同模型」

- **成员就是 Agent Teams teammate**：内置 `spawn_teammate` 没有模型参数，插件在 `agent/created`（serial）里认出刚创建的 teammate，在它的 scoped context 上挂 `agent/request` / `system-prompt/assemble` waterfall（与官方 `installModelSelection` 同套路），把每次模型请求固定为配置的 `provider/model`。

因此：

- 每个成员都用**自己配置的模型**运行；
- 成员是真正的 Agent Teams teammate（团队 UI、消息、任务板、跨调用复用）；
- 不 patch 任何共享服务方法，插件卸载/HMR 时相关监听一起回收。

> 注意：team 名册（`list_agents`）里显示的 `model` 可能仍是继承值，工具输出里的模型以成员配置与 `actualModel` 为准。

## 依赖

- DSH 0.2.1-rc.3（Desktop / Web profile）；
- **内置 Agent Teams 组合包已启用**：`@deepseek-ai/dsh-experimental-agent-team-profile`（缺少它时本插件这一行不会激活）。
- **宿主 `llm` 服务（DSH 内置）**：宿主半 `index.js` 的 `inject` 增加了 `'llm'`（浏览器半 `dsh.client.inject` 仍是 `slots`/`locale`，不需要 llm），用于 `ctx.llm.listProviders()` / `ctx.llm.listModels()` 读取成员下拉的供应商与模型目录；宿主未提供时插件会退回兜底目录（见下文）；
- 任意模型 provider；默认成员统一为 `opencode-go` / `deepseek-v4.1-flash`（v0.5.0 起，原 4 个不同模型的默认成员已全部改为 flash）。其它模型（如 `deepseek-v4-pro` / `claude-haiku-5-5` / `kimi-k3`）需 provider 有有效凭据且 DSH LLM 可路由，`minimax-*` 等在 DSH LLM 里不可路由（会失败）时，除非你另外接了对应 provider。
- **审美顾问（v0.6.0）不引入新的外部依赖**：复用已注入的 `subagents`（拉起一次性评审子代理）与 `agentTeams`（校验调用者是 Lead），不需要额外安装包或新服务；但它的模型同样要求 provider 有有效凭据且 DSH LLM 可路由，不可路由时 `aesthetic_advice` 直接报错。

## 已知限制（实测）

- **成员槽位有限且不可回收**：团队 teammate 总数 = 设置里的智能体上限（desktop 默认 8），名册不能删成员。每次调用会先复用同名成员、再用空余槽位；不够就跳过并报告。想扩员就新开一个对话或调大设置上限。
- **内置团队偶发 provisioning 竞态**：`spawnTeammate` 可能报 `initial prompt was not durably accepted`（agent-team 的 `checkpointInitialPrompt` 竞态，与成员模型无关）。插件会自动换名字重试一次；仍失败时该成员标记为 `派活错误`，其余成员照常完成，失败任务会从任务板删除。
- **任务板 description 的 16KB 上限 + 成员可能写不回摘要**：个别模型调用 `team_task_update` 时参数可能丢失，此时任务板 description 仍是原始派活文本；插件会自动退回**用结果文件内容**做摘要（输出里 `summarySource: file`），结果不丢。
- **成员的模型锁定靠 agent scoped event**（`agent/request` + `system-prompt/assemble` waterfall），不 patch 任何共享服务；团队名册里显示的 `model` 可能仍是继承值，以工具输出的 `actualModel` 为准。
- **复用旧成员偶尔会失败**：如果被复用的成员处于异常状态（cold resume / 上一次 turn 失败），唤醒可能失败并表现为该成员超时；换用新会话最稳，失败成员不会自动清理。
- **GUI 配置卡片在页面 boot 时装配**：如果安装/更新后当前页面没出现「工作链成员配置」卡片，刷新页面一次；仍没有就重启一次 DSH（客户端模块图在启动时扫描）。
- **审美顾问是一次性子代理、跑完即释放（v0.6.0）**：不进团队名册、不占团队槽位，也不保留上下文——每次调用都是全新评审（同一对象想复测就再调一次）；它的模型/provider 需 DSH LLM 可路由，不可路由时工具直接报错；建议落在 `.aesthetic/<runId>/advice.md`，该目录与 `.workchain/`、`.workflow/` 同为运行时产物，需自行清理。

## 安装

插件管理器 →「添加插件」→ 填 GitHub 仓库地址（或用「安装第三方插件」填本地插件源码目录）：

```text
https://github.com/Mutsum1-WY/dsh-work-chain
```

安装完成后到「插件」页 → 已安装插件，打开 **工作链**：

- **配置卡片**：编辑 members（增删行、name/provider/model）、`maxParallel`、`timeoutSeconds`，保存即写 `$DSH_HOME/work-chain/config.json`，下一次调用生效，不用重装；
  - **v0.5.0 起 provider / model 是下拉菜单**：选项来自 DSH 当前已配置的供应商与其模型（不再是文本输入）；新增行与默认成员默认为 `opencode-go` / `deepseek-v4.1-flash`；点「重新加载」会重新检测供应商与模型，无需重启。详见下文「成员模型下拉（v0.5.0）」；
  - **v0.6.0 起配置卡片多了「审美顾问」栏**：启用开关（`启用审美顾问`）+ 审美模型供应商/模型下拉（默认 `opencode-go` / `deepseek-v4.1-flash`，与成员下拉用同一份 provider catalog）+ 审美偏好 / 标准 textarea；改完点「保存」即写进 `config.json` 的 `aesthetic`，下一次调用生效，**不用重装、不用重启**。详见下文「审美顾问（`aesthetic_advice`，v0.6.0）」；
- 组合包开关：关闭后工具和配置接口一起卸载，`work_chain` / `work_flow` / `aesthetic_advice` 都不可用；
- 配置页数据接口：同源 `GET/POST /plugin-api/work-chain/config`（Host 的 webServer 提供，仅本机）。

## 成员模型下拉（v0.5.0）

插件页「工作链成员配置」卡片里，成员的 `provider` / `model` 是下拉菜单，选项来自宿主 DSH 当前的供应商与模型。

**数据来源**：宿主 `index.js` 通过 inject 的 `llm` 服务调用 `ctx.llm.listProviders()` 得到供应商列表，再对每个供应商调用 `ctx.llm.listModels(id)` 得到模型列表。`GET /plugin-api/work-chain/config` 返回体里新增 `catalog` 字段。

**catalog 字段结构**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `available` | boolean | 宿主是否成功提供目录（至少一个含模型的供应商）；`false` 时为兜底目录 |
| `groups` | array | 每个供应商一组：`{id, name, models:[{id, name}]}`；模型列表为空的供应商会被跳过 |
| `failures` | array | 单个供应商检测失败/超时的记录：`{id, name, message}`，不影响其它供应商 |
| `defaultProvider` | string | 默认选中的供应商 id |
| `defaultModel` | string | 默认模型 id，固定为 `deepseek-v4.1-flash` |

**默认选择规则**：
- 默认供应商：优先 `opencode-go` 且含 `deepseek-v4.1-flash`；否则任一含该模型的供应商；都没有则取第一组；
- 新增行 / 默认成员：provider = `defaultProvider`，model = `deepseek-v4.1-flash`（若该供应商下没有此模型，则退回该组第一个模型）；name 默认 = 该模型名，重名自动加 `-2`、`-3`…；
- 线上 `config.json` 里已存在的成员保持原值，不会被自动改写（旧版默认名 `pro`/`haiku`/`kimi`/`ds-flash` 例外，见「成员命名（v0.6.1）」）。

**超时与失败降级**：
- 单个供应商的 `listModels` 超时为 **8 秒**（`CATALOG_TIMEOUT_MS`）；超时或报错只进 `failures`，其它供应商照常展示；
- 卡片上方会提示检测到的供应商数量，并列出失败的供应商 id。

**兜底目录**：宿主未提供 `catalog`（旧宿主或 `llm` 服务异常）时，客户端用「当前配置成员 + 默认成员 + 内置模型建议」合成兜底目录（`available=false`，卡片提示 `providerFallback`）。只有连目录都无法合成时，才退回原来的**文本输入**框。

**边界**：
- 下拉只列出 DSH 当前已配置、可读到模型的供应商；没配置凭据的供应商不会出现（或出现在 `failures` 里）；
- 点「重新加载」会重新请求 catalog，不需要重启 DSH 或重装插件；
- 下拉只决定配置的取值，真正能否运行仍取决于该 provider 的凭据与 DSH LLM 路由。

**GET 返回体示例**（节选）：

```json
{
  "members": [
    { "name": "deepseek-v4-1-flash", "provider": "opencode-go", "model": "deepseek-v4.1-flash" }
  ],
  "maxParallel": 4,
  "timeoutSeconds": 600,
  "catalog": {
    "available": true,
    "groups": [
      {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "models": [
          { "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash" },
          { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
        ]
      }
    ],
    "failures": [
      { "id": "some-provider", "name": "Some Provider", "message": "listModels timeout (8000ms)" }
    ],
    "defaultProvider": "opencode-go",
    "defaultModel": "deepseek-v4.1-flash"
  }
}
```

（以上 `models` 仅为示意，实际列表以 DSH 当前配置为准。）

## 成员命名（v0.6.1）

成员名默认**直接取所选模型名**，不用再手动起 `pro` / `haiku` 这种和模型对不上的别名。

- **转换规则**：DSH Agent Teams 只接受 **lower-kebab-case** 队友名（`^[a-z0-9]+(-[a-z0-9]+)*$`，≤64 字符），所以模型 id 里的 `.`、`_`、空格等会折叠成 `-`：
  - `deepseek-v4.1-flash` → `deepseek-v4-1-flash`
  - `gpt-5.6-luna` → `gpt-5-6-luna`
  - `kimi-k3.1-pro` → `kimi-k3-1-pro`
- **重名自动编号**：同一模型出现多次时，第一个用纯模型名，之后依次 `-2`、`-3`…（即二号、三号）。例：4 个默认成员 → `deepseek-v4-1-flash`、`deepseek-v4-1-flash-2`、`deepseek-v4-1-flash-3`、`deepseek-v4-1-flash-4`。
- **跟随模型**：在配置卡片里改 provider / model 时，如果名字是自动生成的（纯模型名或 `-N` 后缀），名字会自动跟着新模型改；手填的名字（如 `writer-1`）保持不动。
- **留空也行（API/工具/配置文件）**：`members[].name` 为空时，宿主会按该成员的模型自动补名（仍按上面的规则去重）；插件页配置卡片会自动预填名字，手工清空会提示「成员名不能为空」。
- **旧配置迁移**：v0.6.0 及更早的默认名 `pro` / `haiku` / `kimi` / `ds-flash` 会在**读配置时自动迁移**（内存里生效，重名同样 `-2`、`-3`…）；下次在插件页「保存」（或切换工作流模式开关）时会把迁移结果与 `namingVersion: 2` 落盘，之后不再迁移。想保留自定义名字，改完保存即可。
- **升级提示（旧对话）**：v0.6.1 前已经建好的 teammate 名字还是旧的（`pro`/`haiku` 等），不会被新名字复用；旧对话里跑 team 模式 / `work_flow` 时若槽位不够会跳过并提示——**新开一个对话**（团队名册从 0 开始）再跑即可。
- 名字仍可手改，但必须满足 lower-kebab-case 且 ≤64 字符——**中文/空格/点号不能直接用在队友名里**，这是 DSH 内置团队的限制。

> 为什么不是中文「一号、二号」？内置 Agent Teams 的 `spawn_teammate` 只接受 lower-kebab-case 名字，中文会被内核以 `TEAM_INVALID_MEMBER_NAME` 拒绝，所以用 `-2`、`-3` 表示二号、三号；工具输出、任务板与团队名册里都沿用这些名字，方便互相对应。

## 用法

对 agent 说：

```text
用工作链并行调研 DeepSeek Harness 的插件市场生态，三个成员分别看官方文档/GitHub/社区，最后汇总。
```

agent 会调用：

```json
{ "task": "调研 DeepSeek Harness 插件市场生态并给出落地建议" }
```

也可以由 leader 先拆任务再调用（推荐，分工更准）：

```json
{
  "task": "给这个仓库做一次上线前 review",
  "subtasks": [
    { "title": "安全审查", "prompt": "审查鉴权、注入、依赖风险", "member": "deepseek-v4-1-flash" },
    { "title": "性能", "prompt": "找性能瓶颈与优化点", "member": "deepseek-v4-1-flash-2" },
    { "title": "文档与体验", "prompt": "检查 README/错误提示/首次体验", "member": "deepseek-v4-1-flash-3" }
  ]
}
```

调用返回：`runId`、`team{maxMembers, limitSource, usedBefore, reused, skipped, virtualMembers}`、`notes`、每个成员的 `taskId/状态/摘要/结果文件内容`、是否超时、耗时；leader 据此做最终汇总。成员结果文件在 `<cwd>/.workchain/<runId>/`；审美顾问（虚拟成员 `aesthetic`）的建议写到 `<cwd>/.aesthetic/<runId>/advice.md`。

审美顾问也可以像普通成员一样派活（v0.8.0，启用审美顾问时）：

```json
{
  "task": "把首页视觉打磨一遍",
  "subtasks": [
    { "title": "审美评审", "prompt": "评审 apps/web/dist/index.html 的配色、间距与字号层级，给 3~5 条具体建议", "member": "aesthetic" },
    { "title": "实现", "prompt": "根据评审建议修改样式", "member": "deepseek-v4-1-flash" }
  ],
  "timeout_seconds": 300
}
```

`subtasks[].member` 写成员名就会点名派给该成员；不写则按顺序补给剩余成员。`aesthetic` 是虚拟成员：宿主直接拉起一次性审美子代理，不占团队智能体槽位，任务板任务由宿主写回摘要并结算。

## 对话页「工作流模式」开关

对话输入框左侧有一个 **工作流** 开关按钮（`conversation.input.left` slot）：

- **开启**：host 会在系统提示里注入一段「工作流模式已开启」的指令——本对话默认把任务拆成 `tasks[]` 用 `work_flow` 调度 worker、每轮验收、补任务，直到 `done:true` 再给最终结论；简单闲聊/单步问答仍可直接回答。
- **关闭**（默认）：不注入，按普通对话方式工作。
- 状态**全局持久化**在 `$DSH_HOME/work-chain/config.json` 的 `workflowMode`（所有对话共用），刷新页面后按钮状态从 `GET /plugin-api/work-chain/workflow-mode` 读取；切换用 `POST {enabled}`。
- 插件卸载/关闭组合包后按钮消失，提示注入也随之移除。

## `work_flow`：动态调度工作流（推荐用于多轮任务）

`work_chain` 是「一轮 fan-out」，而 `work_flow` 是**由 Lead 反复调度、worker 空闲即复用**的完整工作流工具：

1. **建 worker 池**：按配置（或参数 `members`）保证一组常驻 teammate 存在——同名复用并重锁模型，缺的空槽新建（受设置里智能体上限约束）；
2. **入队任务**：本次调用传入 `tasks[]`（可带 `key` 和 `depends_on` 做依赖/DAG），创建到团队任务板；
3. **空闲即派活**：把 `ready` 的待办任务 `reassign` 给空闲 worker 并发消息（被 `reassign` 后任务已是 in_progress，worker 不需要再 claim）；
4. **等完成**：等到至少一条完成（或再也无法推进/超时）就返回给 Lead **验收**，同时返回 worker 状态、剩余待办、进行中任务；
5. **Lead 验收后继续**：需要返工/补充就在下一次调用里传新 `tasks`（`depends_on` 引用之前的 `key`），不需要补充就传空 `tasks` 继续把剩下的派出去；
6. **收尾**：队列清空时返回 `done: true`，由 Lead 做最终验收结论。

worker 全程复用：同一批 teammate 跨多次 `work_flow` 调用持续接活；worker 每次完成的摘要写在团队任务 description、全文写在 `.workflow/<flowRun>/<taskId>.md`。

```json
{
  "task": "给项目做上线前整改",
  "tasks": [
    { "key": "audit", "title": "安全审计", "prompt": "审查鉴权/注入/依赖风险" },
    { "key": "fix",   "title": "整改建议", "prompt": "根据审计结果给整改清单", "depends_on": ["audit"] },
    { "key": "visual", "title": "审美评审", "prompt": "评审首页视觉，给具体修改建议", "member": "aesthetic" }
  ],
  "members": [ { "name": "deepseek-v4-pro", "provider": "opencode-go", "model": "deepseek-v4-pro" } ],
  "wait_seconds": 120,
  "max_assign": 2
}
```

`tasks[].member`（v0.8.0）：点名派给某个成员（写 `"aesthetic"` 即审美顾问虚拟成员；它不占槽位、同时只跑一个审美任务）。不写则任意空闲 worker 先到先得；点名了但该成员不在池里时会退回普通派发并记一条 `notes`。

返回值要点：`assigned`（本轮派发）、`completedNow`（**本轮完成、待你验收**）、`remaining`（待办/进行中）、`counts`、`workers`、`done`、`notes`。下一轮把验收意见变成新任务再调一次即可。

> 提示：worker 池在**新对话**里最容易一次建满（槽位从 0 开始）；老对话槽位满时只能复用已有成员名，或到设置里调大智能体上限。


### 成员生命周期与智能体数量

- 成员都是常驻 Agent Teams teammate：出现在团队 UI、能读写任务板、跨调用同名复用；数量受**设置里的智能体上限**约束，槽位不足时跳过并报告。
- **虚拟成员 `aesthetic`（v0.8.0）**：启用审美顾问时自动算进「可调用成员」列表（插件页成员区多一行、成员计数含它），但**不是 teammate、不占智能体槽位、不出现在团队名册**；派活时由宿主直接拉起一次性审美子代理，任务板任务由宿主 claim 后写摘要并 complete。同一时刻只跑一个审美任务。
- 实时读取内置团队当前生效的 `maxMembers`（`runtime` = 运行中团队服务，设置改动热更新后立即跟随；退回 `config` 读 agent-team 配置行；最后回退 8）。
- 规划顺序：同名 teammate 直接复用（不占新槽位）→ 还有空槽就按该成员模型新建 → 槽位已满则该成员**跳过并报告**（不换模型、不挪用其它成员）。
- 槽位不够时：**新开一个对话**（团队成员从 0 开始），或到**设置**里把智能体上限调大；插件下一次调用/保存即跟随。

### 配置字段

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 插件页 GUI / `$DSH_HOME/work-chain/config.json` | `members[]` | `{name, provider, model}`；`name` 必须 lower-kebab-case 且 ≤64 字符、唯一；留空会自动取模型名；数量上限 64，实际可用数按设置里的智能体上限裁 |
| 同上 | `members`（默认值） | 4 个成员，均为 `opencode-go/deepseek-v4.1-flash`：`deepseek-v4-1-flash` / `-2` / `-3` / `-4`（v0.6.1 起名字取模型名，重名按序号；v0.5.0 起全部为 flash） |
| 同上 | `namingVersion` | 配置命名版本（v0.6.1）：`2` = 成员名由模型名生成；旧配置缺该字段时读入自动迁移并补成 `2` |
| 同上 | `maxParallel` | 1~8：`work_flow` 每轮默认派活的成员数（可通过 `max_assign` 覆盖） |
| 同上 | `timeoutSeconds` | 30~3600，整条链的总等待预算（默认 600 秒） |
| 同上 | `aesthetic` | `{enabled, provider, model, styleNotes}`（v0.6.0 审美顾问）：默认 `true` / `opencode-go` / `deepseek-v4.1-flash` / `''`；启用时同时作为可调用虚拟成员 `aesthetic`（v0.8.0，不占槽位）；`styleNotes` 是拼进审美顾问提示词的偏好文本，保存时截到 **4000 字**；`enabled` 只在显式 `false` 时关闭 |
| `work_chain` 参数 | `members` | 本次调用临时覆盖成员；含 `{name:"aesthetic"}` 时加入审美顾问虚拟成员 |
| 同上 | `subtasks[]` | leader 拆好的分工；`subtasks[].member` 可按成员名点名（写 `aesthetic` 派给审美顾问） |
| 同上 | `timeout_seconds` | 本次调用覆盖等待预算 |

### 成员复用

- **同名成员复用**：config 里 `name` 稳定的成员第二次调用会被直接复用（`send_message` 唤醒，不新建、不占槽位），并重新锁定成当前配置的模型；同一次调用里每个成员只会用一次。
- **槽位不足则跳过**：不会换模型、不挪用别的 teammate，只在输出里报告该成员被跳过；**新开一个对话**即可重置槽位。
- 名册里 `status=failed` 的成员不复用；重名时插件会自动加后缀（`-2`、`-r2`）。
- 成员名默认就是模型名（`deepseek-v4-1-flash` 等），换模型时自动跟随；同名按 `-2`、`-3` 编号，看名字就知道每个 teammate 跑的是什么模型。

## 审美顾问（`aesthetic_advice`，v0.6.0）

一个**独立的审美评审子代理**：leader 把成果交给它，它按视觉/界面审美标准审一遍，给出**可执行的修改建议**。适合网页/界面（含设计稿截图）、游戏画面、图表、PPT/文档视觉排版等。

- **独立**：它看不到 leader 的上下文，只根据你传的 `target` / `focus` / `context` 和配置里的审美偏好自己去看（可以读文件、看图片、浏览网页）；
- **只给建议、不改文件**：不会改代码、也不会改待审对象；完整建议写在 `.aesthetic/<runId>/advice.md`，工具输出只回给 leader 摘要 + 建议文件路径；
- **一次性子代理**：每次调用新建、跑完即释放（不进团队名册、不占团队常驻槽位）；评审过程可能用到文件/截图/浏览器等工具，默认 180 秒预算，到点硬中断并返回已落盘的部分建议；
- **leader 专用**：只有 Team Lead 能调用，teammate 调用会报「只能由 Team Lead 调用」；什么时候审、审完要不要采纳、这次用哪个模型，都由 leader（当前会话）决定；
- **受插件页配置控制**：启用开关关闭时调用会直接报错并提示去插件页开启；默认模型 `opencode-go` / `deepseek-v4.1-flash`，可在配置卡片改；「审美偏好 / 标准」会拼进它的提示词（留空则只用通用标准）。

### 作为可调用成员（v0.8.0）

启用审美顾问后，它在可调用成员里以固定名字 **`aesthetic`** 出现（插件页成员区多一行只读成员，成员计数含它），**不占团队智能体槽位**。点名才会跑：

- **`work_chain`**：`subtasks[].member` 写 `"aesthetic"`，可与其他成员混用；`prompt` 会作为审美评审的待审对象（target），总任务作为背景（context）；建议写到 `.aesthetic/<runId>/advice.md`，任务板任务由宿主写摘要并 complete。
- **`work_flow`**：`tasks[].member` 写 `"aesthetic"`；宿主在常驻 worker 之外单独执行这个审美任务（同时只跑一个），建议写到 `.workflow/<flowRun>/<taskId>.md`，完成后作为 `completedNow` 返回（owner 显示 `aesthetic`）。
- `members` 参数里也可以写一项 `{ "name": "aesthetic" }`（provider/model 会用插件页「审美顾问」的配置），表示本次调用确保虚拟成员在册。
- 不点名时不会自动跑；单独的 `aesthetic_advice` 工具用法不受影响。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `target` | string | 是 | 要审的对象：文件路径、截图路径、URL，或一段描述 |
| `focus` | string | 否 | 重点关注什么（如「配色」「间距与对齐」「字号层级」）；不传走通用审美维度（构图/布局、配色、字体与字号层级、间距与对齐、一致性、动效与细节） |
| `context` | string | 否 | 背景：给谁看、要达到什么目的、已知约束 |
| `provider` | string | 否 | 本次调用临时覆盖 provider（默认用配置值） |
| `model` | string | 否 | 本次调用临时覆盖模型（默认用配置值） |
| `timeout_seconds` | number | 否 | 本次等待预算，30~600 秒，默认 180；到点会**硬中断**，子代理已写进结果文件的部分建议照常返回 |

```json
{
  "target": "apps/web/dist/index.html",
  "focus": "配色与字号层级",
  "context": "面向开发者的设置页，信息密度高，希望克制但不冷淡"
}
```

（也可以只传 `target`；`target` 是描述时，它会按描述评审，不会假装看到了不存在的文件。）

**时间预算**：`timeout_seconds` 会同时写进它的提示词（让它优先给结论、不要跑超出预算的长时间测评），并在宿主侧**硬中断**——到点仍未完成时返回 `timedOut: true`，它已经写进 `advice.md` 的部分建议照常返回；要更深的评审（如多分辨率真机截图）就把 `timeout_seconds` 调到 300~600。

### 它给出的建议结构

写进 `advice.md`（工具输出摘要同结构）的内容固定是：

1. **一句总评 + 0~10 分**；
2. **按影响从大到小排序的问题清单**，每条写清「现象 → 为什么不好看 → 怎么改」，修改具体到颜色 / 间距 / 字号 / 层级 / 动效 / 对齐；
3. **2~4 条加分项**（已经做得好的，或低成本见效的）；
4. **给 leader 的采纳建议**：哪些必改、哪些可选，并说明理由。

### 返回字段

| 字段 | 说明 |
| --- | --- |
| `runId` | 本次评审 id（格式同 `work_chain`） |
| `provider` / `model` | 本次使用的（配置值或参数覆盖后的）路由 |
| `actualProvider` / `actualModel` | 子代理自报的实际请求路由（读不到时缺省） |
| `elapsedMs` | 耗时（毫秒） |
| `timedOut` | 是否因超时/中断结束 |
| `error` | 有异常但已经拿到建议时附带的错误消息（没有则不出现） |
| `file` | 建议文件绝对路径 `<cwd>/.aesthetic/<runId>/advice.md` |
| `advice` | 建议正文（工具输出里截到 48000 字符，完整内容看文件） |

工具输出给 leader 的首行是 `【审美顾问】<provider>/<model> · <N>s · 建议文件 <path>`，空行后是建议正文。

### 结果文件

- 建议写在**当前会话工作目录**下的 `.aesthetic/<runId>/advice.md`；每次调用一个独立 `runId` 目录，互不覆盖；
- 与 `.workchain/`、`.workflow/` 一样是运行时产物，按需自行清理；关闭审美顾问不影响 `work_chain` / `work_flow`。

## 结果与任务板

- **任务板**：每次 `work_chain` 会为每个成员建一条团队任务（subject=分工标题）。成员 claim → 编辑 description 写摘要 → complete，进度在团队任务板里可见；派活失败的任务会被删除，避免留下永远 pending 的脏任务。
- **结果文件**：成员把完整 Markdown 写在 `.workchain/<runId>/<member>.md`（工具输出会读回；太长会截断，完整内容看文件）。
- **审美建议文件（v0.6.0）**：`aesthetic_advice` 的建议写在 `<cwd>/.aesthetic/<runId>/advice.md`，不经过团队任务板；工具输出给 leader 的是「首行路由/用时/文件路径 + 建议正文」。完整内容看文件。
- **审美顾问虚拟成员（v0.8.0）**：`work_chain` 里点名 `aesthetic` 的任务，任务板仍会建一条任务（可见进度），由宿主 claim → 写摘要 → complete；结果按 `completed` 计。`work_flow` 里点名 `aesthetic` 的任务结果文件在 `.workflow/<flowRun>/<taskId>.md`。
- **超时**：到 `timeoutSeconds` 仍未完成会返回 `timedOut: true` 并打断仍在运行的成员，已完成的成员结果照常返回。

## 排障

| 现象 | 原因/处理 |
| --- | --- |
| 插件页看不到「工作链」配置卡片 | 组合包未启用 / 客户端半没加载：刷新页面；看组合包详情页诊断 |
| 配置页报 `fetch` 失败 | 宿主路由 `/plugin-api/work-chain/config` 未注册（组合包未启用）或页面来自旧缓存：刷新；必要时关闭再开启组合包 |
| `work_chain` 报「需要内置 Agent Teams」 | 到插件页启用 `@deepseek-ai/dsh-experimental-agent-team-profile`，或确认当前会话是团队 Lead |
| 报 `只能由 Team Lead 调用` | members 是 teammate，teammate 不能发起新的工作链；由 Lead 调用 |
| `aesthetic_advice` 报「审美顾问已在插件页关闭」（v0.6.0） | 到「插件」页 → 工作链配置卡片的「审美顾问」栏勾上「启用审美顾问」并保存，然后重新调用；也可检查 `config.json` 里 `aesthetic.enabled` 是否为 `true` |
| `aesthetic_advice` 报「只能由 Team Lead 调用」（v0.6.0） | 当前会话不是 Lead（是 teammate/子代理）：换成由你发起的会话（那就是 Lead）再调用 |
| `aesthetic_advice` 返回 `timedOut: true` / 报「审美顾问调用失败」 | 模型不可路由（provider 无凭据）或超时：在配置卡片换一个可路由的审美模型，或把 `timeout_seconds` 调大（30~600）；`error` 字段里是原始错误 |
| `work_chain` 报「审美顾问未启用」（v0.8.0） | 在 `subtasks[].member` / `members` 里点名了 `aesthetic`，但插件页「审美顾问」开关是关闭的：开启后重试，或去掉点名 |
| 点名 `aesthetic` 的任务一直 pending（v0.8.0） | 任务板只允许 `in_progress` 的任务 complete；v0.8.0 会由宿主先 claim 再写摘要/complete。若仍卡住：确认组合包已重载到 v0.8.0，必要时在任务板手动 claim → complete |
| 点名 `aesthetic` 的成员提示「审美顾问超时」 | 审美子代理到预算上限被硬中断：已写进 advice/结果文件的部分建议照常返回，任务仍会结算；把链的 `timeout_seconds` 或单次审美预算调大（≤600） |
| 某个成员 spawn 失败 | 模型/provider 在该会话不可用（`opencode-go` 需要有效凭据）；在配置里换模型后重试；错误会写进该成员条目 |
| 全部成员都没跑起来 | 看 `list_bundles` 的 `subagent-spawn-in-process` 行是否活跃；设置里的智能体上限是否已满（默认 8） |
| 结果文件缺失但任务完成 | 成员偷懒没写文件；摘要仍在任务板里，工具输出会标 `结果文件缺失` |
| 下拉里没有某个供应商 | 该供应商未在 DSH 设置中配置或凭据无效：到 DSH 设置里配置该供应商/凭据，然后在插件卡片点「重新加载」 |
| provider 行显示 `providerFallback` / 当前值（非下拉选项） | 宿主 catalog 没读到（宿主未更新或 LLM 服务异常）：点「重新加载」；仍不行就重装组合包或重启 DSH |
| 升级 DSH 后失效 | 本插件依赖 `subagents.startActivation`（审美顾问）与内置 Agent Teams 的内部契约做模型透传；升级后先用一个成员做冒烟测试，必要时按新契约调整 |

## 卸载

插件页 → 已安装插件 → 工作链 → 卸载。配置留在 `$DSH_HOME/work-chain/config.json`（可手动删），成员结果留在各会话工作目录的 `.workchain/` 下。

## 开发/自检

- 改完先跑语法检查：`node --check index.js`、`node --check client.js`（两者都必须通过，且都是零第三方依赖的纯 JS）；
- 宿主：`index.js`（零第三方依赖，`node --check index.js`）；
- 浏览器半：`client.js`（注册 `plugins.bundle.config` 配置页，`node --check client.js`）；
- 冒烟脚本：可以在临时目录写一个一次性脚本，覆盖 catalog 规范化/默认选择/下拉选项等纯函数（`buildModelCatalog` 与 client 的 `interpretCatalog`/`pickDefaultProvider`/`providerSelectOptions`），不要提交到仓库；
- **审美顾问自检（v0.6.0）**：宿主半写一个一次性脚本（fake ctx + fake activation + 临时 `DSH_HOME`，覆盖默认配置/规范化/工具注册/参数 schema/execute 正常与覆盖/非 lead 拒绝/插件页关闭/`styleNotes` 生效/GET defaults/POST 回显）；浏览器半另写一个一次性脚本（fake React 物化配置卡片，覆盖 aesthetic 的解析/规范化/校验/字典键/渲染/保存载荷）。两个脚本只放在本地临时目录、不提交仓库，跑完不污染真实配置；
- 配置接口：`GET/POST /plugin-api/work-chain/config`（同源，仅本机 Web 服务提供）。
- **建议的冒烟测试**：插件改动的冒烟测试**只跑一个成员**（`opencode-go/deepseek-v4.1-flash`，成员名默认 `deepseek-v4-1-flash`），不再跑多模型/多成员/压测；单成员一次约 20~30s。命令形态：

  ```json
  { "task": "冒烟测试：20 字内回答 1+1 并自报模型",
    "members": [ { "name": "deepseek-v4-1-flash", "provider": "opencode-go", "model": "deepseek-v4.1-flash" } ],
    "timeout_seconds": 120 }
  ```

  只有改动涉及多成员调度（复用/借用/任务板结算）时，才按需补一次多成员测试。

- **虚拟成员自检（v0.8.0）**：可以用 fake ctx + fake Agent Teams/subagents 的一次性脚本覆盖：`aestheticMember`/`callableMembers`/`normalizeMemberOverride`/`assignSubtasks` 纯函数，`work_chain` 点名 `aesthetic`（不 spawn teammate、任务板 claim→编辑→complete、结果在 `.aesthetic/`），`work_flow` 点名 `aesthetic`（虚拟 worker、`completedNow` owner=aesthetic、`done:true`），以及审美顾问关闭时点名报错。脚本只放临时目录、不提交仓库。
- 审美顾问的真机验证不需要成员：一次 `aesthetic_advice` 调用即可（`target` 传一个本地文件路径，`timeout_seconds` 给 60~120），它不占团队常驻槽位；虚拟成员 `aesthetic` 也可以单独点名跑一条 `work_chain`/`work_flow` 任务验证（同样不占槽位）。

MIT License，见 `LICENSE`。第三方插件形态与 `dsh-web-search-opencode` 一致，安装/卸载都走插件管理器。
