import type { RetiredPermissionControl } from './contracts.js';

export interface PermissionActionabilityChange {
  readonly control: RetiredPermissionControl;
  readonly actionability: 'claimed' | 'actionable';
}

export class PermissionControlEvents {
  readonly #retired = new Set<(control: RetiredPermissionControl) => void>();
  readonly #actionability = new Set<(event: PermissionActionabilityChange) => void>();

  constructor(private readonly onListenerError: (error: unknown) => void) {}

  subscribeRetired(listener: (control: RetiredPermissionControl) => void): () => void {
    this.#retired.add(listener);
    return () => this.#retired.delete(listener);
  }

  subscribeActionability(listener: (event: PermissionActionabilityChange) => void): () => void {
    this.#actionability.add(listener);
    return () => this.#actionability.delete(listener);
  }

  retire(control: RetiredPermissionControl): void {
    for (const listener of this.#retired) {
      try { listener(control); } catch (error) { this.onListenerError(error); }
    }
  }

  changeActionability(control: RetiredPermissionControl, actionability: PermissionActionabilityChange['actionability']): void {
    const { chatId, viewId, runId, permissionOccurrenceId } = control;
    const event = { control: { chatId, viewId, runId, permissionOccurrenceId }, actionability };
    for (const listener of this.#actionability) {
      try { listener(event); } catch (error) { this.onListenerError(error); }
    }
  }

  clear(): void {
    this.#retired.clear();
    this.#actionability.clear();
  }
}
