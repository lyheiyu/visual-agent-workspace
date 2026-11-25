import * as vscode from 'vscode';

/**
 * Notifications that close themselves.
 *
 * `showInformationMessage` toasts cannot be closed from code: they stay until
 * the user clicks or dismisses them, even after the approval they ask about
 * was decided elsewhere. A progress notification closes as soon as its task
 * resolves, so everything tied to a state (an approval, an edit session) uses
 * this instead. It closes with the state it describes (or after `ms`).
 */
export interface Notice {
  /** Close the notification now. Idempotent. */
  dispose(): void;
  /** Replace the text (the notification stays where it is). */
  update(message: string): void;
  readonly open: boolean;
}

export function showNotice(message: string, opts: { ms?: number } = {}): Notice {
  let close: () => void = () => undefined;
  let open = true;
  let report: ((m: string) => void) | undefined;
  let pending: string | undefined;
  const done = new Promise<void>((resolve) => (close = resolve));
  const timer = opts.ms ? setTimeout(() => close(), opts.ms) : undefined;
  // Not cancellable: a "Cancel" button here would read as cancelling the proposal, while it would only hide the notice.
  void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: message, cancellable: false }, (progress) => {
    report = (m) => progress.report({ message: m });
    if (pending !== undefined) report(pending);
    return done;
  });
  void done.then(() => {
    open = false;
    if (timer) clearTimeout(timer);
  });
  return {
    dispose: () => close(),
    update: (m) => (report ? report(m) : (pending = m)),
    get open() {
      return open;
    },
  };
}
