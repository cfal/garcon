import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { AutomationLifecycle, AutomationMutation } from './lifecycle.js';

export class ChatMutationGuard {
  constructor(readonly lock: KeyedPromiseLock, private readonly lifecycle: AutomationLifecycle) {}

  run<T>(chatId: string, action: AutomationMutation, operation: (beforeMutation: () => void) => Promise<T>): Promise<T> {
    return this.lock.runExclusive(`chat:${chatId}`, () => operation(() => this.observe(chatId, action)));
  }

  observe(chatId: string, action: AutomationMutation): void {
    this.lifecycle.observe(chatId, action);
  }
}
