import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AgentLauncher, TaskSelection } from './AgentLauncher';
import { ProviderId } from './providers';
import { resolveStrings, UiLanguage } from '../i18n/i18n';
import { selectedProjectRoot, selectProjectRoot } from '../navigation/ProjectWorkspace';

/** "New Agent Task" editor panel: provider, model, effort, workspace, profile, instructions. */
export class NewTaskPanel {
  private static current: NewTaskPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly selectedFolders = new Map<string, vscode.Uri>();
  private activeWorkspace = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath : undefined;

  static show(extensionUri: vscode.Uri, launcher: AgentLauncher, language: () => UiLanguage, reviewerModel: () => string | undefined, preferProvider?: ProviderId, seed?: Partial<TaskSelection>): void {
    if (seed && NewTaskPanel.current) NewTaskPanel.current.panel.dispose();
    if (NewTaskPanel.current) {
      NewTaskPanel.current.panel.reveal();
      NewTaskPanel.current.syncWorkspaces();
      if (preferProvider) {
        void NewTaskPanel.current.panel.webview.postMessage({ type: 'preferProvider', provider: preferProvider });
      }
      return;
    }
    NewTaskPanel.current = new NewTaskPanel(extensionUri, launcher, language, reviewerModel, preferProvider, seed);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly launcher: AgentLauncher,
    private readonly language: () => UiLanguage,
    private readonly reviewerModel: () => string | undefined,
    private readonly preferProvider?: ProviderId,
    private readonly seed?: Partial<TaskSelection>,
  ) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('visualAgent.newTask', 'New Agent Task', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true,
    });
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    w.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'activity.css'))}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'newTask.css'))}">
<title>New Agent Task</title></head><body><div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'newTask.js'))}"></script></body></html>`;
    this.disposables.push(
      w.onDidReceiveMessage((m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncWorkspaces()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const root = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
        if (root) {
          selectProjectRoot(root);
          this.activeWorkspace = root;
          this.syncWorkspaces();
        }
      }),
    );
  }

  private workspaceContext() {
    const open = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    const active = vscode.window.activeTextEditor?.document.uri;
    const preferred = selectedProjectRoot();
    const defaultWorkspace = (open.some((w) => w.path === preferred) ? preferred : undefined) ?? (active ? vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath : undefined)
      ?? (open.some((w) => w.path === this.activeWorkspace) ? this.activeWorkspace : undefined) ?? open[0]?.path;
    const workspaces = [...open];
    for (const [folderPath, uri] of this.selectedFolders) {
      if (!workspaces.some((w) => w.path === folderPath)) workspaces.push({ name: uri.path.split('/').pop() || folderPath, path: folderPath });
    }
    return { workspaces, defaultWorkspace };
  }

  private syncWorkspaces(): void {
    void this.panel.webview.postMessage({ type: 'workspacesUpdated', ...this.workspaceContext() });
  }

  private async init(): Promise<void> {
    const lang = this.language();
    const providers = await this.launcher.providers();
    if (this.seed?.workspaceRoot) {
      const uri = vscode.Uri.file(this.seed.workspaceRoot);
      this.selectedFolders.set(uri.fsPath, uri);
    }
    void this.panel.webview.postMessage({
      type: 'init',
      strings: resolveStrings(lang),
      providers,
      ...this.workspaceContext(),
      last: this.launcher.lastSelection(),
      prefer: this.preferProvider,
      reviewerModel: this.reviewerModel(),
      seed: this.seed,
    });
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as Record<string, any>;
    const provider = (['codex', 'claude-code', 'local'] as const).find((p) => p === m.provider);
    try {
      switch (m.type) {
        case 'ready':
        case 'refreshProviders':
          await this.init();
          return;
        case 'models': {
          if (!provider || typeof m.workspace !== 'string') {
            return;
          }
          const models = await this.launcher.models(provider, m.workspace, m.refresh === true);
          void this.panel.webview.postMessage({ type: 'models', provider, workspace: m.workspace, models });
          return;
        }
        case 'browseWorkspace': {
          const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: resolveStrings(this.language())['nt.browseWorkspace'],
          });
          const folder = folders?.[0];
          if (folder?.scheme === 'file') {
            this.selectedFolders.set(folder.fsPath, folder);
            const selection = m.selection as Partial<TaskSelection> | undefined;
            await this.launcher.showProject(folder.fsPath, true, {
              provider, workspaceRoot: folder.fsPath,
              model: typeof selection?.model === 'string' ? selection.model : undefined,
              effort: typeof selection?.effort === 'string' ? selection.effort : undefined,
              profile: typeof selection?.profile === 'string' ? selection.profile : undefined,
              instructions: typeof selection?.instructions === 'string' ? selection.instructions.slice(0, 32000) : '',
            });
            await this.panel.webview.postMessage({ type: 'workspaceSelected', workspace: { name: folder.path.split('/').pop() || folder.fsPath, path: folder.fsPath } });
          }
          return;
        }
        case 'selectWorkspace': {
          if (typeof m.workspace === 'string' && ((vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === m.workspace) || this.selectedFolders.has(m.workspace))) {
            await this.launcher.showProject(m.workspace);
          }
          return;
        }
        case 'start': {
          const s = m.selection as Partial<TaskSelection>;
          if (!provider || typeof s?.model !== 'string' || typeof s.profile !== 'string' || typeof s.workspaceRoot !== 'string' || typeof s.instructions !== 'string') {
            return;
          }
          if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === s.workspaceRoot) && !this.selectedFolders.has(s.workspaceRoot)) {
            throw new Error('Choose an open workspace folder or browse for a project folder.');
          }
          const taskId = await this.launcher.start({
            provider,
            model: s.model,
            effort: typeof s.effort === 'string' && s.effort ? s.effort : undefined,
            profile: s.profile,
            workspaceRoot: s.workspaceRoot,
            instructions: s.instructions.slice(0, 32000),
          });
          if (taskId) {
            void vscode.commands.executeCommand('visualAgent.activity.focus');
            void vscode.commands.executeCommand('visualAgent.openConversations', taskId);
            this.panel.dispose();
          } else {
            void this.panel.webview.postMessage({ type: 'error', message: '' });
          }
          return;
        }
      }
    } catch (err) {
      void this.panel.webview.postMessage({ type: m.type === 'models' ? 'models' : 'error', provider, workspace: m.workspace, models: [], error: (err as Error).message, message: (err as Error).message });
    }
  }

  private dispose(): void {
    NewTaskPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}
