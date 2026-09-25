import { effectiveExecutorId, LOCAL_EXECUTOR_ID } from '../../../common/executors.js';
import { DomainError } from '../../common/domain-error.js';

type ExecutorIds = readonly (string | null | undefined)[];
export type RetainExecutorReferences = (next: ExecutorIds, current?: ExecutorIds) => () => void;

export class ExecutorReferenceWrites {
  readonly #writers = new Map<string, number>();

  constructor(private readonly assertWritable: (executorId: string) => void) {}

  retain: RetainExecutorReferences = (next, current = []) => {
    const previous = remoteIds(current);
    const executors = remoteIds(next);
    for (const id of executors) if (!previous.has(id)) this.assertWritable(id);
    for (const id of previous) executors.add(id);
    for (const id of executors) this.#writers.set(id, (this.#writers.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of executors) {
        const remaining = this.#writers.get(id)! - 1;
        if (remaining === 0) this.#writers.delete(id);
        else this.#writers.set(id, remaining);
      }
    };
  };

  assertNoWrites(executorId: string): void {
    if (this.#writers.has(executorId)) {
      throw new DomainError('EXECUTOR_IN_USE', 'A reference to this executor is being saved. Try deleting it after the save finishes.', 409, true);
    }
  }
}

function remoteIds(values: ExecutorIds): Set<string> {
  return new Set(values.map(effectiveExecutorId).filter((id) => id !== LOCAL_EXECUTOR_ID));
}
