import { EventEmitter } from 'events';
import { SCHEDULED_TASK_RUN_LOG_LIMIT } from '../../common/scheduled-tasks.js';

export class ScheduledTaskRunLog extends EventEmitter {
  #entries: string[] = [];

  append(message: string, now = new Date()): void {
    const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 1_000);
    if (!normalized) return;
    this.#entries = [...this.#entries, `[${now.toISOString()}] ${normalized}`].slice(-SCHEDULED_TASK_RUN_LOG_LIMIT);
    this.emit('appended');
  }

  list(): string[] {
    return [...this.#entries];
  }
}
