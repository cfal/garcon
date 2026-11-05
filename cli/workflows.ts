import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableJsonStringify } from '@garcon/common/json';
import { parseWorkflowMutationRequest, parseWorkflowPlan, workflowBytes, workflowId, workflowRecord } from '@garcon/common/workflow-validation';
import { WORKFLOW_REQUEST_BYTES, parseWorkflowHttpMutation, type WorkflowHttpMutationRequest } from '@garcon/common/workflow-http';
import type { WorkflowMutation } from '@garcon/common/workflows';
import type { WorkflowCliCommand } from './workflow-args.js';
import type { CliOutput } from './output.js';
import { CliError, argumentError } from './errors.js';
import { isDefinitiveMutationRejection, type GarconClient } from './garcon-client.js';
import { publishAtomicDocument } from './atomic-document-output.js';
import { connectionCommandPrefix } from './connection-options.js';
import { shellQuote } from './shell-quote.js';
import { terminalLine } from './terminal-output.js';

type WorkflowClient = Pick<GarconClient, 'readWorkflow' | 'getWorkflowBootstrap' | 'getWorkflowOperation' | 'mutateWorkflow' | 'defaultExecutorId'>;
const CLI_ACTIONS = new Set<WorkflowMutation['action']>(['create', 'plan', 'pause', 'stop']);
const fingerprint = (value: unknown) => createHash('sha256').update(stableJsonStringify(value)).digest('hex');

export async function readWorkflowStdin(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let content = '';
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WORKFLOW_REQUEST_BYTES) throw argumentError('Workflow stdin exceeds its encoded size limit.');
      content += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return JSON.parse(content + decoder.decode());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}

async function readJson(file: string): Promise<unknown> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > WORKFLOW_REQUEST_BYTES + 4096) throw argumentError('Workflow JSON file exceeds its size limit or is not a file.');
    const buffer = Buffer.alloc(WORKFLOW_REQUEST_BYTES + 4097);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      size += bytesRead;
      if (size === buffer.length) throw argumentError('Workflow JSON file exceeds its size limit.');
      if (!bytesRead) break;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await handle.close(); }
}

export async function runWorkflowCommand(command: WorkflowCliCommand, client: WorkflowClient, output: CliOutput,
  signal?: AbortSignal, onSubmission: () => void = () => {}): Promise<void> {
  const operation = command.operation;
  const display = (value: unknown) => output.result(command.json ? JSON.stringify(value) : terminalLine(JSON.stringify(value, null, 2)));
  if (operation.action === 'read') { display(await client.readWorkflow(operation.query, signal)); return; }
  if (operation.action === 'operation') { display(await client.getWorkflowOperation(operation.id, signal)); return; }
  if (command.runtime === 'auto') throw argumentError('Workflow mutations require a resolved runtime selector.');
  const connection = { configDir: command.configDir, runtime: command.runtime,
    serverUrl: command.serverUrl ?? null, executorId: client.defaultExecutorId };
  let request: WorkflowHttpMutationRequest;
  let recoveryPath: string;
  const bootstrap = await client.getWorkflowBootstrap(signal);
  try {
    if (operation.action === 'retry-operation') {
      const raw = workflowRecord(await readJson(operation.file), ['version', 'connection', 'request', 'fingerprint']);
      if (raw.version !== 1 || fingerprint(raw.connection) !== fingerprint(connection) || raw.fingerprint !== fingerprint(raw.request)) {
        throw argumentError('Recovery identity, payload, or runtime selector changed.');
      }
      const envelope = workflowRecord(raw.request, ['operationId', 'mutation', 'expectedStoreId']);
      const mutation = parseWorkflowMutationRequest({ operationId: envelope.operationId, mutation: envelope.mutation });
      request = parseWorkflowHttpMutation(raw.request, mutation.mutation.action);
      if (request.operationId !== command.operationId) throw argumentError('Recovery operation ID does not match --operation-id.');
      recoveryPath = operation.file;
    } else {
      let mutation: WorkflowMutation;
      const input = 'file' in operation ? await (operation.file === '-' ? readWorkflowStdin(Bun.stdin.stream(), signal) : readJson(operation.file)) : null;
      if (operation.action === 'create') mutation = { action: 'create', plan: parseWorkflowPlan(input), captainChatId: null };
      else if (operation.action === 'plan') mutation = { action: 'plan', workflowId: operation.id,
        plan: parseWorkflowPlan(input), expectedPlanRevision: operation.expectedPlanRevision };
      else mutation = { action: operation.action, workflowId: operation.id };
      request = { expectedStoreId: bootstrap.storeId, operationId: command.operationId ?? crypto.randomUUID(), mutation };
      recoveryPath = path.join(command.configDir, 'workflow-recovery', `${workflowId(request.operationId)}.json`);
    }
    if (!CLI_ACTIONS.has(request.mutation.action)) throw argumentError('This action requires an authenticated browser session.');
    if (request.expectedStoreId !== bootstrap.storeId) throw argumentError('Recovery belongs to a different workflow store.');
    if (workflowBytes(request) > WORKFLOW_REQUEST_BYTES) throw argumentError('Encoded workflow request exceeds its size limit.');
  } catch (error) {
    throw argumentError(error instanceof Error ? error.message : 'Invalid workflow request', { cause: error });
  }
  if (operation.action !== 'retry-operation') {
    await fs.mkdir(path.dirname(recoveryPath), { recursive: true, mode: 0o700 });
    await publishAtomicDocument({ outputPath: recoveryPath, force: false, phase: 'workflows', noun: 'workflow recovery payload',
      temporarySuffix: 'workflow', signal, document: JSON.stringify({ version: 1, connection, request, fingerprint: fingerprint(request) }) });
  }
  output.diagnostic(`Operation: ${request.operationId}\nRecovery: ${connectionCommandPrefix(command).join(' ')} workflow retry-operation --payload ${shellQuote(recoveryPath)} --operation-id ${shellQuote(request.operationId)}`);
  if (operation.action === 'retry-operation') {
    const previous = await client.getWorkflowOperation(request.operationId, signal);
    if (previous.kind === 'completed') { display(previous.result); return; }
    if (previous.kind === 'result-expired') throw new CliError('workflows', 'Operation completed but its result expired. It will not run again.', 3);
  }
  signal?.throwIfAborted();
  onSubmission();
  try { display(await client.mutateWorkflow(request, signal)); }
  catch (error) {
    if (isDefinitiveMutationRejection(error)) throw error;
    throw new CliError('workflows', 'Workflow mutation was not confirmed. Inspect its operation or use the printed recovery command. No automatic retry was made.', 3, { cause: error });
  }
}
