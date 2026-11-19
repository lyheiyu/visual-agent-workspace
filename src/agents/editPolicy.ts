/**
 * Standing instruction given to every coding agent: source changes go through
 * the file-edit / patch tool, which Visual Agent Workspace shows as a diff
 * before approval. Enforcement does not depend on the agent following it:
 * explicit shell writes are blocked before execution (see detectShellWrites).
 */
export const SOURCE_EDIT_POLICY = [
  'Make every change to project files with your file edit / patch tool (for example apply_patch, edit or write), never through a shell command.',
  'The user reviews each proposed patch as a diff and it is applied only after approval, so propose patches even if the shell sandbox is read-only.',
  'Shell commands that write file content (Add-Content, Set-Content, Out-File, > or >> redirection, tee, sed -i, or inline python/node scripts that write files) are blocked before they run, because they cannot be reviewed as a diff.',
  'Use shell commands only to read, search, test or build.',
].join(' ');

/** Same rule for the local (OpenCode) agent's Chinese system prompt. */
export const SOURCE_EDIT_POLICY_ZH =
  '修改项目文件只能用文件编辑/写入（补丁）工具，不要用命令写文件：Add-Content、Set-Content、Out-File、> 或 >> 重定向、tee、sed -i、写文件的 python/node 内联脚本都会在执行前被拦截，因为它们无法先以 diff 供用户审查。命令只用于读取、搜索、测试和构建。';
