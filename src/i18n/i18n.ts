/**
 * Static UI localization (no LLM involved). Covers the extension's own
 * labels only: commands, code, paths, tool output and agent text are never
 * translated here.
 */

export type UiLanguage = 'zh-CN' | 'en' | 'bilingual';
export const UI_LANGUAGES: UiLanguage[] = ['zh-CN', 'en', 'bilingual'];
export const DEFAULT_LANGUAGE: UiLanguage = 'zh-CN';

export function normalizeLanguage(v: unknown): UiLanguage {
  return UI_LANGUAGES.includes(v as UiLanguage) ? (v as UiLanguage) : DEFAULT_LANGUAGE;
}

type Entry = [en: string, zh: string];

/** Keys are shared with the webviews. `{name}` placeholders are filled by `format`. */
export const STRINGS = {
  // language selector
  'lang.label': ['Language', '语言'],
  'lang.zh-CN': ['中文 (Simplified Chinese)', '中文'],
  'lang.en': ['English', 'English'],
  'lang.bilingual': ['中英双语 (Bilingual)', '中英双语'],

  // header / status
  'a.simulated': ['SIMULATED', '模拟'],
  'a.simulatedTip': ['Mock agent: no real files are modified and no commands are executed.', '模拟代理：不会修改真实文件，也不会执行命令。'],
  'a.real': ['REAL AGENT', '真实代理'],
  'a.realTip': ['Operations are performed by a real agent process.', '操作由真实的代理进程执行。'],
  'a.boundary': ['Boundary', '安全边界'],
  'a.liveTracking': ['Live tracking', '实时跟踪'],
  'a.liveTrackingTip': ['Every event from the agent is recorded, independent of Live Follow.', '代理的每个事件都会被记录，与"实时跟随"无关。'],
  'a.now': ['now', '当前'],
  'state.idle': ['Idle', '空闲'],
  'state.running': ['Running', '运行中'],
  'state.paused': ['Paused', '已暂停'],
  'state.waiting': ['Awaiting your approval', '等待你的批准'],
  'state.pausedWaiting': ['Paused · awaiting your approval', '已暂停 · 等待你的批准'],
  'state.done': ['Completed', '已完成'],
  'state.stopped': ['Stopped', '已停止'],
  'state.failed': ['Failed', '失败'],

  // controls
  'a.controls': ['Agent controls', '代理控制'],
  'a.startDemo': ['▶ Start demo', '▶ 开始演示'],
  'a.startDemoTip': ['Start the simulated demo task', '启动模拟演示任务'],
  'a.startCodex': ['▶ Codex task…', '▶ Codex 任务…'],
  'a.startCodexTip': ['Start a real Codex task in its own isolated app-server session', '在独立的 app-server 会话中启动真实的 Codex 任务'],
  'a.resume': ['⏵ Resume', '⏵ 继续'],
  'a.resumeTip': ['Continue dispatching queued operations', '继续分派排队中的操作'],
  'a.pause': ['⏸ Pause', '⏸ 暂停'],
  'a.pauseTip': ['Stop dispatching new operations (current one finishes)', '停止分派新操作（当前操作会完成）'],
  'a.pauseUnsupportedTip': ['Codex cannot be paused mid-turn. Use Stop (interrupts the turn) or Send instruction.', 'Codex 无法在回合中暂停。请使用"停止"（中断回合）或"发送指令"。'],
  'a.stop': ['⏹ Stop', '⏹ 停止'],
  'a.stopCodexTip': ['Interrupt the Codex turn', '中断 Codex 回合'],
  'a.stopTip': ['Cancel all remaining operations', '取消所有剩余操作'],
  'a.steer': ['✎ Send instruction', '✎ 发送指令'],
  'a.steerTip': ['Add an instruction to the active Codex turn', '向当前 Codex 回合追加一条指令'],
  'a.liveFollow': ['Live Follow (move the editor with the agent)', '实时跟随（编辑器随代理移动）'],
  'a.liveFollowTip': ['When on, the editor follows the agent (without taking keyboard focus).', '开启后，编辑器会跟随代理（不抢占键盘焦点）。'],
  'a.taskHistory': ['Task history', '任务历史'],
  'a.task': ['Task', '任务'],

  // approval
  'a.approvalNeeded': ['Approval needed', '需要批准'],
  'a.approvalNeededN': ['Approval needed (1 of {n})', '需要批准（共 {n} 项，第 1 项）'],
  'a.approveAppliesPatch': ['Approving lets Codex apply this entire patch.', '批准后 Codex 将应用整个补丁。'],
  'a.reviewDiff': ['Review diff', '查看差异'],
  'a.reviewDiffTip': ['Open a before/after diff of the proposed change', '打开拟议修改的前后对比'],
  'a.reviewDetails': ['Review details', '查看详情'],
  'a.approve': ['✓ Approve', '✓ 批准'],
  'a.reject': ['✕ Reject', '✕ 拒绝'],

  // timeline
  'a.timeline': ['Timeline', '时间线'],
  'a.operations': ['Agent operations', '代理操作'],
  'a.noOps': ['No operations yet. Click "Start demo" to run the simulated task.', '暂无操作。点击"开始演示"运行模拟任务。'],
  'a.hiddenOps': ['{n} earlier operations are kept in history but not shown.', '{n} 个较早的操作保存在历史中，但未显示。'],
  'a.selectOpen': ['Select and open in editor', '选择并在编辑器中打开'],
  'a.select': ['Select', '选择'],
  'a.command': ['command', '命令'],
  'a.commandSimulated': ['command (simulated)', '命令（模拟）'],
  'a.observedTip': ['Reported by the agent; Visual Agent could not block it.', '由代理报告；Visual Agent 无法阻止。'],
  'a.interceptedTip': ['The agent waited for a decision before running it.', '代理在执行前等待了你的决定。'],

  // details
  'a.details': ['Operation #{n} details', '操作 #{n} 详情'],
  'a.detailsAria': ['Operation details', '操作详情'],
  'a.selectHint': ['Select an operation to see its details.', '选择一个操作以查看详情。'],
  'f.type': ['Type', '类型'],
  'f.status': ['Status', '状态'],
  'f.file': ['File', '文件'],
  'f.function': ['Function', '函数'],
  'f.lineHint': ['Line hint', '行号提示'],
  'f.time': ['Time', '时间'],
  'f.rationale': ['Rationale', '理由'],
  'f.result': ['Result', '结果'],
  'f.control': ['Control', '控制'],
  'f.change': ['Change', '修改'],
  'f.operationId': ['Operation ID', '操作 ID'],
  'f.command': ['Command', '命令'],
  'f.cwd': ['Working dir', '工作目录'],
  'f.exitCode': ['Exit code', '退出码'],
  'f.started': ['Started', '开始'],
  'f.finished': ['Finished', '结束'],
  'a.filesOneDecision': ['{n} files, one decision', '{n} 个文件，一次决定'],
  'a.gotoCode': ['Go to code', '转到代码'],
  'a.gotoCodeTip': ['Open the file and highlight the function/line', '打开文件并高亮函数/行'],
  'a.commandOutput': ['Command output', '命令输出'],
  'a.aiReview': ['Review change (local AI)', '审查修改（本地 AI）'],
  'a.aiReviewTip': ['Ask the selected local Ollama model to review this change (runs only now, read-only)', '让所选的本地 Ollama 模型审查此修改（仅此时运行，只读）'],
  'a.aiError': ['Explain error (local AI)', '解释错误（本地 AI）'],
  'a.aiErrorTip': ['Ask the local model about this failure (read-only)', '让本地模型解释此失败（只读）'],
  'a.export': ['Export…', '导出…'],
  'a.exportTip': ['Preview a Markdown review context built from recorded evidence', '预览基于已记录证据生成的 Markdown 审查上下文'],
  'a.affectedFunctions': ['Affected functions (parsed from the file)', '受影响的函数（从文件解析）'],
  'a.gotoFunction': ['Go to this function', '转到此函数'],
  'a.changedLines': ['Changed lines (from the patch)', '修改的行（来自补丁）'],
  'a.outputCombined': ['output (stdout + stderr, as reported by Codex)', '输出（stdout + stderr，按 Codex 报告）'],
  'a.auditTrail': ['Audit trail', '审计记录'],
  'a.by': ['by', '执行者'],
  'vm.line': ['line {n}', '第 {n} 行'],
  'vm.lines': ['lines {a}–{b}', '第 {a}–{b} 行'],
  'vm.removedOriginal': ['(removed, original file)', '（已删除，原文件）'],
  'vm.originalFile': ['(original file)', '（原文件）'],

  // statuses / types / control labels (display only; data keeps English enums)
  'status.Proposed': ['Proposed', '已提议'],
  'status.Running': ['Running', '运行中'],
  'status.Completed': ['Completed', '已完成'],
  'status.Failed': ['Failed', '失败'],
  'status.Rejected': ['Rejected', '已拒绝'],
  'status.Cancelled': ['Cancelled', '已取消'],
  'status.Stopped': ['Stopped', '已停止'],
  'type.Read': ['Read', '读取'],
  'type.Analyze': ['Analyze', '分析'],
  'type.Edit': ['Edit', '编辑'],
  'type.Execute': ['Execute', '执行'],
  'type.Test': ['Test', '测试'],
  'type.Summary': ['Summary', '总结'],
  'type.Instruct': ['Instruct', '指令'],
  'ctl.OBSERVED': ['OBSERVED', '仅观察'],
  'ctl.INTERCEPTED': ['INTERCEPTED', '已拦截'],
  'ctl.GATED': ['GATED', '需批准'],
  'ctl.explain.instruct': ['Your instruction to the running agent. Instructions cannot change the sandbox or approval policy.', '你发给运行中代理的指令。指令无法更改沙箱或审批策略。'],
  'ctl.explain.observed': ['Observed only: the agent reported this operation without asking. Visual Agent could not block it; it was constrained only by the agent sandbox (Codex read-only).', '仅观察：代理未经询问就报告了此操作。Visual Agent 无法阻止它，只受代理沙箱（Codex 只读）约束。'],
  'ctl.explain.interceptedEdit': ['Intercepted: Codex waited for a decision before applying this patch. A decision covers the ENTIRE patch, not individual functions.', '已拦截：Codex 在应用此补丁前等待了决定。决定针对整个补丁，而非单个函数。'],
  'ctl.explain.intercepted': ['Intercepted: the agent waited for a decision before running this. Approved commands still run inside the read-only sandbox.', '已拦截：代理在执行前等待了决定。已批准的命令仍在只读沙箱中运行。'],
  'ctl.explain.simulated': ['Simulated: dispatched by the Visual Agent controller; nothing real was executed.', '模拟：由 Visual Agent 控制器分派；没有真实执行任何操作。'],
  'ctl.explain.controller': ['Dispatched by the Visual Agent controller.', '由 Visual Agent 控制器分派。'],

  // reviewer panel
  'r.title': ['Local AI Reviewer', '本地 AI 审查'],
  'r.disabled': ['The Local AI Reviewer is disabled. No requests are made to Ollama.', '本地 AI 审查已禁用，不会向 Ollama 发送任何请求。'],
  'r.openSettings': ['Open settings', '打开设置'],
  'r.connected': ['Connected to Ollama · {n} model(s)', '已连接 Ollama · {n} 个模型'],
  'r.checking': ['Checking Ollama…', '正在检查 Ollama…'],
  'r.unavailable': ['Ollama unavailable', 'Ollama 不可用'],
  'r.unknown': ['Not checked yet', '尚未检查'],
  'r.local': ['LOCAL', '本地'],
  'r.localTip': ['Requests go only to {endpoint}', '请求只发送到 {endpoint}'],
  'r.model': ['Local model', '本地模型'],
  'r.refreshTip': ['Refresh installed models (/api/tags)', '刷新已安装的模型（/api/tags）'],
  'r.onlyOnClick': ['Runs only when you click. Read-only: nothing is edited or executed.', '仅在你点击时运行。只读：不会编辑或执行任何内容。'],
  'r.selected': ['Selected in Agent Activity', '在"代理活动"中选中'],
  'r.explain': ['Explain function', '解释函数'],
  'r.explainTip': ['Explain the function at the editor cursor', '解释编辑器光标所在的函数'],
  'r.review': ['Review change', '审查修改'],
  'r.reviewTip': ['Review the selected Edit operation, or the recorded change to the function at the cursor', '审查选中的编辑操作，或光标所在函数的已记录修改'],
  'r.impact': ['Impact analysis', '影响分析'],
  'r.impactTip': ['Callers and callees of the function at the cursor (local static analysis), then a model assessment', '光标所在函数的调用者与被调用者（本地静态分析），再由模型评估'],
  'r.error': ['Explain error', '解释错误'],
  'r.errorTip': ['Explain the selected failed command or test', '解释选中的失败命令或测试'],
  'r.cancel': ['■ Cancel', '■ 取消'],
  'r.cancelTip': ['Cancel the running local request', '取消正在运行的本地请求'],
  'r.streaming': ['streaming…', '生成中…'],
  'r.done': ['done in {s} s', '完成，用时 {s} 秒'],
  'r.doneCached': ['done (cached)', '完成（缓存）'],
  'r.cancelled': ['cancelled', '已取消'],
  'r.errorStatus': ['error', '出错'],
  'r.truncated': ['context truncated', '上下文已截断'],
  'r.unverified': ['Model-generated, not verified by execution.', '模型生成，未经执行验证。'],
  'r.reasoning': ['Model reasoning', '模型推理过程'],
  'r.waiting': ['Waiting for the model… (the first request may load the model into memory)', '等待模型…（首次请求可能需要将模型加载到内存）'],
  'r.openBeside': ['Open beside', '在旁边打开'],
  'r.copy': ['Copy', '复制'],
  'r.exportMd': ['Export .md', '导出 .md'],
  'r.recent': ['Recent reviews', '最近的审查'],
  'r.translate': ['Translate / 翻译', 'Translate / 翻译'],
  'r.translateTip': ['Translate this result with the selected local model (original is kept)', '使用所选本地模型翻译此结果（保留原文）'],
  'r.translateTo': ['Target', '目标语言'],
  'r.view': ['Show', '显示'],
  'r.viewOriginal': ['Original', '原文'],
  'r.translating': ['translating…', '翻译中…'],
  'r.codeChanged': ['Warning: some code spans were changed by the translation; compare with the original.', '警告：翻译改动了部分代码片段，请与原文对照。'],
  'r.responseLanguage': ['Response language', '回答语言'],
  // v0.4: New Agent Task + multi-turn sessions
  'nt.title': ['New Agent Task', '新建代理任务'],
  'nt.provider': ['Coding agent', '编码代理'],
  'nt.available': ['Available', '可用'],
  'nt.unavailable': ['Unavailable', '不可用'],
  'nt.experimental': ['EXPERIMENTAL', '实验性'],
  'nt.auth': ['Auth', '认证'],
  'nt.workspace': ['Workspace', '工作区'],
  'nt.model': ['Coding model', '编码模型'],
  'nt.refreshModels': ['Refresh models from the provider', '从提供方刷新模型列表'],
  'nt.loadingModels': ['Discovering models from the provider…', '正在从提供方发现模型…'],
  'nt.incompatible': ['incompatible', '不兼容'],
  'nt.providerUnavailable': ['This provider is unavailable; see the reason above.', '该提供方不可用，原因见上。'],
  'nt.effort': ['Reasoning effort', '推理强度'],
  'nt.effort.low': ['Light (low)', '轻量 Light（low）'],
  'nt.effort.medium': ['Medium', '中等（medium）'],
  'nt.effort.high': ['High', '高（high）'],
  'nt.effort.xhigh': ['Extra high', '更高（xhigh）'],
  'nt.effort.max': ['Maximum', '最高（max）'],
  'nt.effort.ultra': ['Ultra', '超高（ultra）'],
  'nt.browseWorkspace': ['Browse project…', '浏览项目文件夹…'],
  'nt.workspaceHint': ['The selected project is opened and located in Explorer. Other folders remain open so your session stays available.', '所选项目会在左侧资源管理器打开并定位。当前其他文件夹会保留，会话不会被关闭。'],
  'nt.profile': ['Execution profile', '执行配置'],
  'nt.writes': ['CAN WRITE (with approval)', '可写（需批准）'],
  'nt.instructions': ['Task instructions', '任务说明'],
  'nt.instructionsHint': ['e.g. Analyze this project and list potential bugs', '例如：分析此项目并列出潜在的 bug'],
  'nt.reviewerIndependent': ['The Local AI Reviewer model is chosen separately and is not affected', '本地 AI 审查的模型单独选择，不受影响'],
  'nt.start': ['▶ Start', '▶ 开始'],
  'nt.starting': ['Starting…', '正在启动…'],
  'nt.refreshProviders': ['Re-check providers', '重新检查提供方'],
  'a.newTask': ['▶ New agent task…', '▶ 新建代理任务…'],
  'a.conversation': ['Conversation history', '对话历史'],
  'state.ready': ['Turn complete · waiting for input', '本轮完成，等待输入'],
  'chat.title': ['Conversations', '会话'],
  'chat.new': ['New conversation', '新建会话'],
  'chat.open': ['Open conversation', '进入会话'],
  'chat.send': ['Send', '发送'],
  'chat.sending': ['Sending…', '正在发送…'],
  'chat.placeholder': ['Explain, propose an edit, or ask a follow-up…', '解释代码、提出修改，或继续追问…'],
  'chat.turns': ['Turn results', '每轮结果'],
  'chat.turnFailed': ['Turn ended with failures', '本轮已结束，存在失败项'],
  'chat.native': ['Reopens the saved OpenCode session with the same model and project.', '将恢复原 OpenCode 会话，沿用原模型和项目。'],
  'chat.context': ['Continues in this conversation using saved context in a new provider session.', '将在此会话中使用已保存上下文继续，底层代理会创建新会话。'],
  'chat.live': ['Same session · send your next instruction when this turn finishes.', '同一会话：本轮结束后可直接发送下一条指令。'],
  'chat.busy': ['The agent is working or waiting for approval. Wait, approve, or stop this turn.', '代理正在处理或等待审批。请等待、审批，或停止本轮。'],
  'chat.other': ['Another conversation is active. End it before continuing this one.', '另一个会话尚未结束，请先结束该会话。'],
  'chat.empty': ['Create a conversation to explain code, review edits and run tests with one model.', '新建会话，用同一个模型解释代码、审查修改并运行测试。'],
  'chat.readOnly': ['Read-only: explain and inspect; files cannot be changed.', '只读：可以解释和查看，不会修改文件。'],
  'chat.approvedWrites': ['Edits and commands require your approval.', '可修改：文件编辑和命令需要你批准。'],
  'chat.needsSettings': ['This older record has no saved model/project settings. Configure a new task from its history.', '这条旧记录没有保存模型和项目配置，需要从历史配置新任务。'],
  'chat.configure': ['Configure continuation', '配置后继续'],
  'chat.fallback': ['Continue with saved context instead', '改用已保存上下文继续'],
  'chat.explain': ['Explain the current function', '解释当前函数'],
  'chat.project': ['Show project in Explorer', '打开项目文件夹'],
  'a.openConversation': ['Open saved transcript', '查看已保存对话'],
  'a.continueHistory': ['Copy history into a new task…', '复制历史为新任务…'],
  'a.conversationHint': ['Use Open conversation to continue inline. This section previews saved text; copying history creates a separate task. Up to 20 tasks and 200 messages per task are retained; long text is truncated.', '点击“进入会话”可直接续聊。此处仅预览保存的文字；“复制历史为新任务”会另建任务。默认保留最近 20 个任务、每个任务 200 条消息，长文本会截断。'],
  'a.you': ['You', '你'],
  'a.assistant': ['Assistant', '代理'],
  'a.newTaskTip': ['Choose Codex, Claude Code or a local agent, a model and a profile', '选择 Codex、Claude Code 或本地代理，以及模型和执行配置'],
  'a.endSession': ['■ End session', '■ 结束会话'],
  'a.endSessionTip': ['Finish the multi-turn session (the task completes)', '结束多轮会话（任务完成）'],
  'a.awaitingInput': ['Waiting for your next instruction (Send follow-up)', '等待你的下一条指令（发送后续指令）'],
  'a.followUp': ['✎ Send follow-up', '✎ 发送后续指令'],
  'err.ollamaUnreachable': ['Cannot reach Ollama. Is it running?', '无法连接 Ollama，它是否正在运行？'],
  'err.noModels': ['Ollama is running but has no models installed.', 'Ollama 正在运行，但没有安装任何模型。'],
  'err.notInstalled': ['The selected model is not installed in Ollama.', '所选模型未安装在 Ollama 中。'],
  'err.endpoint': ['The Ollama endpoint is not allowed.', '不允许使用该 Ollama 地址。'],
} satisfies Record<string, Entry>;

export type StringKey = keyof typeof STRINGS;

export function format(template: string, vars?: Record<string, string | number>): string {
  return vars ? template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : template;
}

/** Localize one key. Bilingual: "中文 / English" (identical strings are not duplicated). */
export function t(key: StringKey, lang: UiLanguage, vars?: Record<string, string | number>): string {
  const [en, zh] = STRINGS[key] as Entry;
  if (lang === 'en') {
    return format(en, vars);
  }
  if (lang === 'zh-CN') {
    return format(zh, vars);
  }
  return zh === en ? format(en, vars) : `${format(zh, vars)} / ${format(en, vars)}`;
}

/** All strings for a language, for the webviews (templates left unformatted). */
export function resolveStrings(lang: UiLanguage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(STRINGS) as StringKey[]) {
    out[key] = t(key, lang);
  }
  return out;
}

export type Translator = (key: StringKey, vars?: Record<string, string | number>) => string;
export const translator = (lang: UiLanguage): Translator => (key, vars) => t(key, lang, vars);

const ERROR_MESSAGES: Array<[RegExp, Entry]> = [
  [/Open a source file and place the cursor/, ['Open a source file and place the cursor inside a function.', '请打开源文件并将光标放在函数内。']],
  [/No function found at the cursor/, ['No function found at the cursor. Place the cursor inside a function or select some code.', '光标处没有找到函数。请将光标放在函数内或选中一段代码。']],
  [/inside a named function for impact/, ['Place the cursor inside a named function for impact analysis.', '影响分析需要将光标放在具名函数内。']],
  [/No change recorded by a coding agent/, ['No change recorded by a coding agent touches this function or file in this session.', '本次会话中没有编码代理对该函数或文件的修改记录。']],
  [/no longer in memory/, ['The content of this change is no longer in memory (kept only for the current session).', '该修改的内容已不在内存中（只在当前会话中保留）。']],
  [/already running\. Cancel it first/, ['A local AI request is already running. Cancel it first.', '已有本地 AI 请求正在运行，请先取消。']],
  [/Reviewer is disabled/, ['The Local AI Reviewer is disabled (visualAgent.reviewer.enabled).', '本地 AI 审查已禁用（visualAgent.reviewer.enabled）。']],
  [/Only completed results can be translated/, ['Only completed results can be translated.', '只能翻译已完成的结果。']],
  [/Cannot reach Ollama/, ['Cannot reach Ollama. Is it running?', '无法连接 Ollama，它是否正在运行？']],
  [/not awaiting approval/, ['That operation is not awaiting approval.', '该操作不在等待批准。']],
];

/** Localize a known (English) error message; unknown messages are returned unchanged. */
export function localizeError(message: string, lang: UiLanguage): string {
  for (const [re, [en, zh]] of ERROR_MESSAGES) {
    if (re.test(message)) {
      // Keep the original detail (e.g. endpoint, error code) when it adds information.
      const detail = message.length > en.length + 3 && !message.startsWith(en) ? ` (${message})` : '';
      return lang === 'en' ? message : lang === 'zh-CN' ? zh + detail : `${zh} / ${message}`;
    }
  }
  return message;
}
