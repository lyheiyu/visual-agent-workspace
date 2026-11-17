/**
 * Minimal event emitter with a VS Code–compatible `event` signature.
 *
 * Core modules (controller, recorder, adapters) use this instead of
 * `vscode.EventEmitter` so they stay free of the `vscode` module and can be
 * unit-tested in plain Node.
 */
export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        // A faulty listener must never break the controller loop.
        console.error('[visual-agent] listener error', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
