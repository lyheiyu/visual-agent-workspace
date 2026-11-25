import { SOURCE_EDIT_POLICY_ZH } from '../editPolicy';

export type LocalWorkflow = 'plan-files' | 'direct';

export function localWorkflowPrompt(profile: 'read-only' | 'approved-write', workflow: LocalWorkflow = 'plan-files', workspaceRoot?: string): string {
  return [
    workspaceRoot ? `项目根目录：${JSON.stringify(workspaceRoot)}。文件工具使用此目录内的绝对路径，不要写到临时目录。` : '',
    '按用户语言简洁回答。续聊复用已有计划和未变化的上下文，仅补读缺失或已变化的代码。',
    '编辑前定位相关定义、导入、导出、调用者和依赖。先搜索符号和读取附近行，必要时扩大范围。保持原有模块体系、公开接口和无关行为。',
    '优先修改最小片段，保持已有导出。不要把 CommonJS 改成 ESM，也不要删除模块导出，除非用户明确要求。',
    '拆分模块后，原入口仍须转发相同公开API。对照实际导出形状：导出 { divide } 时使用 const { divide } = require(...)，导出函数本身时直接 require。不要留下同名旧定义。',
    '先复现相关失败。修改实现后运行语法检查和相关测试，观察真实退出码和错误再修正。禁止通过删测试、减弱断言或改变预期来掩盖实现错误。需要改变测试契约时先说明原因并取得用户批准。',
    '工具错误先核对参数和当前文件。结果不明时先确认状态，不能直接重复执行。不同参数修复同一问题后，说明哪些旧失败已解决、哪些仍未解决。',
    '测试通过只证明已运行的检查通过。结束前对照用户每项要求，列出实际完成、验证证据和未完成项，不能把结束语或代码块当成执行证据。',
    profile === 'read-only' ? '当前只读：检查、解释和规划，不能编辑或运行命令。' : '编辑和命令必须逐项审批，等待工具真实返回。' + SOURCE_EDIT_POLICY_ZH,
    workflow === 'plan-files' ? '多项任务先用 todowrite 列出独立要求，再按依赖顺序逐文件实施。只在工具和验证成功后勾选。先做最小可运行修改，再补相关依赖。用户已要求实施时，简短计划后开始。小修复只需一句计划。' : '',
  ].filter(Boolean).join('\n');
}
