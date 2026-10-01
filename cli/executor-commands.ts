import type { ExecutorSnapshot } from '@garcon/common/executors';
import type { ExecutorCliCommand } from './executor-args.js';
import { GarconTransportError, type GarconClient } from './garcon-client.js';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';
import { terminalLine } from './terminal-output.js';
import { formatTextTable } from './text-table.js';
import { abortableDelay } from './abortable-delay.js';
import { publishAtomicDocument, refuseExistingDocumentOutput } from './atomic-document-output.js';

export type ExecutorCommandClient = Pick<GarconClient, 'listExecutors' | 'createExecutor' | 'updateExecutor'
  | 'deleteExecutor' | 'getExecutorConnection' | 'getExecutorProviders' | 'assignExecutorProvider' | 'unassignExecutorProvider'>;

function requireExecutor(executors: readonly ExecutorSnapshot[], id: string): ExecutorSnapshot {
  const executor = executors.find((entry) => entry.id === id);
  if (!executor) throw new CliError('executors', `executor not found: ${id}`, 3);
  return executor;
}

export function isExecutorMutation(command: ExecutorCliCommand): boolean {
  return ['create', 'update', 'enable', 'disable', 'delete', 'assign-provider', 'unassign-provider'].includes(command.operation.action);
}

async function waitReady(client: ExecutorCommandClient, id: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecutorSnapshot> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const waiting = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let last: ExecutorSnapshot | undefined;
  try {
    while (true) {
      waiting.throwIfAborted();
      last = requireExecutor(await client.listExecutors(waiting), id);
      waiting.throwIfAborted();
      if (last.availability === 'ready') return last;
      if (!last.enabled) throw new CliError('executors', 'executor is disabled', 3);
      await abortableDelay(500, waiting);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new CliError('executors', `timed out waiting for executor readiness${last?.lastError ? `: ${last.lastError.message}` : ''}`, 3);
    throw error;
  }
}

export async function runExecutorCommand(command: ExecutorCliCommand, client: ExecutorCommandClient, output: CliOutput,
  signal?: AbortSignal, onSubmission: () => void = () => {}): Promise<void> {
  const operation = command.operation;
  const result = (value: unknown, human?: string) => output.result(command.json
    ? terminalLine(JSON.stringify(value)) : human ?? terminalLine(JSON.stringify(value)));
  try {
    if (operation.action === 'list') {
      const executors = await client.listExecutors(signal);
      result({ executors }, formatTextTable(['ID', 'LABEL', 'STATUS', 'CLI', 'MANAGEMENT'], executors.map((entry) =>
        [entry.id, terminalLine(entry.label), entry.enabled ? entry.availability : 'disabled', String(entry.allowControllerCli), String(entry.allowExecutorManagement)])));
    } else if (operation.action === 'show') {
      result(requireExecutor(await client.listExecutors(signal), operation.id));
    } else if (operation.action === 'providers') {
      const providers = await client.getExecutorProviders(signal);
      result({ providers }, formatTextTable(['ID', 'LABEL', 'EXECUTORS'], providers.map((entry) =>
        [entry.id, terminalLine(entry.label), entry.executorIds.join(', ')])));
    } else if (operation.action === 'wait') {
      result(await waitReady(client, operation.id, operation.timeoutMs, signal));
    } else if (operation.action === 'connection') {
      if (operation.outputPath) await refuseExistingDocumentOutput({ outputPath: operation.outputPath, phase: 'executors', noun: 'connection' });
      const connection = await client.getExecutorConnection(operation.id, signal);
      if (operation.outputPath) {
        await publishAtomicDocument({ outputPath: operation.outputPath, document: `${connection.connectionUrl}\n`, force: false,
          phase: 'executors', noun: 'connection', temporarySuffix: 'connection', signal });
        output.diagnostic(`Connection credential written to ${terminalLine(operation.outputPath)}`);
      } else result(connection, terminalLine(connection.connectionUrl));
    } else {
      signal?.throwIfAborted();
      onSubmission();
      if (operation.action === 'create') {
        const created = await client.createExecutor(operation.request, signal);
        result(created, created.id);
      } else if (operation.action === 'delete') {
        const remaining = await client.deleteExecutor(operation.id, signal);
        if (remaining.some((entry) => entry.id === operation.id)) throw new CliError('executors', 'executor deletion was not confirmed', 3);
        result({ id: operation.id, deleted: true });
      } else if (operation.action === 'assign-provider' || operation.action === 'unassign-provider') {
        const assigned = operation.action === 'assign-provider';
        const providers = assigned
          ? await client.assignExecutorProvider(operation.id, operation.providerId, signal)
          : await client.unassignExecutorProvider(operation.id, operation.providerId, signal);
        const membership = providers.find((provider) => provider.id === operation.providerId)?.executorIds.includes(operation.id) === true;
        if (membership !== assigned) throw new CliError('executors', 'provider assignment was not confirmed', 3);
        result({ executorId: operation.id, providerId: operation.providerId, assigned });
      } else {
        const request = operation.action === 'update' ? operation.request : { enabled: operation.action === 'enable' };
        result(requireExecutor(await client.updateExecutor(operation.id, request, signal), operation.id));
      }
    }
  } catch (error) {
    if (isExecutorMutation(command) && error instanceof GarconTransportError) {
      throw new CliError('executors', 'executor configuration outcome is unknown; inspect executors and provider assignments before retrying. No automatic retry was made.', 3);
    }
    throw error;
  }
}
