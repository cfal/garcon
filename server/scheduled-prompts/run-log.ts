import { SCHEDULED_PROMPT_RUN_LOG_LIMIT } from '../../common/scheduled-prompts.js';

export class ScheduledPromptRunLog {
  #entries: string[] = [];

  append(message: string, now = new Date()): void {
    const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 1_000);
    if (!normalized) return;
    this.#entries = [...this.#entries, `[${now.toISOString()}] ${normalized}`].slice(-SCHEDULED_PROMPT_RUN_LOG_LIMIT);
  }

  list(): string[] {
    return [...this.#entries];
  }
}
