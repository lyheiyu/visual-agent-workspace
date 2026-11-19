/**
 * The supplied case: a command Codex (approve-edits profile) asked to run on
 * Windows. It was approved as a plain command and wrote style.css with no
 * diff. Exact quoting and structure as recorded (Codex's POSIX-quoted
 * powershell.exe -Command wrapper, a $stylePath variable, a here-string,
 * Add-Content -LiteralPath); only the CSS body and the path are shortened.
 */
export const CODEX_ADD_CONTENT_CASE =
  "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command '$stylePath = '\"'web/style.css'\n\"'$css = @'\"'\n\n/* Theme. */\n:root {\n  --accent: #0f766e;\n}\nbutton { content: 'a > b'; color: var(--accent); }\n'@\nAdd-Content -LiteralPath \"'$stylePath -Value $css -Encoding UTF8'";
