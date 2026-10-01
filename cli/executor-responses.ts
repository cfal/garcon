import { isRecord } from '@garcon/common/json';
import { isApiProviderId } from '@garcon/common/api-providers';
import { isExecutorId, parseExecutors, type ExecutorSnapshot } from '@garcon/common/executors';
import { CliError } from './errors.js';

export interface ExecutorProvider {
  readonly id: string;
  readonly label: string;
  readonly executorIds: readonly string[];
}

export function executorResponseError(): never {
  throw new CliError('executors', 'server returned an invalid executor management response', 3);
}

export function executorSnapshots(value: unknown): readonly ExecutorSnapshot[] {
  const executors = isRecord(value) ? parseExecutors(value.executors) : null;
  return executors ?? executorResponseError();
}

export function executorProviders(value: unknown): readonly ExecutorProvider[] {
  if (!isRecord(value) || !Array.isArray(value.providers) || !isRecord(value.assignments)
    || !Number.isSafeInteger(value.assignments.revision) || Number(value.assignments.revision) < 0
    || !isRecord(value.assignments.assignments)) executorResponseError();
  const assignments = Object.entries(value.assignments.assignments);
  for (const [id, providers] of assignments) {
    if (!isExecutorId(id) || !Array.isArray(providers) || !providers.every(isApiProviderId)
      || new Set(providers).size !== providers.length) executorResponseError();
  }
  const seen = new Set<string>();
  return value.providers.map((provider: unknown) => {
    if (!isRecord(provider) || !isApiProviderId(provider.id) || typeof provider.label !== 'string' || !provider.label.trim()
      || seen.has(provider.id)) executorResponseError();
    seen.add(provider.id);
    return { id: provider.id, label: provider.label,
      executorIds: assignments.filter(([, ids]) => Array.isArray(ids) && ids.includes(provider.id)).map(([id]) => id) };
  });
}
