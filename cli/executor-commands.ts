import type { ExecutorSnapshot } from '@garcon/common/executors';
import type { ExecutorCliCommand } from './executor-args.js';
import { GarconHttpError, GarconTransportError, isDefinitiveMutationRejection, type GarconClient } from './garcon-client.js';
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

function isRetryableExecutorReadError(error: unknown): error is GarconTransportError | GarconHttpError {
  if (error instanceof GarconTransportError) return true;
  if (!(error instanceof GarconHttpError) || !error.retryable) return false;
  if (error.errorCode === 'CLI_CONTROLLER_CHANGED') return false;
  return error.status !== 401 && error.status !== 403 && error.status !== 404;
}

async function waitReady(
  client: ExecutorCommandClient,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecutorSnapshot> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let lastSnapshot: ExecutorSnapshot | undefined;
  let lastReadError: Error | undefined;
  try {
    while (true) {
      waitSignal.throwIfAborted();
      try {
        lastSnapshot = requireExecutor(await client.listExecutors(waitSignal), id);
        lastReadError = undefined;
        waitSignal.throwIfAborted();
        if (!lastSnapshot.enabled) throw new CliError('executors', 'executor is disabled', 3);
        if (lastSnapshot.availability === 'ready') return lastSnapshot;
      } catch (error) {
        waitSignal.throwIfAborted();
        if (!isRetryableExecutorReadError(error)) throw error;
        lastReadError = error;
      }
      await abortableDelay(500, waitSignal);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) {
      const message = lastReadError?.message ?? lastSnapshot?.lastError?.message;
      const detail = message ? `: ${message}` : '';
      throw new CliError('executors', `timed out waiting for executor readiness${detail}`, 3);
    }
    throw error;
  }
}

export async function runExecutorCommand(
  command: ExecutorCliCommand,
  client: ExecutorCommandClient,
  output: CliOutput,
  signal?: AbortSignal,
  onSubmission: () => void = () => {},
): Promise<void> {
  const operation = command.operation;
  let submitted = false;
  const writeResult = (value: unknown, human?: string) => {
    if (!command.json && human != null) {
      output.result(human);
    } else {
      output.result(terminalLine(JSON.stringify(value)));
    }
  };
  try {
    switch (operation.action) {
      case 'list': {
        const executors = await client.listExecutors(signal);
        const rows = executors.map((entry) => [
          entry.id,
          terminalLine(entry.label),
          entry.enabled ? entry.availability : 'disabled',
          entry.bulk?.availability ?? '-',
          String(entry.allowControllerCli),
          String(entry.allowExecutorManagement),
        ]);
        writeResult({ executors }, formatTextTable(['ID', 'LABEL', 'STATUS', 'BULK', 'CLI', 'MANAGEMENT'], rows));
        return;
      }
      case 'show':
        writeResult(requireExecutor(await client.listExecutors(signal), operation.id));
        return;
      case 'providers': {
        const providers = await client.getExecutorProviders(signal);
        const rows = providers.map((entry) => [entry.id, terminalLine(entry.label), entry.executorIds.join(', ')]);
        writeResult({ providers }, formatTextTable(['ID', 'LABEL', 'EXECUTORS'], rows));
        return;
      }
      case 'wait':
        writeResult(await waitReady(client, operation.id, operation.timeoutMs, signal));
        return;
      case 'connection': {
        const noOverwriteHint = 'choose a new output path';
        if (operation.outputPath) {
          await refuseExistingDocumentOutput({
            outputPath: operation.outputPath, phase: 'executors', noun: 'connection', noOverwriteHint,
          });
        }
        const connection = await client.getExecutorConnection(operation.id, signal);
        if (operation.outputPath) {
          await publishAtomicDocument({
            outputPath: operation.outputPath,
            document: `${connection.connectionUrl}\n`,
            force: false,
            phase: 'executors',
            noun: 'connection',
            noOverwriteHint,
            temporarySuffix: 'connection',
            signal,
          });
          output.diagnostic(`Connection credential written to ${terminalLine(operation.outputPath)}`);
        } else {
          writeResult(connection, terminalLine(connection.connectionUrl));
        }
        return;
      }
    }

    signal?.throwIfAborted();
    onSubmission();
    submitted = true;
    switch (operation.action) {
      case 'create': {
        const created = await client.createExecutor(operation.request, signal);
        writeResult(created, created.id);
        return;
      }
      case 'delete': {
        const remaining = await client.deleteExecutor(operation.id, signal);
        if (remaining.some((entry) => entry.id === operation.id)) {
          throw new CliError('executors', 'executor deletion was not confirmed', 3);
        }
        writeResult({ id: operation.id, deleted: true });
        return;
      }
      case 'assign-provider':
      case 'unassign-provider': {
        const assigned = operation.action === 'assign-provider';
        const providers = assigned
          ? await client.assignExecutorProvider(operation.id, operation.providerId, signal)
          : await client.unassignExecutorProvider(operation.id, operation.providerId, signal);
        const provider = providers.find((entry) => entry.id === operation.providerId);
        const isAssigned = provider?.executorIds.includes(operation.id) === true;
        if (isAssigned !== assigned) throw new CliError('executors', 'provider assignment was not confirmed', 3);
        writeResult({ executorId: operation.id, providerId: operation.providerId, assigned });
        return;
      }
      case 'update':
      case 'enable':
      case 'disable': {
        const request = operation.action === 'update' ? operation.request : { enabled: operation.action === 'enable' };
        writeResult(requireExecutor(await client.updateExecutor(operation.id, request, signal), operation.id));
        return;
      }
    }
  } catch (error) {
    if (submitted && !isDefinitiveMutationRejection(error)) {
      throw new CliError('executors', 'executor configuration outcome is unknown; inspect executors and provider assignments before retrying. No automatic retry was made.', 3, { cause: error });
    }
    throw error;
  }
}
