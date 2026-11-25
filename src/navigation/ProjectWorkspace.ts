import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PersistedHistory } from '../recorder/EventRecorder';
import type { TaskSelection } from '../agents/AgentLauncher';

export const PROJECT_TRANSFER_KEY = 'visualAgent.pendingProjectWorkspace';
export interface ProjectTransfer {
  workspaceFile: string;
  history: PersistedHistory;
  taskId?: string;
  selection?: Partial<TaskSelection>;
  revealObserver?: boolean;
}

let selectedProject: string | undefined;
export const selectedProjectRoot = () => selectedProject;
export function selectProjectRoot(root: string): void { selectedProject = root; }

/** Show the actual project in VS Code Explorer without replacing the running extension host. */
export async function showProjectFolder(root: string, reveal = true, transition?: { file: vscode.Uri; beforeReload: (workspaceFile: string) => Promise<void> }): Promise<boolean> {
  if (!path.isAbsolute(root)) throw new Error('Select an absolute project folder.');
  const uri = vscode.Uri.file(root);
  const stat = await vscode.workspace.fs.stat(uri);
  if (!(stat.type & vscode.FileType.Directory)) throw new Error('The selected project path is not a folder.');
  selectProjectRoot(uri.fsPath);
  const contains = () => (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file' && path.relative(f.uri.fsPath, uri.fsPath) === '');
  if (!contains()) {
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    if (!vscode.workspace.workspaceFile) {
      if (!transition) throw new Error('A workspace file is needed to show another project without losing the current session.');
      const folders = [...(vscode.workspace.workspaceFolders ?? []).map((f) => ({ path: f.uri.fsPath })), { path: uri.fsPath }];
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(transition.file.fsPath)));
      await vscode.workspace.fs.writeFile(transition.file, Buffer.from(JSON.stringify({ folders, settings: {} }, null, 2)));
      await transition.beforeReload(transition.file.fsPath);
      await vscode.commands.executeCommand('vscode.openFolder', transition.file, { forceNewWindow: false });
      return false;
    }
    await new Promise<void>((resolve, reject) => {
      const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { if (contains()) done(); });
      const timer = setTimeout(() => done(new Error('VS Code did not add the selected project to Explorer.')), 10000);
      function done(error?: Error) {
        clearTimeout(timer); subscription.dispose();
        if (error) reject(error); else resolve();
      }
      if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri })) done(new Error('VS Code could not add this project folder.'));
    });
  }
  if (reveal) {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', uri);
    await vscode.commands.executeCommand('visualAgent.showActivityBeside');
  }
  return true;
}
