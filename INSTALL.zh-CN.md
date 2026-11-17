# 安装、换电脑与 GitHub

推荐同时保留 GitHub 源码和 VSIX 安装包。GitHub 用来保存和更新项目，VSIX 用来安装扩展；日常使用不需要源码，也不用按 F5。

## 直接安装

1. 下载 `visual-agent-workspace-0.5.0.vsix`。
2. 打开 VS Code，按 `Ctrl+Shift+X` 打开扩展。
3. 点击扩展面板右上角 `…` → **从 VSIX 安装 / Install from VSIX…**，选择下载的文件。
4. 打开你的真实项目，点击左侧 **Visual Agent** → **会话**。

升级时安装新的 VSIX 即可。要发布到公开扩展市场，还需注册 publisher；个人跨电脑使用可先用 GitHub 和 VSIX。

## 每台电脑仍需要配置的内容

- **Codex**：安装官方 Codex 扩展或 CLI，在该电脑登录。
- **Claude 订阅**：安装官方 Claude Code 扩展或 CLI，通过官方界面登录订阅账号。设置 `visualAgent.claude.authMode` 为 `subscription` 可明确只使用订阅。扩展会检查实际认证，不会自动改用 API 计费。
- **本地模型**：安装 Ollama 并下载模型；编程代理还需要安装 OpenCode。命令是 `npm install -g opencode-ai`，也可以设置 `visualAgent.local.opencodePath`。

账号凭据、模型权重、项目文件和本地会话记录不会随源码或 VSIX 自动迁移。当前版本已在 Windows 验证；其他系统如自动发现程序失败，请设置对应 executablePath。

## 从源码构建

需要 Node.js 22+。

```powershell
npm ci
npm test
npm run package:vsix
```

安装包输出到 `artifacts/`。该目录、`node_modules/`、测试缓存和本地工作区配置均不提交到 Git。

## GitHub 工作流

仓库包含自动检查和打包工作流。推送后，在 **Actions** 中下载 `visual-agent-workspace-vsix` 构建产物，解压后安装其中的 VSIX。

给提交打 `v0.5.0` 一类版本标签并推送时，会创建带安装包的 **草稿 Release**。检查后可在 GitHub 发布该草稿。此过程不会发布到 VS Code Marketplace。

如需手动推送，先在 GitHub 建一个空仓库，再在项目终端运行：

```powershell
git remote add origin https://github.com/你的用户名/visual-agent-workspace.git
git push -u origin main
```

请使用 GitHub 的浏览器登录或凭据管理器，不要把 Token 写进源码或远程地址。
