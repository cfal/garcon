import path from 'node:path';
import { isRecord } from '@garcon/common/json';
import { parseChatId } from '@garcon/common/chat-id';
import { isExecutorId } from '@garcon/common/executors';
import { normalizeScheduledPromptDefinitionInput, type ScheduledPromptDefinitionInput } from '@garcon/common/scheduled-prompts';
import { argumentError } from './errors.js';

export const SCHEDULE_DEFINITION_BYTES = 256 * 1024;

function fields(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw argumentError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw argumentError(`${label} contains an unsupported field`);
  }
  return value;
}

export function parseScheduleDefinition(input: string): ScheduledPromptDefinitionInput {
  if (!input.isWellFormed() || Buffer.byteLength(input) > SCHEDULE_DEFINITION_BYTES) {
    throw argumentError('schedule definition must be valid UTF-8 JSON of at most 256 KiB');
  }
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { throw argumentError('schedule definition must be valid JSON'); }
  const raw = fields(value, ['name', 'schedule', 'target', 'prompt'], 'definition');
  const schedule = fields(raw.schedule, ['type', 'runAtUtc', 'firstRunAtUtc', 'intervalMinutes', 'endAtUtc'], 'schedule');
  fields(schedule, schedule.type === 'once' ? ['type', 'runAtUtc']
    : ['type', 'firstRunAtUtc', 'intervalMinutes', 'endAtUtc'], 'schedule');
  const target = fields(raw.target, ['type', 'chatId', 'busyBehavior', 'expectedSelection', 'executorId',
    'agentId', 'projectPath', 'model', 'apiProviderId', 'modelEndpointId', 'modelProtocol',
    'permissionMode', 'thinkingMode', 'agentSettingsById', 'tags', 'preambleChoice', 'chatTitleTemplate'], 'target');
  if (target.type === 'existing-chat') {
    fields(target, ['type', 'chatId', 'busyBehavior', 'expectedSelection'], 'existing-chat target');
    try { parseChatId(target.chatId); }
    catch { throw argumentError('existing-chat target requires a valid 16-digit chatId'); }
    if (target.expectedSelection !== undefined) {
      fields(target.expectedSelection, ['agentId', 'agentOwnershipEpoch', 'model'], 'expectedSelection');
    }
  } else if (target.type === 'new-chat') {
    fields(target, ['type', 'executorId', 'agentId', 'projectPath', 'model', 'apiProviderId',
      'modelEndpointId', 'modelProtocol', 'permissionMode', 'thinkingMode', 'agentSettingsById',
      'tags', 'preambleChoice', 'chatTitleTemplate'], 'new-chat target');
    if (!isExecutorId(target.executorId)) throw argumentError('new-chat target requires an explicit executorId: local or an executor UUID');
    const projectPath = target.projectPath;
    if (typeof projectPath !== 'string' || projectPath.includes('\0') || !(path.posix.isAbsolute(projectPath)
      || /^[a-z]:[\\/]/iu.test(projectPath) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(projectPath))) {
      throw argumentError('new-chat target requires an absolute projectPath on its executor');
    }
    const preamble = fields(target.preambleChoice, ['mode', 'orderedPreambleIds'], 'preambleChoice');
    fields(preamble, preamble.mode === 'defaults' ? ['mode'] : ['mode', 'orderedPreambleIds'], 'preambleChoice');
  }
  const definition = normalizeScheduledPromptDefinitionInput(raw);
  if (!definition) throw argumentError('invalid schedule definition; use a complete target, nonblank prompt, and minute-aligned UTC schedule');
  // The shared storage normalizer omits Local; forwarded definitions must name it explicitly.
  if (definition.target.type === 'new-chat') definition.target.executorId = String(target.executorId);
  return definition;
}

export async function readScheduleDefinitionStdin(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let input = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SCHEDULE_DEFINITION_BYTES) throw argumentError('schedule definition exceeds 256 KiB');
      input += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return input + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    signal?.throwIfAborted();
    throw argumentError('schedule stdin must be valid UTF-8 of at most 256 KiB', { cause: error });
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
