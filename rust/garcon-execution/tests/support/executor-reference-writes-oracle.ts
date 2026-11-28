import { DomainError } from '../../../../server/common/domain-error.ts';
import { ExecutorReferenceWrites } from '../../../../server/controller/executors/reference-writes.ts';

type Ids = Array<string | null>;
type Step =
  | ['retain', string, Ids, Ids?]
  | ['assert', string]
  | ['release', string];

export function referenceWritesTrace(steps: Step[]) {
  const checks: string[] = [];
  const guard = new ExecutorReferenceWrites((id) => {
    checks.push(id);
    if (id === 'missing') throw new Error('Missing executor');
    if (id === 'changing') {
      throw new DomainError('EXECUTOR_IN_USE', 'Executor is changing', 409, true);
    }
  });
  const releases = new Map<string, () => void>();
  const outcomes = steps.map(([kind, id, next, current]) => {
    try {
      if (kind === 'retain') releases.set(id, guard.retain(next, current));
      else if (kind === 'assert') guard.assertNoWrites(id);
      else releases.get(id)?.();
      return null;
    } catch (error) {
      const typed = error as Error & Partial<DomainError>;
      return { message: typed.message, code: typed.code ?? null, status: typed.status ?? null, retryable: typed.retryable ?? null };
    }
  });
  return { outcomes, checks };
}
