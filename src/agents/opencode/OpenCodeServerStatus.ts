import * as vscode from 'vscode';
import { OpenCodeServerManager, ServerStatus } from './OpenCodeServerManager';

/**
 * Status bar item + commands for the local OpenCode server:
 * OpenCode: Starting / Running / Stopped / Error, with Restart, Stop, Start
 * and Show log. Shown once the local agent is in use (or the server is not
 * Stopped). Never makes model requests.
 */
export class OpenCodeServerStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('visualAgent.opencodeServer', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private lastErrorShown: string | undefined;

  constructor(
    private readonly manager: OpenCodeServerManager,
    private readonly log: vscode.OutputChannel,
    private readonly startNow: () => Promise<string | undefined>,
    private readonly localUsed: () => boolean,
  ) {
    this.item.name = 'OpenCode server';
    this.item.command = 'visualAgent.opencode.menu';
    const sub = manager.onStatus((s) => this.render(s));
    this.disposables.push(
      { dispose: () => sub.dispose() },
      vscode.commands.registerCommand('visualAgent.opencode.menu', () => this.menu()),
      vscode.commands.registerCommand('visualAgent.opencode.restart', () => this.restart()),
      vscode.commands.registerCommand('visualAgent.opencode.stop', () => this.stop()),
      vscode.commands.registerCommand('visualAgent.opencode.start', () => this.start()),
      vscode.commands.registerCommand('visualAgent.opencode.showLog', () => this.log.show(true)),
    );
    this.render(manager.status());
  }

  render(s: ServerStatus): void {
    const icon = { Starting: '$(sync~spin)', Running: '$(server-process)', Stopped: '$(circle-slash)', Error: '$(error)' }[s.state];
    this.item.text = `${icon} OpenCode: ${s.state}`;
    this.item.backgroundColor = s.state === 'Error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    const lines = [
      `**Local OpenCode server: ${s.state}**`,
      s.message ? `\n\n${s.message}` : '',
      s.pid ? `\n\nPID ${s.pid} · 127.0.0.1:${s.port}${s.version ? ` · OpenCode ${s.version}` : ''}${s.adopted ? ' · re-adopted from an earlier session' : ''}` : '',
      s.model ? `\n\nModel ${s.model} · profile ${s.profile}` : '',
      `\n\nConnections: ${s.connections}${s.restarts ? ` · automatic restarts: ${s.restarts}` : ''}`,
      '\n\nStarts automatically with a local-agent task. Click for Restart / Stop / Show log.',
    ];
    this.item.tooltip = new vscode.MarkdownString(lines.join(''));
    if (s.state !== 'Stopped' || this.localUsed()) this.item.show();
    else this.item.hide();
    if (s.state === 'Error' && s.message && s.message !== this.lastErrorShown) {
      this.lastErrorShown = s.message;
      void vscode.window.showErrorMessage(`OpenCode server: ${s.message}`, 'Restart', 'Show log').then((c) => (c === 'Restart' ? this.restart() : c === 'Show log' ? this.log.show(true) : undefined));
    }
    if (s.state === 'Running') this.lastErrorShown = undefined;
  }

  private async menu(): Promise<void> {
    const s = this.manager.status();
    const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [];
    if (s.state === 'Stopped' || s.state === 'Error') items.push({ label: '$(play) Start OpenCode server', description: 'with the last local-agent model and profile', run: () => this.start() });
    if (s.state !== 'Stopped') items.push({ label: '$(debug-restart) Restart OpenCode server', run: () => this.restart() });
    if (s.state === 'Running' || s.state === 'Starting') items.push({ label: '$(debug-stop) Stop OpenCode server', description: s.connections ? `${s.connections} active connection(s) will fail` : undefined, run: () => this.stop() });
    items.push({ label: '$(output) Show log', run: () => this.log.show(true) });
    const pick = await vscode.window.showQuickPick(items, { title: `OpenCode server: ${s.state}${s.message ? ` (${s.message.slice(0, 80)})` : ''}` });
    await pick?.run();
  }

  private async confirmIfBusy(action: string): Promise<boolean> {
    const n = this.manager.status().connections;
    if (!n) return true;
    const ok = await vscode.window.showWarningMessage(`${action} the OpenCode server? The running local-agent turn will fail; you can continue the same session afterwards.`, { modal: true }, action);
    return ok === action;
  }

  private async restart(): Promise<void> {
    if (!(await this.confirmIfBusy('Restart'))) return;
    try {
      if (this.manager.hasLaunch()) await this.manager.restart();
      else await this.start();
    } catch (err) {
      void vscode.window.showErrorMessage(`OpenCode server restart failed: ${(err as Error).message}`, 'Show log').then((c) => c && this.log.show(true));
    }
  }

  private async stop(): Promise<void> {
    if (!(await this.confirmIfBusy('Stop'))) return;
    await this.manager.stop('stopped by the user');
  }

  private async start(): Promise<void> {
    try {
      const why = await this.startNow();
      if (why) void vscode.window.showInformationMessage(why);
    } catch (err) {
      void vscode.window.showErrorMessage(`OpenCode server could not start: ${(err as Error).message}`, 'Show log').then((c) => c && this.log.show(true));
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
