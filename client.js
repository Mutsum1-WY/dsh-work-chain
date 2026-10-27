// dsh-work-chain browser half —— 手写的惰性 CJS 工厂（DSH 0.2.x 客户端插件格式）。
//
// v0.5.0：插件页成员的 provider / model 改从宿主 catalog 下拉（ctx.llm 实时供应商/模型
// 目录），默认 deepseek-v4.1-flash；宿主未提供 catalog 时用配置成员 + 默认成员 +
// MODEL_SUGGESTIONS 合成兜底目录，连兜底都没有才退回文本输入。
//
// v0.6.0：配置卡片新增「审美顾问」栏（启用开关 / 审美模型供应商 / 审美模型 / 审美偏好
// 文本），与宿主半的 config.aesthetic 对应；leader 用 aesthetic_advice 工具征询审美建议，
// 建议只回给 leader，由 leader 决定是否采纳。
//
// 客户端模块系统（window.__ModuleLoader__）只登记 factory，物化时才执行闭包；factory
// 返回 { apply, inject }，内核把它当客户端插件挂载。浏览器模块 id 必须等于包名。
//
// 页面注册进「插件」页 → 已安装插件 → dsh-work-chain 组合包页里的配置卡片：
//   - `plugins.bundle.config` 是 keyed slot：key 必须等于组合包的 npm 包名，插件页在
//     组合包详情里以 { view: 'page' } 渲染它（位于描述与组件行之间）；
//   - 带 `locale` 注册时宿主会注入 props.t（本文件注册了 zh/en 字典）；
//   - 配置读写走宿主半 index.js 注册的同源 HTTP 路由：GET/POST
//     /plugin-api/work-chain/config；客户端只做展示、预校验与错误提示，真正的
//     校验与持久化在宿主半。
//
// 防御策略：所有 fetch/JSON/结构问题都变成可读错误，绝不抛出到页面（client 半激活
// 失败会让整个 GUI 启动失败，因此 factory 与 apply 里不做任何易抛的副作用）。
window.__ModuleLoader__.load({
  id: 'dsh-work-chain',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    // 平台模块表（PLATFORM_MODULES）里的基线模块；个别部署缺失时退化为带主题变量的
    // 原生元素，保证卡片仍可渲染。
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (_error) {
      primitives = null;
    }
    const PrimitiveButton =
      primitives !== null && typeof primitives.Button !== 'undefined' ? primitives.Button : null;
    const PrimitiveInput =
      primitives !== null && typeof primitives.Input !== 'undefined' ? primitives.Input : null;
    const PrimitiveTextarea =
      primitives !== null && typeof primitives.Textarea !== 'undefined' ? primitives.Textarea : null;

    /** 语言字典命名空间，也是 slot 注册的 locale 名。 */
    const NS = 'dsh-work-chain';
    /** 组合包 npm 包名 == plugins.bundle.config 的 dispatch key == 浏览器模块 id。 */
    const PACKAGE_NAME = 'dsh-work-chain';
    /** 宿主半 index.js 注册的配置路由（同源，无鉴权）。 */
    const CONFIG_ENDPOINT = '/plugin-api/work-chain/config';
    /** 「工作流模式」全局开关路由（GET 读、POST {enabled} 写；v0.4.0）。 */
    const WORKFLOW_ENDPOINT = '/plugin-api/work-chain/workflow-mode';
    /** 对话页快捷开关的 slot / 注册 id（见 ui-conversation slot 契约）。 */
    const WORKFLOW_SLOT = 'conversation.input.left';
    const WORKFLOW_SLOT_ID = 'work-flow-mode';
    const DEFAULT_PROVIDER = 'opencode-go';
    const DEFAULT_MODEL = 'deepseek-v4.1-flash';
    /** 宿主 defaults.models 缺失时的兜底下拉建议（与宿主 GO_MODELS 一致）。 */
    const MODEL_SUGGESTIONS = Object.freeze([
      'deepseek-v4.1-flash',
      'minimax-m3.1-flash',
      'minimax-m3',
      'claude-haiku-5-5',
      'deepseek-v4-pro',
      'minimax-m2.5',
      'minimax-m2.7',
      'kimi-k3',
      'kimi-k3.1-pro',
      'grok-4.7',
      'gemini-4-argon',
    ]);
    /** 宿主半 index.js 的 MEMBER_NAME；客户端提前校验以便即时提示。 */
    const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
    /**
     * 输入范围：与宿主半 index.js（v0.2.0）对齐。
     * - members：rotate 模式固定最多 16（host 轮换一次最多跑 16 个）；team 模式的
     *   实际上限来自 GET team.maxMembers（设置里的智能体上限，最高 64），缺失回退 8；
     * - maxParallel 宿主固定 1~8（rotate 每批 = maxParallel，最多 8）；
     * - timeoutSeconds 宿主是 30~3600。
     */
    const LIMITS = Object.freeze({
      members: Object.freeze({ min: 1, max: 64, fallback: 8, rotateMax: 16 }),
      maxParallel: Object.freeze({ min: 1, max: 8, fallback: 4 }),
      timeoutSeconds: Object.freeze({ min: 30, max: 3600, fallback: 600 }),
    });
    /** 成员模式：rotate = 一次性子代理轮换（默认）；team = 常驻 Agent Teams 队友。 */
    const MODES = Object.freeze(['rotate', 'team']);
    const DEFAULT_MODE = 'rotate';

    /** 非 team 一律当 rotate（与宿主 normalizeConfig 一致）。 */
    function normalizeMode(value) {
      return value === 'team' ? 'team' : DEFAULT_MODE;
    }

    /**
     * 规范化宿主 catalog：{available,groups:[{id,name,models:[{id,name}]}],failures,defaultProvider,defaultModel}。
     * 缺失/非法返回空目录；groups 中 id 为空或模型为空的跳过；模型项支持字符串或 {id,name}，去重；
     * failures 只保留有 id 的项 {id,message}。
     */
    function interpretCatalog(raw) {
      const empty = { available: false, groups: [], failures: [], defaultProvider: '', defaultModel: '' };
      if (!isRecord(raw)) return empty;
      const groups = [];
      const sourceGroups = Array.isArray(raw.groups) ? raw.groups : [];
      for (const groupRaw of sourceGroups) {
        if (!isRecord(groupRaw)) continue;
        const id = typeof groupRaw.id === 'string' ? groupRaw.id.trim() : '';
        if (id === '') continue;
        const name = typeof groupRaw.name === 'string' && groupRaw.name.trim() !== '' ? groupRaw.name.trim() : id;
        const seen = new Set();
        const models = [];
        const sourceModels = Array.isArray(groupRaw.models) ? groupRaw.models : [];
        for (const modelRaw of sourceModels) {
          let modelId = null;
          let modelName = null;
          if (typeof modelRaw === 'string') {
            modelId = modelRaw.trim();
          } else if (isRecord(modelRaw)) {
            modelId = typeof modelRaw.id === 'string' ? modelRaw.id.trim() : '';
            modelName = typeof modelRaw.name === 'string' && modelRaw.name.trim() !== '' ? modelRaw.name.trim() : null;
          }
          if (modelId === null || modelId === '') continue;
          if (seen.has(modelId)) continue;
          seen.add(modelId);
          models.push({ id: modelId, name: modelName === null ? modelId : modelName });
        }
        if (models.length === 0) continue;
        groups.push({ id, name, models });
      }
      const failures = [];
      if (Array.isArray(raw.failures)) {
        for (const failRaw of raw.failures) {
          if (!isRecord(failRaw)) continue;
          const id = typeof failRaw.id === 'string' ? failRaw.id.trim() : '';
          if (id === '') continue;
          const message = typeof failRaw.message === 'string' ? failRaw.message : '';
          failures.push({ id, message });
        }
      }
      const defaultProvider = typeof raw.defaultProvider === 'string' ? raw.defaultProvider.trim() : '';
      const defaultModel = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '';
      // available 只表示「宿主真的从 DSH 读到了供应商目录」；兜底合成的目录 available=false。
      return { available: raw.available !== false && groups.length > 0, groups, failures, defaultProvider, defaultModel };
    }

    /** 选默认供应商组：优先 id===DEFAULT_PROVIDER 且含 DEFAULT_MODEL → 任意含 DEFAULT_MODEL → 第一组；返回组 id 或 ''。 */
    function pickDefaultProvider(groups) {
      if (!Array.isArray(groups) || groups.length === 0) return '';
      const hasModel = (group) => Array.isArray(group.models) && group.models.some((model) => model.id === DEFAULT_MODEL);
      const exact = groups.find((group) => group.id === DEFAULT_PROVIDER && hasModel(group));
      if (exact !== undefined) return exact.id;
      const any = groups.find((group) => hasModel(group));
      if (any !== undefined) return any.id;
      return groups[0].id;
    }

    /** 返回该 provider 的 models 数组副本，找不到返回 []。 */
    function modelOptionsFor(groups, provider) {
      if (!Array.isArray(groups)) return [];
      const group = groups.find((candidate) => candidate.id === provider);
      return group !== undefined && Array.isArray(group.models) ? group.models.slice() : [];
    }

    /**
     * 为指定 provider 挑一个 model：无模型返回 ''；preferredModel 在列表里则保留；
     * 否则优先 DEFAULT_MODEL；再否则第一个 model id。
     */
    function pickModelForProvider(groups, provider, preferredModel) {
      const models = modelOptionsFor(groups, provider);
      if (models.length === 0) return '';
      if (preferredModel !== undefined && preferredModel !== null && preferredModel !== '') {
        const kept = models.find((model) => model.id === preferredModel);
        if (kept !== undefined) return kept.id;
      }
      const flash = models.find((model) => model.id === DEFAULT_MODEL);
      if (flash !== undefined) return flash.id;
      return models[0].id;
    }

    /** 供应商下拉选项：current 不在其中时前置「当前值」项。 */
    function providerSelectOptions(t, catalog, current) {
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
      const options = groups.map((group) => ({
        value: group.id,
        label: group.name === group.id ? group.id : `${group.name} (${group.id})`,
      }));
      if (current !== undefined && current !== null && current !== '' && !options.some((option) => option.value === current)) {
        options.unshift({ value: current, label: `${current} (${t('providerCurrentOption')})` });
      }
      return options;
    }

    /** 模型下拉选项：current 不在其中时前置「当前值」项。 */
    function modelSelectOptions(t, models, current) {
      const list = Array.isArray(models) ? models : [];
      const options = list.map((model) => ({
        value: model.id,
        label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
      }));
      if (current !== undefined && current !== null && current !== '' && !options.some((option) => option.value === current)) {
        options.unshift({ value: current, label: `${current} (${t('providerCurrentOption')})` });
      }
      return options;
    }

    /** 宿主未提供 catalog 时，用配置成员 + 默认成员 + MODEL_SUGGESTIONS 合成兜底目录。 */
    function synthesizeCatalog(members, defaultMembers, models) {
      const groups = [];
      const byProvider = new Map();
      const ensure = (id) => {
        if (byProvider.has(id)) return byProvider.get(id);
        const entry = { id, name: id, models: [] };
        byProvider.set(id, entry);
        groups.push(entry);
        return entry;
      };
      const pushModel = (group, modelId) => {
        if (group.models.some((model) => model.id === modelId)) return;
        group.models.push({ id: modelId, name: modelId });
      };
      const addMember = (member) => {
        if (!isRecord(member)) return;
        const provider = typeof member.provider === 'string' ? member.provider.trim() : '';
        const model = typeof member.model === 'string' ? member.model.trim() : '';
        if (provider === '' || model === '') return;
        pushModel(ensure(provider), model);
      };
      if (Array.isArray(members)) for (const member of members) addMember(member);
      if (Array.isArray(defaultMembers)) for (const member of defaultMembers) addMember(member);
      // 把 models 列表与 MODEL_SUGGESTIONS 全部挂到 DEFAULT_PROVIDER 组（去重）。
      const defaultGroup = ensure(DEFAULT_PROVIDER);
      const extra = [];
      if (Array.isArray(models)) for (const entry of models) if (typeof entry === 'string' && entry.trim() !== '') extra.push(entry.trim());
      for (const entry of MODEL_SUGGESTIONS) extra.push(entry);
      for (const modelId of extra) pushModel(defaultGroup, modelId);
      return interpretCatalog({
        available: false,
        groups,
        failures: [],
        defaultProvider: pickDefaultProvider(groups),
        defaultModel: DEFAULT_MODEL,
      });
    }

    // 跟随应用主题的 CSS 变量；变量或 fallback 都避免写死深色。
    const COLOR = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(120,120,120,0.92))',
      faint: 'var(--dsw-alias-label-tertiary, rgba(120,120,120,0.75))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
      borderStrong: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.34))',
      danger: 'var(--dsw-alias-label-error, #d93025)',
      success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warn-primary, #b26a00)',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      base: 'var(--dsw-alias-bg-layer-1, transparent)',
    };

    const STYLE = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: COLOR.text,
        fontSize: 13,
        lineHeight: 1.5,
      },
      notice: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '8px 10px',
        borderLeft: `2px solid ${COLOR.accent}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: COLOR.layer,
      },
      noticeTitle: { fontSize: 13, fontWeight: 600 },
      noticeText: { fontSize: 12, color: COLOR.muted },
      warnBox: {
        padding: '6px 10px',
        borderLeft: `2px solid ${COLOR.warn}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: COLOR.layer,
        color: COLOR.text,
        fontSize: 12,
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        borderBottom: `1px solid ${COLOR.border}`,
        paddingBottom: 4,
      },
      sectionTitle: { fontSize: 13, fontWeight: 600 },
      sectionMeta: { fontSize: 11.5, color: COLOR.muted },
      tableHead: {
        display: 'grid',
        gridTemplateColumns: 'minmax(110px, 0.9fr) minmax(110px, 0.85fr) minmax(150px, 1.4fr) auto',
        gap: 8,
        alignItems: 'center',
        color: COLOR.muted,
        fontSize: 11.5,
      },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(110px, 0.9fr) minmax(110px, 0.85fr) minmax(150px, 1.4fr) auto',
        gap: 8,
        alignItems: 'start',
      },
      cell: { display: 'grid', minWidth: 0 },
      cellAction: { display: 'flex', alignItems: 'center' },
      rowError: {
        gridColumn: '1 / -1',
        marginTop: -2,
        color: COLOR.danger,
        fontSize: 11.5,
      },
      hint: { fontSize: 11.5, color: COLOR.muted },
      hintFaint: { fontSize: 11.5, color: COLOR.faint },
      error: { fontSize: 11.5, color: COLOR.danger },
      fields: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 10,
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldLabel: { fontSize: 12, color: COLOR.muted },
      actionBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        paddingTop: 2,
      },
      status: { fontSize: 11.5, color: COLOR.muted },
      statusError: { fontSize: 12, color: COLOR.danger },
      statusSuccess: { fontSize: 11.5, color: COLOR.success },
      empty: { fontSize: 12, color: COLOR.muted, padding: '6px 0' },
      capacity: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '4px 10px',
        padding: '6px 10px',
        border: `0.5px solid ${COLOR.border}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        fontSize: 11.5,
        color: COLOR.muted,
      },
      capacityValue: { color: COLOR.text },
      modeGroup: { display: 'grid', gap: 8 },
      modeOption: {
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        alignItems: 'start',
        gap: 8,
        padding: '8px 10px',
        border: `0.5px solid ${COLOR.border}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
      },
      modeOptionActive: {
        border: `0.5px solid ${COLOR.accent}`,
        background: COLOR.layer,
      },
      modeRadio: {
        marginTop: 2,
        accentColor: COLOR.accent,
      },
      checkRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        cursor: 'pointer',
      },
      checkbox: {
        marginTop: 2,
        accentColor: COLOR.accent,
      },
      modeOptionBody: { display: 'flex', flexDirection: 'column', gap: 2 },
      modeOptionTitle: { fontSize: 12.5, fontWeight: 600 },
      modeOptionText: { fontSize: 11.5, color: COLOR.muted },
      failedBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        border: `0.5px solid ${COLOR.borderStrong}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
      },
    };

    // 原生元素兜底样式（primitives 缺失时使用）。
    const FALLBACK_INPUT_STYLE = {
      boxSizing: 'border-box',
      width: '100%',
      height: 32,
      padding: '0 8px',
      border: `0.5px solid ${COLOR.borderStrong}`,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: COLOR.base,
      color: COLOR.text,
      font: 'inherit',
      fontSize: 13,
      outline: 'none',
    };
    const FALLBACK_SELECT_STYLE = {
      ...FALLBACK_INPUT_STYLE,
      appearance: 'auto',
      paddingRight: 6,
      cursor: 'pointer',
    };
    const FALLBACK_TEXTAREA_STYLE = {
      ...FALLBACK_INPUT_STYLE,
      height: 'auto',
      minHeight: 66,
      padding: '6px 8px',
      resize: 'vertical',
      fontFamily: 'inherit',
      lineHeight: 1.5,
    };
    const FALLBACK_BUTTON_STYLE = {
      boxSizing: 'border-box',
      height: 28,
      padding: '0 10px',
      border: `0.5px solid ${COLOR.borderStrong}`,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'transparent',
      color: COLOR.text,
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    };
    const FALLBACK_BUTTON_PRIMARY_STYLE = {
      ...FALLBACK_BUTTON_STYLE,
      border: 'none',
      background: COLOR.accent,
      color: 'var(--dsw-alias-label-primary-inverted, #fff)',
    };

    const zh = {
      summary: '配置工作链成员（name / provider / model）与并行、超时参数。',
      leaderNote: '当前会话模型就是 leader（在顶栏切换模型），leader 负责拆任务与汇总。',
      leaderNoteHint:
        '下面配置的是各成员（Agent Teams teammates）的模型和运行参数；任务按 fan-out 分给成员，成员通过内置 Agent Teams 的 task 板与消息协作。',
      teamUnavailable:
        '内置 Agent Teams 当前不可用（team.available=false），配置仍可保存，但成员任务要等 Teams 可用后才会执行。',
      capacityTemplate:
        '智能体上限（设置）{maxMembers}（来源 {limitSource}）· 已用 {usedMembers} · 剩余可新建 {remainingSlots}',
      reuseHint:
        '已有成员会被复用（同名），槽位不足时该成员会被跳过并报告；新开一个对话即可重置智能体槽位。',
      modeTitle: '成员模式',
      modeHint: '保存后随配置生效；work_chain 调用时也可用 mode 参数临时覆盖。',
      modeRotateTitle: '轮换（rotate，推荐）',
      modeRotateText: '每个成员一次性子代理，跑完即释放，不受智能体上限限制（推荐）',
      modeTeamTitle: '团队（team）',
      modeTeamText: '成员作为常驻 Agent Teams 队友，跨调用复用，受设置里智能体上限限制',
      rotateCapacity:
        '轮换模式不受智能体上限限制；最多 {max} 个成员（每批 min(maxParallel, 8) 个，跑完即释放）。',
      workflowLabel: '工作流',
      workflowTitle: '工作流模式：开启后本对话默认用 work_flow 调度成员并逐轮验收',
      workflowLoading: '工作流模式：正在读取…',
      workflowSaving: '工作流模式：正在保存…',
      workflowOn: '工作流模式已开启，点击关闭',
      workflowOff: '工作流模式已关闭，点击开启',
      workflowError: '工作流模式不可用',
      membersTitle: '成员',
      membersHint:
        'name 用 lower-kebab-case（如 writer-1）且不能重复；provider / model 从 DSH 当前已配置的供应商与模型下拉选择（默认 deepseek-v4.1-flash）。',
      providerDetected:
        '已从 DSH 检测到 {count} 个模型供应商；provider / model 用下拉选择，默认模型 deepseek-v4.1-flash。',
      providerUnavailable:
        '未能读取 DSH 的供应商目录（宿主半未更新或 LLM 服务不可用），暂无法下拉选择；可点「重新加载」重试。',
      providerFallback:
        '未能从 DSH 实时读取供应商目录；当前下拉选项用已有配置与内置建议兜底（共 {count} 组），可点「重新加载」重试。',
      providerPartial: '{count} 个供应商暂时不可用：{names}',
      providerCurrentOption: '当前值',
      membersCount: '共 {count} 个',
      membersLimitHint: '最多 {max} 个',
      addMember: '添加成员',
      remove: '删除',
      removeLabel: '删除该成员',
      nameLabel: '成员名',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      namePlaceholder: '例如 writer-1',
      providerPlaceholder: 'opencode-go',
      modelPlaceholder: '输入或从建议中选择',
      emptyMembers: '还没有成员，点「添加成员」开始配置。',
      parallelTitle: '运行参数',
      parallelHint: '保存后下一次 work_chain 调用生效；成员名和模型用于给成员锁定模型。',
      maxParallel: '最大并行数',
      maxParallelHint: '1~{max}，同时运行的成员任务上限',
      timeoutSeconds: '超时（秒）',
      timeoutSecondsHint: '30~3600，单个成员任务的超时时间',
      aestheticTitle: '审美顾问',
      aestheticHint:
        '独立审美顾问：默认 deepseek-v4.1-flash；leader 用 aesthetic_advice 工具随时征询审美建议，建议只回给 leader，由 leader 决定采纳。',
      aestheticEnabled: '启用审美顾问',
      aestheticEnabledHint: '关闭后 leader 调用会提示到插件页开启。',
      aestheticProviderLabel: '审美模型供应商',
      aestheticModelLabel: '审美模型',
      aestheticStyleNotes: '审美偏好 / 标准（可选）',
      aestheticStylePlaceholder: '例如：极简克制、霓虹赛博、留白多、字号层级清晰、动效少于 200ms…',
      aestheticStyleHint: '会拼进审美顾问的系统提示；留空则只用通用视觉/界面审美标准。',
      aestheticInvalidProvider: '审美顾问的 provider 不能为空',
      aestheticInvalidModel: '审美顾问的 model 不能为空',
      save: '保存',
      saving: '保存中…',
      reload: '重新加载',
      loading: '加载中…',
      retry: '重试',
      saved: '已保存，下一次 work_chain 调用生效。',
      loadFailed: '读取配置失败',
      saveFailed: '保存失败',
      unreachable: '无法连接宿主（插件宿主半可能尚未加载）',
      badResponse: '宿主返回了无法解析的响应',
      hostRejected: '宿主拒绝了这次请求',
      structureBad: '宿主返回的配置结构不符合预期（缺少 config.members 等字段）',
      structureWarning:
        '读取到的配置不完整或参数超出范围，已按默认值/范围补齐；直接保存会覆盖服务端当前配置。',
      loadFailedHint:
        '请确认插件的宿主半已加载（组合包处于启用状态）后再重试；也可以稍后刷新页面。',
      fixErrors: '请先修正标红的输入项再保存。',
      invalidMembersEmpty: '至少需要一个成员',
      invalidMembersTooMany: '成员超过上限 {max} 个',
      memberLimitReached: '设置里的智能体上限是 {max}，请到设置调大或删行。',
      rotateMemberLimitReached:
        '轮换模式最多 {max} 个成员（每批 min(maxParallel, 8) 个，跑完即释放），请删行。',
      invalidNameEmpty: '成员名不能为空',
      invalidNameFormat: '成员名需为小写 kebab-case（例如 writer-1）',
      invalidNameDuplicate: '成员名重复',
      invalidProvider: 'provider 不能为空',
      invalidModel: 'model 不能为空',
      invalidMaxParallel: '最大并行数需为 1~{max} 的整数',
      invalidTimeout: '超时需为 30~3600 的整数',
    };

    const en = {
      summary: 'Configure work-chain members (name / provider / model), parallelism, and timeout.',
      leaderNote: 'The current session model is the leader (switch it in the top bar); the leader splits and synthesizes tasks.',
      leaderNoteHint:
        'Members below are real Agent Teams teammates. Tasks fan out to them and they coordinate through the built-in team task board and messages.',
      teamUnavailable:
        'The built-in Agent Teams is unavailable (team.available=false). The configuration can still be saved, but member tasks run only once Teams is available.',
      capacityTemplate:
        'Agent limit (settings) {maxMembers} (source {limitSource}) · used {usedMembers} · {remainingSlots} slots free',
      reuseHint:
        'Existing members are reused by name; when slots run short that member is skipped and reported — start a new conversation to reset agent slots.',
      modeTitle: 'Member mode',
      modeHint: 'Saved with the configuration; a work_chain call may override it with its mode argument.',
      modeRotateTitle: 'Rotate (default, recommended)',
      modeRotateText: 'One disposable subagent per member, released as soon as its task finishes; not limited by the agent limit (recommended)',
      modeTeamTitle: 'Team',
      modeTeamText: 'Members stay as durable Agent Teams teammates, reused across calls, limited by the agent limit in settings',
      rotateCapacity:
        'Rotate mode is not limited by the agent limit; up to {max} members (each wave runs min(maxParallel, 8) and releases them when done).',
      workflowLabel: 'Workflow',
      workflowTitle:
        'Workflow mode: when on, this conversation schedules members with work_flow and reviews each round',
      workflowLoading: 'Workflow mode: reading…',
      workflowSaving: 'Workflow mode: saving…',
      workflowOn: 'Workflow mode is on; click to turn it off',
      workflowOff: 'Workflow mode is off; click to turn it on',
      workflowError: 'Workflow mode is unavailable',
      membersTitle: 'Members',
      membersHint:
        'Use unique lower-kebab-case names (e.g. writer-1); pick provider / model from the providers and models configured in DSH (default: deepseek-v4.1-flash).',
      providerDetected:
        'Detected {count} model providers from DSH; pick provider / model from the dropdowns (default model: deepseek-v4.1-flash).',
      providerUnavailable:
        'Could not read the DSH provider directory (the host half may be outdated or the LLM service is unavailable), so dropdowns are unavailable; use "Reload" to retry.',
      providerFallback:
        'Could not read the live DSH provider directory; the dropdowns fall back to the current configuration and built-in suggestions ({count} groups). Use "Reload" to retry.',
      providerPartial: '{count} providers are temporarily unavailable: {names}',
      providerCurrentOption: 'current value',
      membersCount: '{count} total',
      membersLimitHint: 'up to {max}',
      addMember: 'Add member',
      remove: 'Remove',
      removeLabel: 'Remove this member',
      nameLabel: 'Name',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      namePlaceholder: 'e.g. writer-1',
      providerPlaceholder: 'opencode-go',
      modelPlaceholder: 'Type or pick a suggestion',
      emptyMembers: 'No members yet. Use "Add member" to start.',
      parallelTitle: 'Runtime',
      parallelHint: 'Takes effect on the next work_chain call; names and models pin each member’s model.',
      maxParallel: 'Max parallel',
      maxParallelHint: '1–{max}, how many member tasks run at once',
      timeoutSeconds: 'Timeout (s)',
      timeoutSecondsHint: '30–3600, budget for one member task',
      aestheticTitle: 'Aesthetic advisor',
      aestheticHint:
        'A dedicated aesthetic advisor (default: deepseek-v4.1-flash); the leader can consult it anytime with the aesthetic_advice tool, and the advice goes only to the leader, who decides what to adopt.',
      aestheticEnabled: 'Enable the aesthetic advisor',
      aestheticEnabledHint: 'When off, a leader call reports that it must be enabled on this plugin page.',
      aestheticProviderLabel: 'Aesthetic provider',
      aestheticModelLabel: 'Aesthetic model',
      aestheticStyleNotes: 'Aesthetic preferences / standards (optional)',
      aestheticStylePlaceholder:
        'e.g. minimal and restrained, neon cyber, plenty of whitespace, clear type hierarchy, animations under 200ms…',
      aestheticStyleHint:
        'Appended to the aesthetic advisor’s system prompt; leave empty to use only the general visual/UI standards.',
      aestheticInvalidProvider: 'The aesthetic advisor provider is required',
      aestheticInvalidModel: 'The aesthetic advisor model is required',
      save: 'Save',
      saving: 'Saving…',
      reload: 'Reload',
      loading: 'Loading…',
      retry: 'Retry',
      saved: 'Saved; takes effect on the next work_chain call.',
      loadFailed: 'Could not read the configuration',
      saveFailed: 'Could not save the configuration',
      unreachable: 'Cannot reach the Host (its plugin half may not be loaded yet)',
      badResponse: 'The Host returned an unreadable response',
      hostRejected: 'The Host rejected this request',
      structureBad: 'The Host configuration has an unexpected shape (config.members is missing)',
      structureWarning:
        'The configuration read was incomplete or out of range and was filled with defaults; saving now overwrites the stored configuration.',
      loadFailedHint:
        'Make sure the plugin host half is loaded (the bundle is enabled), then retry; reloading the page later also helps.',
      fixErrors: 'Fix the highlighted fields before saving.',
      invalidMembersEmpty: 'At least one member is required',
      invalidMembersTooMany: 'Too many members (limit {max})',
      memberLimitReached: 'The agent limit in settings is {max}; raise it there or remove rows.',
      rotateMemberLimitReached:
        'Rotate mode supports up to {max} members (each wave runs min(maxParallel, 8) and releases them when done); remove rows.',
      invalidNameEmpty: 'A member name is required',
      invalidNameFormat: 'Use a lower-kebab-case name (e.g. writer-1)',
      invalidNameDuplicate: 'Duplicate member name',
      invalidProvider: 'Provider is required',
      invalidModel: 'Model is required',
      invalidMaxParallel: 'Max parallel must be an integer from 1 to {max}',
      invalidTimeout: 'Timeout must be an integer from 30 to 3600',
    };

    /** 按 `{name}` 占位符渲染字典兜底文本（props.t 缺失时使用）。 */
    function fallbackText(key, params) {
      let out = typeof zh[key] === 'string' ? zh[key] : String(key);
      if (params !== undefined && params !== null) {
        for (const [name, value] of Object.entries(params)) {
          out = out.split(`{${name}}`).join(String(value));
        }
      }
      return out;
    }

    /** 取 slot 注入的 t；缺失或抛错时退化到本地中文兜底，保证卡片不会白屏。 */
    function translate(props) {
      const injected = props !== undefined && props !== null ? props.t : undefined;
      const t =
        typeof injected === 'function'
          ? (key, params) => {
              try {
                const text = injected(key, params);
                if (typeof text === 'string' && text !== '') return text;
              } catch (_error) {
                /* 字典缺失/宿主异常时走兜底 */
              }
              return fallbackText(key, params);
            }
          : fallbackText;
      return t;
    }

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** 数字/数字串 → 限制在 [min,max] 的整数；非法时返回 fallback。 */
    function clampInteger(value, fallback, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(number)));
    }

    /** 把一条 member 规范化成 {name,provider,model} 字符串；非法返回 null。 */
    function normalizeMemberRecord(raw) {
      if (!isRecord(raw)) return null;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      if (name === '' || provider === '' || model === '') return null;
      return { name, provider, model };
    }

    /**
     * 规范化配置里的 aesthetic（v0.6.0 审美顾问）：
     * { enabled, provider, model, styleNotes }。
     * - enabled 只在显式 false 时关闭，其余一律视为开启；
     * - provider / model 去空白，空则回退 DEFAULT_PROVIDER / DEFAULT_MODEL；
     * - styleNotes 非字符串时回退空串。
     * 宿主半旧版本不返回该字段时也能拿到完整默认值（不加结构告警）。
     */
    function normalizeAestheticDraft(raw) {
      if (!isRecord(raw)) {
        return {
          enabled: true,
          provider: DEFAULT_PROVIDER,
          model: DEFAULT_MODEL,
          styleNotes: '',
        };
      }
      const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      return {
        enabled: raw.enabled !== false,
        provider: provider === '' ? DEFAULT_PROVIDER : provider,
        model: model === '' ? DEFAULT_MODEL : model,
        styleNotes: typeof raw.styleNotes === 'string' ? raw.styleNotes : '',
      };
    }

    /**
     * 规范化 GET/POST 里的 team 快照：
     * { available, maxMembers, limitSource, usedMembers, remainingSlots }。
     * maxMembers 来自设置里实际生效的智能体上限（宿主已截到 ≤64）；缺失时返回 null，
     * 由调用方回退到 LIMITS.members.fallback。
     */
    function interpretTeam(raw) {
      if (!isRecord(raw)) return null;
      const maxMembers = Number.isFinite(Number(raw.maxMembers)) && Number(raw.maxMembers) >= 1
        ? clampInteger(raw.maxMembers, LIMITS.members.fallback, 1, LIMITS.members.max)
        : null;
      const usedMembers = Number.isFinite(Number(raw.usedMembers)) && Number(raw.usedMembers) >= 0
        ? Math.trunc(Number(raw.usedMembers))
        : null;
      const remainingSlots = Number.isFinite(Number(raw.remainingSlots)) && Number(raw.remainingSlots) >= 0
        ? Math.trunc(Number(raw.remainingSlots))
        : maxMembers !== null && usedMembers !== null
          ? Math.max(0, maxMembers - usedMembers)
          : null;
      return {
        available: raw.available !== false,
        maxMembers,
        limitSource:
          typeof raw.limitSource === 'string' && raw.limitSource.trim() !== ''
            ? raw.limitSource.trim()
            : null,
        usedMembers,
        remainingSlots,
      };
    }

    /** team 快照是否变化（用于保存成功后决定是否附带容量变化）。 */
    function sameTeam(left, right) {
      if (left === null || right === null) return left === right;
      return (
        left.available === right.available &&
        left.maxMembers === right.maxMembers &&
        left.limitSource === right.limitSource &&
        left.usedMembers === right.usedMembers &&
        left.remainingSlots === right.remainingSlots
      );
    }

    /** 本地化的团队容量文案（顶部容量条与保存成功提示共用）。 */
    function capacityText(t, team) {
      return t('capacityTemplate', {
        maxMembers: team.maxMembers === null ? '?' : String(team.maxMembers),
        limitSource: team.limitSource === null ? 'unknown' : team.limitSource,
        usedMembers: team.usedMembers === null ? '?' : String(team.usedMembers),
        remainingSlots: team.remainingSlots === null ? '?' : String(team.remainingSlots),
      });
    }

    /** 宿主错误响应里的可读文本。 */
    function hostErrorText(payload) {
      if (!isRecord(payload)) return null;
      for (const key of ['error', 'detail', 'message']) {
        const value = payload[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      }
      return null;
    }

    /**
     * 同源 JSON 请求，永不抛异常；返回 { kind:'network'|'aborted'|'response', ... }。
     * 对非 2xx、非 JSON 响应都保留原始文本，交给 interpret* 归类成可读错误。
     */
    async function requestJson(url, init) {
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
          return { kind: 'aborted' };
        }
        return {
          kind: 'network',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        return {
          kind: 'network',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      let payload = null;
      if (raw.trim() !== '') {
        try {
          payload = JSON.parse(raw);
        } catch (_error) {
          payload = null;
        }
      }
      return { kind: 'response', status: response.status, ok: response.ok, payload, raw };
    }

    /** GET 响应归类：成功返回规范化配置 + 下拉建议 + 团队信息 + 结构告警。 */
    function interpretLoad(result) {
      if (result === null || typeof result !== 'object') {
        return { ok: false, code: 'badResponse', detail: null };
      }
      if (result.kind === 'aborted') return { ok: false, code: 'unreachable', detail: 'aborted' };
      if (result.kind === 'network') {
        return { ok: false, code: 'unreachable', detail: result.reason ?? null };
      }
      if (result.kind !== 'response') return { ok: false, code: 'badResponse', detail: null };
      if (!result.ok) {
        return {
          ok: false,
          code: 'hostRejected',
          detail: hostErrorText(result.payload) ?? `HTTP ${result.status}`,
        };
      }
      if (!isRecord(result.payload)) return { ok: false, code: 'badResponse', detail: null };
      const payload = result.payload;
      if (payload.ok !== true) {
        return { ok: false, code: 'hostRejected', detail: hostErrorText(payload) };
      }
      if (!isRecord(payload.config)) {
        return { ok: false, code: 'structureBad', detail: 'config' };
      }
      const warnings = [];
      const source = payload.config;
      let members = [];
      if (!Array.isArray(source.members)) {
        warnings.push('members');
      } else {
        for (const entry of source.members) {
          const member = normalizeMemberRecord(entry);
          if (member === null) {
            warnings.push('member');
            continue;
          }
          members.push(member);
        }
      }
      let maxParallel = LIMITS.maxParallel.fallback;
      if (Number.isFinite(Number(source.maxParallel))) {
        maxParallel = clampInteger(
          source.maxParallel,
          LIMITS.maxParallel.fallback,
          LIMITS.maxParallel.min,
          LIMITS.maxParallel.max,
        );
        if (Number(source.maxParallel) !== maxParallel) warnings.push('maxParallel');
      } else {
        warnings.push('maxParallel');
      }
      let timeoutSeconds = LIMITS.timeoutSeconds.fallback;
      if (Number.isFinite(Number(source.timeoutSeconds))) {
        timeoutSeconds = clampInteger(
          source.timeoutSeconds,
          LIMITS.timeoutSeconds.fallback,
          LIMITS.timeoutSeconds.min,
          LIMITS.timeoutSeconds.max,
        );
        if (Number(source.timeoutSeconds) !== timeoutSeconds) warnings.push('timeoutSeconds');
      } else {
        warnings.push('timeoutSeconds');
      }
      const mode = normalizeMode(source.mode);
      if (source.mode !== undefined && source.mode !== 'rotate' && source.mode !== 'team') {
        warnings.push('mode');
      }
      const defaults = isRecord(payload.defaults) ? payload.defaults : {};
      const models = Array.isArray(defaults.models)
        ? defaults.models.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : [];
      const declaredModes = Array.isArray(defaults.modes)
        ? defaults.modes.filter((entry) => MODES.includes(entry))
        : [];
      const modes = declaredModes.length > 0 ? [...new Set(declaredModes)] : MODES.slice();
      const defaultMembers = Array.isArray(defaults.members)
        ? defaults.members.map(normalizeMemberRecord).filter((entry) => entry !== null)
        : [];
      if (members.length === 0 && defaultMembers.length > 0) {
        members = defaultMembers;
        if (!warnings.includes('members')) warnings.push('members');
      }
      const team = interpretTeam(payload.team);
      if (team === null) warnings.push('team');
      const catalog = (() => {
        const raw = payload.catalog;
        if (isRecord(raw) && Array.isArray(raw.groups) && raw.groups.length > 0) {
          return interpretCatalog(raw);
        }
        return synthesizeCatalog(members, defaultMembers, models);
      })();
      return {
        ok: true,
        config: {
          members,
          mode,
          maxParallel,
          timeoutSeconds,
          aesthetic: normalizeAestheticDraft(source.aesthetic),
        },
        models,
        modes,
        catalog,
        team:
          team ?? {
            available: true,
            maxMembers: null,
            limitSource: null,
            usedMembers: null,
            remainingSlots: null,
          },
        warnings,
      };
    }

    /** POST 响应归类：成功返回宿主规范化后的配置（可能缺省）。 */
    function interpretSave(result) {
      if (result === null || typeof result !== 'object') {
        return { ok: false, code: 'badResponse', detail: null };
      }
      if (result.kind === 'aborted') return { ok: false, code: 'unreachable', detail: 'aborted' };
      if (result.kind === 'network') {
        return { ok: false, code: 'unreachable', detail: result.reason ?? null };
      }
      if (result.kind !== 'response') return { ok: false, code: 'badResponse', detail: null };
      if (!result.ok) {
        return {
          ok: false,
          code: 'hostRejected',
          detail: hostErrorText(result.payload) ?? `HTTP ${result.status}`,
        };
      }
      if (!isRecord(result.payload)) return { ok: false, code: 'badResponse', detail: null };
      const payload = result.payload;
      if (payload.ok !== true) {
        return { ok: false, code: 'hostRejected', detail: hostErrorText(payload) };
      }
      let config = null;
      if (isRecord(payload.config)) {
        const loaded = interpretLoad({
          kind: 'response',
          status: 200,
          ok: true,
          payload: { ok: true, config: payload.config, defaults: {}, team: {} },
          raw: '',
        });
        if (loaded.ok) config = loaded.config;
      }
      return { ok: true, config, team: interpretTeam(payload.team) };
    }

    /**
     * workflow-mode 响应归类：成功返回 {enabled:boolean}；任何异常都变成可读错误，
     * 供对话页按钮显示禁用态 + title，不抛到页面。
     */
    function interpretWorkflow(result) {
      if (result === null || typeof result !== 'object') {
        return { ok: false, code: 'badResponse', detail: null };
      }
      if (result.kind === 'aborted') return { ok: false, code: 'unreachable', detail: 'aborted' };
      if (result.kind === 'network') {
        return { ok: false, code: 'unreachable', detail: result.reason ?? null };
      }
      if (result.kind !== 'response') return { ok: false, code: 'badResponse', detail: null };
      if (!result.ok) {
        return {
          ok: false,
          code: 'hostRejected',
          detail: hostErrorText(result.payload) ?? `HTTP ${result.status}`,
        };
      }
      const payload = result.payload;
      if (!isRecord(payload)) return { ok: false, code: 'badResponse', detail: null };
      if (payload.ok !== true) {
        return { ok: false, code: 'hostRejected', detail: hostErrorText(payload) };
      }
      if (typeof payload.enabled !== 'boolean') {
        return { ok: false, code: 'badResponse', detail: 'enabled' };
      }
      return { ok: true, enabled: payload.enabled };
    }

    /** 序列化态 draft：members 为字符串三元组，数字参数保留输入框字符串。 */
    function toDraft(config) {
      const members = Array.isArray(config.members)
        ? config.members.map((member) => ({
            name: typeof member.name === 'string' ? member.name : '',
            provider: typeof member.provider === 'string' ? member.provider : '',
            model: typeof member.model === 'string' ? member.model : '',
          }))
        : [];
      return {
        members,
        mode: normalizeMode(config.mode),
        maxParallel: String(clampInteger(config.maxParallel, LIMITS.maxParallel.fallback, LIMITS.maxParallel.min, LIMITS.maxParallel.max)),
        timeoutSeconds: String(
          clampInteger(config.timeoutSeconds, LIMITS.timeoutSeconds.fallback, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max),
        ),
        aesthetic: normalizeAestheticDraft(config.aesthetic),
      };
    }

    /** draft → POST body 里的 config（数字转回 number，字符串去空白）。 */
    function toWireConfig(draft) {
      return {
        members: draft.members.map((member) => ({
          name: String(member.name).trim(),
          provider: String(member.provider).trim(),
          model: String(member.model).trim(),
        })),
        mode: normalizeMode(draft.mode),
        maxParallel: Number(draft.maxParallel),
        timeoutSeconds: Number(draft.timeoutSeconds),
        aesthetic: {
          enabled: draft.aesthetic.enabled === true,
          provider: String(draft.aesthetic.provider).trim(),
          model: String(draft.aesthetic.model).trim(),
          styleNotes: String(draft.aesthetic.styleNotes ?? '').trim(),
        },
      };
    }

    /** 每行第一个错误码（null = 合法）。 */
    function computeMemberIssues(members) {
      const counts = new Map();
      for (const member of members) {
        if (member.name !== '') counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
      }
      return members.map((member) => {
        if (member.name.trim() === '') return 'invalidNameEmpty';
        if (!MEMBER_NAME.test(member.name)) return 'invalidNameFormat';
        if ((counts.get(member.name) ?? 0) > 1) return 'invalidNameDuplicate';
        if (String(member.provider).trim() === '') return 'invalidProvider';
        if (String(member.model).trim() === '') return 'invalidModel';
        return null;
      });
    }

    /** 审美顾问字段的第一个错误码（provider 优先，null = 合法）。 */
    function computeAestheticIssues(aesthetic) {
      const current = isRecord(aesthetic) ? aesthetic : {};
      if (String(current.provider ?? '').trim() === '') return 'aestheticInvalidProvider';
      if (String(current.model ?? '').trim() === '') return 'aestheticInvalidModel';
      return null;
    }

    /** 数字字段的合法值；非法返回 null。 */
    function rangeValue(value, limit) {
      const text = typeof value === 'string' ? value.trim() : String(value);
      if (!/^\d+$/u.test(text)) return null;
      const number = Number(text);
      return Number.isInteger(number) && number >= limit.min && number <= limit.max ? number : null;
    }

    /**
     * 数字字段校验；maxParallel 的上限跟随 team.maxMembers（宿主按智能体上限 clamp），
     * timeoutSeconds 固定 30~3600。
     */
    function computeRangeIssues(draft, maxParallelLimit) {
      const upper =
        typeof maxParallelLimit === 'number' && maxParallelLimit >= LIMITS.maxParallel.min
          ? Math.min(maxParallelLimit, LIMITS.maxParallel.max)
          : LIMITS.maxParallel.max;
      return {
        maxParallel:
          rangeValue(draft.maxParallel, { min: LIMITS.maxParallel.min, max: upper }) === null
            ? 'invalidMaxParallel'
            : null,
        timeoutSeconds:
          rangeValue(draft.timeoutSeconds, LIMITS.timeoutSeconds) === null ? 'invalidTimeout' : null,
      };
    }

    /** 收集本地校验错误（已本地化的字符串）。 */
    function collectIssues(t, draft, memberLimit, maxParallelLimit) {
      const issues = [];
      if (draft.members.length < LIMITS.members.min) issues.push(t('invalidMembersEmpty'));
      if (draft.members.length > memberLimit) issues.push(t('invalidMembersTooMany', { max: String(memberLimit) }));
      for (const code of computeMemberIssues(draft.members)) {
        if (code !== null) issues.push(t(code));
      }
      const range = computeRangeIssues(draft, maxParallelLimit);
      if (range.maxParallel !== null) {
        issues.push(t(range.maxParallel, { max: String(Math.min(maxParallelLimit, LIMITS.maxParallel.max)) }));
      }
      if (range.timeoutSeconds !== null) issues.push(t(range.timeoutSeconds));
      const aestheticIssue = computeAestheticIssues(draft.aesthetic);
      if (aestheticIssue !== null) issues.push(t(aestheticIssue));
      return issues;
    }

    /** 生成一个未被占用的默认成员名（worker-1、worker-2…）。 */
    function nextMemberName(members) {
      const taken = new Set(members.map((member) => member.name));
      for (let index = 1; index < 100; index += 1) {
        const candidate = `worker-${index}`;
        if (!taken.has(candidate)) return candidate;
      }
      return `worker-${Date.now()}`;
    }

    /** 错误码 → 可读文本（带宿主 detail）。 */
    function errorText(t, code, detail) {
      const base = t(code);
      const extra = typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : '';
      return extra === '' ? base : `${base}：${extra}`;
    }

    /** 带主题变量的输入框：优先 primitives Input（原生 input props 透传）。 */
    function TextField(props) {
      const { style, ...rest } = props;
      if (PrimitiveInput !== null) {
        return h(PrimitiveInput, { ...rest, ...(style === undefined ? {} : { style }) });
      }
      return h('input', { ...rest, style: { ...FALLBACK_INPUT_STYLE, ...(style ?? {}) } });
    }

    /** 多行文本框：优先 primitives Textarea（原生 textarea props 透传），否则用原生 textarea。 */
    function TextareaField(props) {
      const { style, ...rest } = props;
      if (PrimitiveTextarea !== null) {
        return h(PrimitiveTextarea, { ...rest, ...(style === undefined ? {} : { style }) });
      }
      return h('textarea', { ...rest, style: { ...FALLBACK_TEXTAREA_STYLE, ...(style ?? {}) } });
    }

    /** 下拉选择框：原声 select，渲染 options（{value,label} 列表）。 */
    function SelectField(props) {
      const { options, style, ...rest } = props;
      return h(
        'select',
        { ...rest, style: { ...FALLBACK_SELECT_STYLE, ...(style ?? {}) } },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      );
    }

    /** 按钮：优先 primitives Button；缺失时退化为带主题变量的原生 button。 */
    function ActionButton(props) {
      const { variant, size, style, children, ...rest } = props;
      if (PrimitiveButton !== null) {
        return h(PrimitiveButton, {
          variant: variant ?? 'ghost',
          size: size ?? 'sm',
          ...(style === undefined ? {} : { style }),
          ...rest,
        }, children);
      }
      const fallbackStyle =
        variant === 'primary'
          ? { ...FALLBACK_BUTTON_PRIMARY_STYLE, ...(style ?? {}) }
          : { ...FALLBACK_BUTTON_STYLE, ...(style ?? {}) };
      return h('button', { type: 'button', ...rest, style: fallbackStyle }, children);
    }

    /**
     * 对话页输入框左侧的「工作流」快捷开关（conversation.input.left）。
     * 三态：loading（读取中）/ off（描边）/ on（主题强调色填充）；GET 一次，点击 POST。
     * 请求失败时进入禁用错误态，title/aria-label 显示原因，绝不抛到页面。
     */
    function WorkflowModeToggle(props) {
      const t = translate(props);
      const [state, setState] = React.useState({ status: 'loading', enabled: false, error: null });
      const [pending, setPending] = React.useState(false);
      const [hovered, setHovered] = React.useState(false);
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      // 挂载时读一次全局 workflowMode（所有对话共用）。
      React.useEffect(() => {
        const controller = new AbortController();
        const run = async () => {
          const result = await requestJson(WORKFLOW_ENDPOINT, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!aliveRef.current || result.kind === 'aborted') return;
          const parsed = interpretWorkflow(result);
          if (parsed.ok === true) {
            setState({ status: parsed.enabled ? 'on' : 'off', enabled: parsed.enabled, error: null });
          } else {
            setState({
              status: 'error',
              enabled: false,
              error: errorText(t, parsed.code, parsed.detail),
            });
          }
        };
        run();
        return () => {
          controller.abort();
        };
      }, []);

      const toggle = async () => {
        if (pending || state.status === 'loading' || state.status === 'error') return;
        const desired = !state.enabled;
        setPending(true);
        const result = await requestJson(WORKFLOW_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ enabled: desired }),
        });
        if (!aliveRef.current) return;
        setPending(false);
        const parsed = interpretWorkflow(result);
        if (parsed.ok === true) {
          setState({ status: parsed.enabled ? 'on' : 'off', enabled: parsed.enabled, error: null });
        } else {
          setState((previous) => ({
            status: 'error',
            enabled: previous.enabled,
            error: errorText(t, parsed.code, parsed.detail),
          }));
        }
      };

      const active = state.status === 'on';
      const loading = state.status === 'loading';
      const failed = state.status === 'error';
      const disabled = pending || loading || failed;
      const title = failed
        ? `${t('workflowError')}：${state.error}`
        : pending
          ? t('workflowSaving')
          : loading
            ? t('workflowLoading')
            : `${t('workflowTitle')}（${active ? t('workflowOn') : t('workflowOff')}）`;
      const background = active
        ? COLOR.accent
        : !disabled && hovered
          ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))'
          : 'transparent';
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          'aria-pressed': active ? 'true' : 'false',
          'data-workflow-mode': state.status,
          disabled,
          onClick: toggle,
          onMouseEnter: () => {
            setHovered(true);
          },
          onMouseLeave: () => {
            setHovered(false);
          },
          style: {
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 24,
            padding: '0 10px',
            borderRadius: 999,
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            cursor: disabled ? 'default' : 'pointer',
            color: active
              ? 'var(--dsw-alias-label-primary-inverted, #fff)'
              : failed
                ? COLOR.danger
                : COLOR.text,
            background,
            border: `0.5px solid ${
              active ? 'transparent' : failed ? COLOR.danger : COLOR.borderStrong
            }`,
            opacity: loading || pending ? 0.65 : 1,
          },
        },
        h('span', { 'aria-hidden': true, style: { fontSize: 11 } }, '⚙'),
        h('span', null, loading ? `${t('workflowLabel')}…` : t('workflowLabel')),
      );
    }

    /** 说明条：当前会话即 leader。 */
    function LeaderNotice(props) {
      const t = props.t;
      return h(
        'div',
        { style: STYLE.notice, 'data-work-chain-leader-notice': true },
        h('div', { style: STYLE.noticeTitle }, t('leaderNote')),
        h('div', { style: STYLE.noticeText }, t('leaderNoteHint')),
      );
    }

    /** 一行成员的编辑单元。 */
    function MemberRow(props) {
      const { t, member, index, listId, catalog, useSelect, disabled, issue, onChange, onRemove } = props;
      const label = `${t('nameLabel')} ${index + 1}`;
      const providerOptions = providerSelectOptions(t, catalog, member.provider);
      const modelOptions =
        useSelect === true ? modelSelectOptions(t, modelOptionsFor(catalog.groups, member.provider), member.model) : [];
      const providerHasModels = useSelect === true && modelOptionsFor(catalog.groups, member.provider).length > 0;
      return h(
        'div',
        { style: STYLE.row, 'data-work-chain-member': index },
        h(
          'div',
          { style: STYLE.cell },
          h(TextField, {
            value: member.name,
            placeholder: t('namePlaceholder'),
            'aria-label': label,
            'aria-invalid': issue !== null ? true : undefined,
            disabled,
            onChange: (event) => {
              onChange('name', event.target.value);
            },
          }),
        ),
        h(
          'div',
          { style: STYLE.cell },
          useSelect === true
            ? h(SelectField, {
                value: member.provider,
                options: providerOptions,
                'aria-label': `${t('providerLabel')} ${index + 1}`,
                disabled,
                onChange: (event) => {
                  onChange('provider', event.target.value);
                },
              })
            : h(TextField, {
                value: member.provider,
                placeholder: t('providerPlaceholder'),
                'aria-label': `${t('providerLabel')} ${index + 1}`,
                disabled,
                onChange: (event) => {
                  onChange('provider', event.target.value);
                },
              }),
        ),
        h(
          'div',
          { style: STYLE.cell },
          providerHasModels
            ? h(SelectField, {
                value: member.model,
                options: modelOptions,
                'aria-label': `${t('modelLabel')} ${index + 1}`,
                disabled,
                onChange: (event) => {
                  onChange('model', event.target.value);
                },
              })
            : h(TextField, {
                value: member.model,
                placeholder: t('modelPlaceholder'),
                'aria-label': `${t('modelLabel')} ${index + 1}`,
                list: listId,
                disabled,
                onChange: (event) => {
                  onChange('model', event.target.value);
                },
              }),
        ),
        h(
          'div',
          { style: STYLE.cellAction },
          h(
            ActionButton,
            {
              variant: 'ghost',
              size: 'sm',
              disabled,
              'aria-label': t('removeLabel'),
              onClick: onRemove,
            },
            t('remove'),
          ),
        ),
        issue === null
          ? null
          : h('div', { style: STYLE.rowError, role: 'status' }, t(issue)),
      );
    }

    /** 配置卡片主体（page 视图）。 */
    function WorkChainConfigPage(props) {
      const t = translate(props);
      const [draft, setDraft] = React.useState(null);
      const [meta, setMeta] = React.useState({
        catalog: synthesizeCatalog([], [], MODEL_SUGGESTIONS),
        modes: MODES.slice(),
        team: {
          available: true,
          maxMembers: null,
          limitSource: null,
          usedMembers: null,
          remainingSlots: null,
        },
      });
      const [phase, setPhase] = React.useState({
        status: 'loading',
        code: null,
        detail: null,
        warnings: [],
      });
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [attempt, setAttempt] = React.useState(0);
      const listId = React.useId();
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      // 首次挂载与「重新加载」时读取宿主配置。
      React.useEffect(() => {
        const controller = new AbortController();
        let live = true;
        setPhase({ status: 'loading', code: null, detail: null, warnings: [] });
        setSaveError(null);
        setNotice(null);
        const run = async () => {
          const result = await requestJson(CONFIG_ENDPOINT, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!live) return;
          const parsed = interpretLoad(result);
          if (parsed.ok !== true) {
            setDraft(null);
            setPhase({ status: 'failed', code: parsed.code, detail: parsed.detail, warnings: [] });
            return;
          }
          setDraft(toDraft(parsed.config));
          setMeta({
            catalog: parsed.catalog,
            modes: parsed.modes.length > 0 ? parsed.modes : MODES.slice(),
            team: parsed.team,
          });
          setPhase({
            status: 'ready',
            code: parsed.warnings.length > 0 ? 'structureWarning' : null,
            detail: null,
            warnings: parsed.warnings,
          });
        };
        run();
        return () => {
          live = false;
          controller.abort();
        };
      }, [attempt]);

      // 成功提示短暂停留后自动消失。
      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => {
          if (aliveRef.current) setNotice(null);
        }, 2600);
        return () => {
          clearTimeout(timer);
        };
      }, [notice]);

      if (props !== undefined && props !== null && props.view === 'summary') {
        return h('span', null, t('summary'));
      }

      const reload = () => {
        if (saving) return;
        setAttempt((value) => value + 1);
      };

      const updateDraft = (updater) => {
        setDraft((previous) => (previous === null ? previous : updater(previous)));
      };

      // 供应商/模型目录：有可用组就用下拉，否则退回文本输入。
      const catalog = meta.catalog;
      const useSelect = catalog.groups.length > 0;

      const updateMember = (index, field, value) => {
        updateDraft((previous) => ({
          ...previous,
          members: previous.members.map((member, position) => {
            if (position !== index) return member;
            if (field === 'provider') {
              const picked = pickModelForProvider(catalog.groups, value, member.model);
              return { ...member, provider: value, ...(picked === '' ? {} : { model: picked }) };
            }
            return { ...member, [field]: value };
          }),
        }));
      };

      const addMember = () => {
        updateDraft((previous) => {
          if (previous.members.length >= memberLimit) return previous;
          const provider =
            catalog.groups.some((group) => group.id === catalog.defaultProvider)
              ? catalog.defaultProvider
              : pickDefaultProvider(catalog.groups) || DEFAULT_PROVIDER;
          const model =
            pickModelForProvider(catalog.groups, provider, catalog.defaultModel) ||
            (catalog.groups.length === 0 ? MODEL_SUGGESTIONS[0] : '') ||
            DEFAULT_MODEL;
          return {
            ...previous,
            members: [
              ...previous.members,
              {
                name: nextMemberName(previous.members),
                provider,
                model,
              },
            ],
          };
        });
      };

      const removeMember = (index) => {
        updateDraft((previous) => ({
          ...previous,
          members: previous.members.filter((_member, position) => position !== index),
        }));
      };

      // 审美顾问（v0.6.0）：provider 变更时沿用成员行的「保持/重新挑模型」逻辑。
      const updateAesthetic = (field, value) => {
        updateDraft((previous) => {
          const current = isRecord(previous.aesthetic) ? previous.aesthetic : normalizeAestheticDraft(null);
          const next = { ...current, [field]: value };
          if (field === 'provider') {
            const picked = pickModelForProvider(catalog.groups, value, current.model);
            if (picked !== '') next.model = picked;
          }
          return { ...previous, aesthetic: next };
        });
      };

      const save = async () => {
        if (draft === null || saving) return;
        const issues = collectIssues(t, draft, memberLimit, maxParallelLimit);
        if (issues.length > 0) {
          setSaveError(t('fixErrors'));
          return;
        }
        setSaving(true);
        setSaveError(null);
        setNotice(null);
        const result = await requestJson(CONFIG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ config: toWireConfig(draft) }),
        });
        if (!aliveRef.current) return;
        setSaving(false);
        const parsed = interpretSave(result);
        if (parsed.ok !== true) {
          setSaveError(`${t('saveFailed')}：${errorText(t, parsed.code, parsed.detail)}`);
          return;
        }
        if (parsed.config !== null) setDraft(toDraft(parsed.config));
        // 宿主可能同时返回最新 team 快照（容量随设置/队友变化）；变化时更新顶部并附在提示里。
        let noticeText = t('saved');
        if (parsed.team !== null) {
          const changed = !sameTeam(parsed.team, meta.team);
          setMeta((previous) => ({ ...previous, team: parsed.team }));
          if (changed) noticeText = `${t('saved')} ${capacityText(t, parsed.team)}`;
        }
        setNotice({ seq: Date.now(), text: noticeText });
      };

      // 成员行数上限按模式区分：rotate = 16（host 轮换一次最多跑 16 个，不再看设置上限）；
      // team = 设置里实际生效的智能体上限（team.maxMembers，缺失回退 8）。
      // host v0.2.0 的 maxParallel 固定 1~8，不跟随智能体上限。
      const mode = draft === null ? DEFAULT_MODE : normalizeMode(draft.mode);
      const memberLimit =
        mode === 'rotate'
          ? LIMITS.members.rotateMax
          : typeof meta.team.maxMembers === 'number' && meta.team.maxMembers >= LIMITS.members.min
            ? Math.min(meta.team.maxMembers, LIMITS.members.max)
            : LIMITS.members.fallback;
      const maxParallelLimit = LIMITS.maxParallel.max;
      const memberLimitMessageKey =
        mode === 'rotate' ? 'rotateMemberLimitReached' : 'memberLimitReached';
      const loading = phase.status === 'loading';
      const ready = phase.status === 'ready';
      const busy = loading || saving;

      // 读取失败：只给可读错误 + 重试，不渲染半可信的表单。
      if (phase.status === 'failed') {
        return h(
          'div',
          { style: STYLE.root, 'data-work-chain-config': true },
          h(LeaderNotice, { t }),
          h(
            'div',
            { style: STYLE.failedBox, role: 'alert' },
            h('div', { style: STYLE.statusError }, `${t('loadFailed')}：${errorText(t, phase.code, phase.detail)}`),
            h('div', { style: STYLE.hint }, t('loadFailedHint')),
          ),
          h(
            'div',
            { style: STYLE.actionBar },
            h(
              ActionButton,
              { variant: 'outline', size: 'sm', onClick: reload, disabled: busy },
              loading ? t('loading') : t('retry'),
            ),
          ),
        );
      }

      if (!ready || draft === null) {
        return h(
          'div',
          { style: STYLE.root, 'data-work-chain-config': true },
          h(LeaderNotice, { t }),
          h('div', { style: STYLE.status, role: 'status' }, t('loading')),
        );
      }

      const rowIssues = computeMemberIssues(draft.members);
      const rangeIssues = computeRangeIssues(draft, maxParallelLimit);
      const aestheticIssues = computeAestheticIssues(draft.aesthetic);
      const aestheticModelOptions = modelSelectOptions(
        t,
        modelOptionsFor(catalog.groups, draft.aesthetic.provider),
        draft.aesthetic.model,
      );
      const aestheticHasModels = useSelect && aestheticModelOptions.length > 0;
      const overMemberLimit = draft.members.length > memberLimit;
      const atMemberLimit = draft.members.length >= memberLimit;
      const team = meta.team;
      const showCapacity = team.maxMembers !== null || team.usedMembers !== null;
      const availableModes = meta.modes.length > 0 ? meta.modes : MODES.slice();
      const modeOptions = [
        { value: 'rotate', titleKey: 'modeRotateTitle', textKey: 'modeRotateText' },
        { value: 'team', titleKey: 'modeTeamTitle', textKey: 'modeTeamText' },
      ].filter((option) => availableModes.includes(option.value));

      return h(
        'div',
        { style: STYLE.root, 'data-work-chain-config': true },
        h(LeaderNotice, { t }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            { style: STYLE.sectionHead },
            h('div', { style: STYLE.sectionTitle }, t('modeTitle')),
            h('span', { style: STYLE.sectionMeta }, t('modeHint')),
          ),
          h(
            'div',
            { style: STYLE.modeGroup, role: 'radiogroup', 'aria-label': t('modeTitle'), 'data-work-chain-mode': mode },
            modeOptions.map((option) =>
              h(
                'label',
                {
                  key: option.value,
                  style:
                    mode === option.value
                      ? { ...STYLE.modeOption, ...STYLE.modeOptionActive }
                      : STYLE.modeOption,
                },
                h('input', {
                  type: 'radio',
                  name: 'work-chain-member-mode',
                  value: option.value,
                  checked: mode === option.value,
                  disabled: saving,
                  style: STYLE.modeRadio,
                  onChange: () => {
                    updateDraft((previous) => ({ ...previous, mode: option.value }));
                  },
                }),
                h(
                  'span',
                  { style: STYLE.modeOptionBody },
                  h('span', { style: STYLE.modeOptionTitle }, t(option.titleKey)),
                  h('span', { style: STYLE.modeOptionText }, t(option.textKey)),
                ),
              ),
            ),
          ),
        ),
        mode === 'rotate'
          ? h(
              'div',
              { style: STYLE.capacity, 'data-work-chain-rotate': true, role: 'status' },
              h('span', { style: STYLE.capacityValue }, t('rotateCapacity', { max: String(memberLimit) })),
            )
          : showCapacity
            ? h(
                'div',
                { style: STYLE.capacity, 'data-work-chain-capacity': true, role: 'status' },
                h('span', { style: STYLE.capacityValue }, capacityText(t, team)),
              )
            : null,
        mode === 'team' && team.available !== true
          ? h('div', { style: STYLE.warnBox, role: 'status' }, t('teamUnavailable'))
          : null,
        mode === 'team' && typeof team.usedMembers === 'number' && team.usedMembers > 0
          ? h('div', { style: STYLE.hint }, t('reuseHint'))
          : null,
        h(
          'div',
          { style: STYLE.sectionHead },
          h(
            'div',
            { style: STYLE.sectionTitle },
            t('membersTitle'),
            h('span', { style: STYLE.sectionMeta }, `  ${t('membersCount', { count: String(draft.members.length) })}`),
          ),
          h('span', { style: STYLE.sectionMeta }, t('membersLimitHint', { max: String(memberLimit) })),
        ),
        h('div', { style: STYLE.hint }, t('membersHint')),
        useSelect
          ? null
          : h('div', { style: STYLE.hint }, t('providerUnavailable')),
        catalog.available
          ? h('div', { style: STYLE.hint }, t('providerDetected', { count: String(catalog.groups.length) }))
          : useSelect
            ? h('div', { style: STYLE.hint }, t('providerFallback', { count: String(catalog.groups.length) }))
            : null,
        catalog.failures.length > 0
          ? h(
              'div',
              { style: STYLE.hintFaint },
              t('providerPartial', {
                count: String(catalog.failures.length),
                names: catalog.failures.map((failure) => failure.id).join('、'),
              }),
            )
          : null,
        draft.members.length === 0
          ? h('div', { style: STYLE.empty }, t('emptyMembers'))
          : h(
              'div',
              { style: { display: 'grid', gap: 8 } },
              h(
                'div',
                { style: STYLE.tableHead },
                h('span', null, t('nameLabel')),
                h('span', null, t('providerLabel')),
                h('span', null, t('modelLabel')),
                h('span', null, ''),
              ),
              draft.members.map((member, index) =>
                h(MemberRow, {
                  key: index,
                  t,
                  member,
                  index,
                  listId,
                  catalog,
                  useSelect,
                  disabled: saving,
                  issue: rowIssues[index] ?? null,
                  onChange: (field, value) => {
                    updateMember(index, field, value);
                  },
                  onRemove: () => {
                    removeMember(index);
                  },
                }),
              ),
            ),
        useSelect
          ? null
          : h('datalist', { id: listId }, MODEL_SUGGESTIONS.map((model) => h('option', { key: model, value: model }))),
        h(
          'div',
          { style: STYLE.actionBar },
          h(
            ActionButton,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy || atMemberLimit,
              onClick: addMember,
            },
            t('addMember'),
          ),
          overMemberLimit
            ? h(
                'span',
                { style: STYLE.error, role: 'status' },
                t(mode === 'rotate' ? 'rotateMemberLimitReached' : 'invalidMembersTooMany', {
                  max: String(memberLimit),
                }),
              )
            : atMemberLimit
              ? h(
                  'span',
                  { style: STYLE.error, role: 'status' },
                  t(memberLimitMessageKey, { max: String(memberLimit) }),
                )
              : null,
        ),
        h(
          'div',
          { style: STYLE.sectionHead },
          h('div', { style: STYLE.sectionTitle }, t('parallelTitle')),
          h('span', { style: STYLE.sectionMeta }, t('parallelHint')),
        ),
        h(
          'div',
          { style: STYLE.fields },
          h(
            'label',
            { style: STYLE.field },
            h('span', { style: STYLE.fieldLabel }, t('maxParallel')),
            h(TextField, {
              type: 'number',
              min: LIMITS.maxParallel.min,
              max: maxParallelLimit,
              step: 1,
              value: draft.maxParallel,
              disabled: saving,
              'aria-invalid': rangeIssues.maxParallel !== null ? true : undefined,
              onChange: (event) => {
                const value = event.target.value;
                updateDraft((previous) => ({ ...previous, maxParallel: value }));
              },
            }),
            rangeIssues.maxParallel !== null
              ? h(
                  'span',
                  { style: STYLE.error, role: 'status' },
                  t(rangeIssues.maxParallel, { max: String(maxParallelLimit) }),
                )
              : h('span', { style: STYLE.hintFaint }, t('maxParallelHint', { max: String(maxParallelLimit) })),
          ),
          h(
            'label',
            { style: STYLE.field },
            h('span', { style: STYLE.fieldLabel }, t('timeoutSeconds')),
            h(TextField, {
              type: 'number',
              min: LIMITS.timeoutSeconds.min,
              max: LIMITS.timeoutSeconds.max,
              step: 10,
              value: draft.timeoutSeconds,
              disabled: saving,
              'aria-invalid': rangeIssues.timeoutSeconds !== null ? true : undefined,
              onChange: (event) => {
                const value = event.target.value;
                updateDraft((previous) => ({ ...previous, timeoutSeconds: value }));
              },
            }),
            rangeIssues.timeoutSeconds !== null
              ? h('span', { style: STYLE.error, role: 'status' }, t(rangeIssues.timeoutSeconds))
              : h('span', { style: STYLE.hintFaint }, t('timeoutSecondsHint')),
          ),
        ),
        h(
          'div',
          { style: STYLE.sectionHead },
          h('div', { style: STYLE.sectionTitle }, t('aestheticTitle')),
          h('span', { style: STYLE.sectionMeta }, t('aestheticHint')),
        ),
        h(
          'label',
          { style: STYLE.checkRow, 'data-work-chain-aesthetic-toggle': true },
          h('input', {
            type: 'checkbox',
            checked: draft.aesthetic.enabled,
            disabled: saving,
            style: STYLE.checkbox,
            onChange: (event) => {
              updateAesthetic('enabled', event.target.checked === true);
            },
          }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', { style: STYLE.fieldLabel }, t('aestheticEnabled')),
            h('span', { style: STYLE.hintFaint }, t('aestheticEnabledHint')),
          ),
        ),
        h(
          'div',
          { style: STYLE.fields },
          h(
            'label',
            { style: STYLE.field },
            h('span', { style: STYLE.fieldLabel }, t('aestheticProviderLabel')),
            useSelect
              ? h(SelectField, {
                  value: draft.aesthetic.provider,
                  options: providerSelectOptions(t, catalog, draft.aesthetic.provider),
                  'aria-label': t('aestheticProviderLabel'),
                  disabled: saving,
                  onChange: (event) => {
                    updateAesthetic('provider', event.target.value);
                  },
                })
              : h(TextField, {
                  value: draft.aesthetic.provider,
                  placeholder: t('providerPlaceholder'),
                  'aria-label': t('aestheticProviderLabel'),
                  disabled: saving,
                  onChange: (event) => {
                    updateAesthetic('provider', event.target.value);
                  },
                }),
          ),
          h(
            'label',
            { style: STYLE.field },
            h('span', { style: STYLE.fieldLabel }, t('aestheticModelLabel')),
            aestheticHasModels
              ? h(SelectField, {
                  value: draft.aesthetic.model,
                  options: aestheticModelOptions,
                  'aria-label': t('aestheticModelLabel'),
                  disabled: saving,
                  onChange: (event) => {
                    updateAesthetic('model', event.target.value);
                  },
                })
              : h(TextField, {
                  value: draft.aesthetic.model,
                  placeholder: t('modelPlaceholder'),
                  'aria-label': t('aestheticModelLabel'),
                  disabled: saving,
                  onChange: (event) => {
                    updateAesthetic('model', event.target.value);
                  },
                }),
          ),
        ),
        h(
          'div',
          { style: STYLE.field },
          h('span', { style: STYLE.fieldLabel }, t('aestheticStyleNotes')),
          h(TextareaField, {
            rows: 3,
            value: draft.aesthetic.styleNotes,
            placeholder: t('aestheticStylePlaceholder'),
            disabled: saving,
            'aria-label': t('aestheticStyleNotes'),
            onChange: (event) => {
              updateAesthetic('styleNotes', event.target.value);
            },
          }),
          h('span', { style: STYLE.hintFaint }, t('aestheticStyleHint')),
        ),
        aestheticIssues !== null
          ? h('div', { style: STYLE.error, role: 'status' }, t(aestheticIssues))
          : null,
        h(
          'div',
          { style: STYLE.actionBar },
          h(
            ActionButton,
            { variant: 'primary', size: 'sm', disabled: busy, onClick: save },
            saving ? t('saving') : t('save'),
          ),
          h(
            ActionButton,
            { variant: 'outline', size: 'sm', disabled: busy, onClick: reload },
            loading ? t('loading') : t('reload'),
          ),
          phase.code !== null
            ? h('span', { style: STYLE.hintFaint, role: 'status' }, t(phase.code))
            : null,
          saveError !== null
            ? h('span', { style: STYLE.statusError, role: 'alert' }, saveError)
            : null,
          saveError === null && notice !== null
            ? h('span', { style: STYLE.statusSuccess, role: 'status' }, notice.text)
            : null,
        ),
      );
    }

    /**
     * 挂载浏览器半：
     * - 插件页 → 已安装插件 → dsh-work-chain 组合包页里的「工作链成员配置」卡片；
     * - 对话页输入框左侧的「工作流」快捷开关（conversation.input.left）。
     * locale 注册必须在 slot 注册之前完成，否则卡片/按钮拿不到 props.t。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-chain: locale dictionaries');
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: PACKAGE_NAME,
            locale: NS,
          },
          WorkChainConfigPage,
        ),
      );
      ctx.slots.inject(WORKFLOW_SLOT, () =>
        ctx.slots.register(
          {
            name: WORKFLOW_SLOT,
            id: WORKFLOW_SLOT_ID,
            order: 200,
            label: () => '工作流模式',
            locale: NS,
          },
          WorkflowModeToggle,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.NS = NS;
    exports.PACKAGE_NAME = PACKAGE_NAME;
    exports.CONFIG_ENDPOINT = CONFIG_ENDPOINT;
    exports.WORKFLOW_ENDPOINT = WORKFLOW_ENDPOINT;
    // 供 node 侧冒烟检查的纯函数（页面运行时不使用）。
    exports.internals = Object.freeze({
      interpretLoad,
      interpretSave,
      interpretWorkflow,
      interpretTeam,
      interpretCatalog,
      synthesizeCatalog,
      pickDefaultProvider,
      pickModelForProvider,
      modelOptionsFor,
      providerSelectOptions,
      modelSelectOptions,
      DEFAULT_PROVIDER,
      DEFAULT_MODEL,
      capacityText,
      sameTeam,
      normalizeMode,
      toDraft,
      toWireConfig,
      computeMemberIssues,
      computeAestheticIssues,
      normalizeAestheticDraft,
      computeRangeIssues,
      collectIssues,
      normalizeMemberRecord,
      rangeValue,
    });
    return module.exports;
  },
});
