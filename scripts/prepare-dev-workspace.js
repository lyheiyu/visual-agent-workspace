// A workspace file prevents extension-host restarts when adding another project folder.
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../.vscode/visual-agent.local.code-workspace');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ folders: [{ path: '../demo-workspace' }], settings: {} }, null, 2) + '\n');
