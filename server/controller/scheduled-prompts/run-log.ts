import {
  SCHEDULED_PROMPT_RUN_LOG_LIMIT,
  type ScheduledPromptRunLogEntry,
  type ScheduledPromptRunOutcome,
} from '../../../common/scheduled-prompts.js';

export interface ScheduledPromptRunRecord {
  scheduledPromptId: string | null;
  outcome: ScheduledPromptRunOutcome;
  chatId?: string | null;
  message: string;
}

export class ScheduledPromptRunLog {
  #entries: ScheduledPromptRunLogEntry[] = [];

  append(record: ScheduledPromptRunRecord, now = new Date()): void {
    const message = record.message.replace(/\s+/g, ' ').trim().slice(0, 1_000);
    if (!message) return;
    const entry: ScheduledPromptRunLogEntry = {
      at: now.toISOString(),
      scheduledPromptId: record.scheduledPromptId,
      outcome: record.outcome,
      chatId: record.chatId ?? null,
      message,
    };
    this.#entries = [...this.#entries, entry].slice(-SCHEDULED_PROMPT_RUN_LOG_LIMIT);
  }

  list(): ScheduledPromptRunLogEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}
