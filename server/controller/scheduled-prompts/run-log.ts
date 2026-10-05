import {
  SCHEDULED_PROMPT_RUN_LOG_LIMIT,
  type ScheduledPromptRunLogEntry,
  type ScheduledPromptRunOutcome,
} from '../../../common/scheduled-prompts.js';

// The prompt a run belongs to, captured when the run is recorded.
export interface ScheduledPromptRunSource {
  scheduledPromptId: string;
  promptLabel: string;
}

export interface ScheduledPromptRunRecord {
  // Null for scheduler-wide events that no single prompt owns.
  source: ScheduledPromptRunSource | null;
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
      scheduledPromptId: record.source?.scheduledPromptId ?? null,
      promptLabel: record.source?.promptLabel ?? null,
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
