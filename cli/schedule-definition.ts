import { isRecord } from '@garcon/common/json';
import { parseChatId } from '@garcon/common/chat-id';
import { isExecutorId } from '@garcon/common/executors';
import {
  normalizeScheduledPromptDefinitionInput,
  type ScheduledPromptDefinitionInput,
} from '@garcon/common/scheduled-prompts';
import { argumentError } from './errors.js';
import { isAbsoluteExecutorPath } from './executor-path.js';

export const SCHEDULE_DEFINITION_BYTES = 256 * 1024;

const EXISTING_CHAT_TARGET_FIELDS = ['type', 'chatId', 'busyBehavior', 'expectedSelection'];
const NEW_CHAT_TARGET_FIELDS = [
  'type', 'executorId', 'agentId', 'projectPath', 'model', 'apiProviderId',
  'modelEndpointId', 'modelProtocol', 'permissionMode', 'thinkingMode',
  'agentSettingsById', 'tags', 'preambleChoice', 'chatTitleTemplate',
];

function requireKnownFields(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
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
  try {
    value = JSON.parse(input);
  } catch {
    throw argumentError('schedule definition must be valid JSON');
  }
  const raw = requireKnownFields(value, ['name', 'schedule', 'target', 'prompt'], 'definition');
  const schedule = requireKnownFields(raw.schedule, ['type', 'runAtUtc', 'firstRunAtUtc', 'intervalMinutes', 'endAtUtc'], 'schedule');
  const scheduleFields = schedule.type === 'once'
    ? ['type', 'runAtUtc']
    : ['type', 'firstRunAtUtc', 'intervalMinutes', 'endAtUtc'];
  requireKnownFields(schedule, scheduleFields, 'schedule');

  const target = requireKnownFields(raw.target, [...EXISTING_CHAT_TARGET_FIELDS, ...NEW_CHAT_TARGET_FIELDS], 'target');
  if (target.type === 'existing-chat') {
    requireKnownFields(target, EXISTING_CHAT_TARGET_FIELDS, 'existing-chat target');
    try {
      parseChatId(target.chatId);
    } catch {
      throw argumentError('existing-chat target requires a valid 16-digit chatId');
    }
    if (target.expectedSelection !== undefined) {
      requireKnownFields(target.expectedSelection, ['agentId', 'agentOwnershipEpoch', 'model'], 'expectedSelection');
    }
  } else if (target.type === 'new-chat') {
    requireKnownFields(target, NEW_CHAT_TARGET_FIELDS, 'new-chat target');
    if (!isExecutorId(target.executorId)) {
      throw argumentError('new-chat target requires an explicit executorId: local or an executor UUID');
    }
    if (!isAbsoluteExecutorPath(target.projectPath)) {
      throw argumentError('new-chat target requires an absolute projectPath on its executor');
    }
    const preamble = requireKnownFields(target.preambleChoice, ['mode', 'orderedPreambleIds'], 'preambleChoice');
    const preambleFields = preamble.mode === 'defaults' ? ['mode'] : ['mode', 'orderedPreambleIds'];
    requireKnownFields(preamble, preambleFields, 'preambleChoice');
  }

  const definition = normalizeScheduledPromptDefinitionInput(raw);
  if (!definition) {
    throw argumentError('invalid schedule definition; use a complete target, nonblank prompt, and minute-aligned UTC schedule');
  }
  // The shared storage normalizer omits Local; forwarded definitions must name it explicitly.
  if (definition.target.type === 'new-chat') {
    definition.target.executorId = String(target.executorId);
  }
  return definition;
}

export async function readScheduleDefinitionStdin(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
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
