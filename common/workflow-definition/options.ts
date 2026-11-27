import type { AgentSettingsEnvelope } from '../agent-integration.js';
import { isAgentId } from '../agents.js';
import { MAX_CHAT_ATTACHMENT_COUNT } from '../attachments.js';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '../chat-modes.js';
import { isExecutorId } from '../executors.js';
import { isPreambleId, PREAMBLE_MAX_COUNT, type PreambleId } from '../preambles.js';
import { normalizeTagSlug } from '../tags.js';
import type { WorkflowField } from './source.js';
import type { WorkflowAgentStep, WorkflowAttachment } from './types.js';

export const LOCATION_FIELDS = ['executorId', 'projectPath'] as const;
export const AGENT_OPTION_FIELDS = [
  'agentId', 'apiProviderId', 'modelEndpointId', 'model', 'permissionMode', 'thinkingMode',
  'agentSettings', 'orderedPreambleIds', 'attachments', 'tags',
] as const;

type AgentOptions = Pick<WorkflowAgentStep, (typeof AGENT_OPTION_FIELDS)[number]>;

export function parseWorkflowLocation(field: WorkflowField): Pick<WorkflowAgentStep, (typeof LOCATION_FIELDS)[number]> {
  const executorId = field.at('executorId').optional((entry) => isExecutorId(entry.value) ? entry.value
    : entry.expected('"local" or a remote executor ID'));
  const projectPath = field.at('projectPath').optional((entry) => entry.text());
  return { ...(executorId === undefined ? {} : { executorId }), ...(projectPath === undefined ? {} : { projectPath }) };
}

export function parseAgentOptions(field: WorkflowField): AgentOptions {
  const agentId = field.at('agentId').optional(readAgentId);
  const apiProviderId = field.at('apiProviderId').optional(nullableId);
  const modelEndpointId = field.at('modelEndpointId').optional(nullableId);
  const model = field.at('model').optional((entry) => entry.text(512));
  const permissionMode = field.at('permissionMode').optional((entry) => entry.choice(PERMISSION_MODE_VALUES));
  const thinkingMode = field.at('thinkingMode').optional((entry) => entry.choice(THINKING_MODE_VALUES));
  const agentSettings = field.at('agentSettings').optional((entry) => parseAgentSettings(entry, agentId));
  const orderedPreambleIds = field.at('orderedPreambleIds').optional(readPreambleIds);
  const attachments = field.at('attachments').optional(readAttachments);
  const tags = field.at('tags').optional(readTags);

  if (apiProviderId === null && typeof modelEndpointId === 'string') {
    field.at('modelEndpointId').issue('invalid-value', 'Remove this endpoint or choose an API provider instead of native models.');
  } else if (typeof apiProviderId === 'string' && modelEndpointId === null) {
    field.at('modelEndpointId').issue('invalid-value', 'Choose an endpoint for this provider, or omit modelEndpointId to resolve it at launch.');
  }
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(apiProviderId === undefined ? {} : { apiProviderId }),
    ...(modelEndpointId === undefined ? {} : { modelEndpointId }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(thinkingMode === undefined ? {} : { thinkingMode }),
    ...(agentSettings === undefined ? {} : { agentSettings }),
    ...(orderedPreambleIds === undefined ? {} : { orderedPreambleIds }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(tags === undefined ? {} : { tags }),
  };
}

function readAgentId(field: WorkflowField): string | undefined {
  return isAgentId(field.value) ? field.value : field.expected('an agent ID');
}

function nullableId(field: WorkflowField): string | null | undefined {
  return field.value === null ? null : field.text(128);
}

function parseAgentSettings(field: WorkflowField, agentId: string | undefined): AgentSettingsEnvelope | undefined {
  if (!field.map(['ownerId', 'schemaVersion', 'values'])) return undefined;
  const ownerId = readAgentId(field.at('ownerId'));
  const versionField = field.at('schemaVersion');
  const schemaVersion = versionField.value;
  const values = field.at('values').map();
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    return versionField.expected('a positive integer');
  }
  if (ownerId && agentId && ownerId !== agentId) {
    field.at('ownerId').issue('invalid-value', `Use settings owned by the selected agent ${JSON.stringify(agentId)}.`);
  }
  return ownerId && values ? { ownerId, schemaVersion, values } : undefined;
}

function readPreambleIds(field: WorkflowField): PreambleId[] | undefined {
  const items = field.list(0, PREAMBLE_MAX_COUNT);
  if (!items) return undefined;
  const ids = new Set<PreambleId>();
  items.forEach((id, index) => {
    if (!isPreambleId(id)) field.at(index).expected('a preamble ID');
    else if (ids.has(id)) field.at(index).issue('invalid-value', 'Remove this duplicate preamble ID.');
    else ids.add(id);
  });
  return [...ids];
}

function readAttachments(field: WorkflowField): WorkflowAttachment[] | undefined {
  return field.list(0, MAX_CHAT_ATTACHMENT_COUNT)?.flatMap((_, index) => {
    const attachment = field.at(index);
    if (!attachment.map(['path'])) return [];
    const path = attachment.at('path').text();
    return path === undefined ? [] : [{ path }];
  });
}

function readTags(field: WorkflowField): string[] | undefined {
  const items = field.list(0, 128);
  if (!items) return undefined;
  const tags = new Set<string>();
  items.forEach((tag, index) => {
    if (typeof tag !== 'string' || !tag || normalizeTagSlug(tag) !== tag) {
      field.at(index).expected('a normalized chat tag, e.g. "review-needed"');
    } else if (tags.has(tag)) field.at(index).issue('invalid-value', 'Remove this duplicate chat tag.');
    else tags.add(tag);
  });
  return [...tags];
}
