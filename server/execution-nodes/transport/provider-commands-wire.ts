import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { isProjectUnavailableReason, type ProjectUnavailableReason } from '../../../common/project-resolution.js';
import type { SlashCommand } from '../../../common/slash-commands.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';

export const MAX_NODE_COMMANDS_BYTES = 192 * 1024;
export const MAX_NODE_COMMANDS = 1024;

export interface NodeProviderCommandsCommand {
  readonly method: 'provider-commands';
  readonly instanceId: string;
  readonly workspaceId: string;
}

export type NodeProviderCommandsReply =
  | { readonly kind: 'provider-commands'; readonly instanceId: string; readonly workspaceId: string; readonly commands: readonly SlashCommand[] }
  | { readonly kind: 'provider-commands-unavailable'; readonly instanceId: string; readonly workspaceId: string; readonly reason: ProjectUnavailableReason };

export function parseNodeProviderCommandsCommand(value: unknown): NodeProviderCommandsCommand | null {
  if (!bounded(value) || !exactNodeFields(value, ['method', 'instanceId', 'workspaceId']) || value.method !== 'provider-commands'
    || !isExecutionIdentity(value.instanceId) || !isExecutionIdentity(value.workspaceId)) return null;
  return { method: value.method, instanceId: value.instanceId, workspaceId: value.workspaceId };
}

export function parseNodeProviderCommandsReply(value: unknown): NodeProviderCommandsReply | null {
  if (!bounded(value) || !isExecutionIdentity(value.instanceId) || !isExecutionIdentity(value.workspaceId)) return null;
  if (value.kind === 'provider-commands-unavailable' && exactNodeFields(value, ['kind', 'instanceId', 'workspaceId', 'reason'])
    && isProjectUnavailableReason(value.reason)) return { kind: value.kind, instanceId: value.instanceId, workspaceId: value.workspaceId, reason: value.reason };
  if (value.kind !== 'provider-commands' || !exactNodeFields(value, ['kind', 'instanceId', 'workspaceId', 'commands'])
    || !Array.isArray(value.commands) || value.commands.length > MAX_NODE_COMMANDS) return null;
  const commands: SlashCommand[] = [];
  for (const entry of value.commands) {
    if (!exactNodeFields(entry, ['name', 'source'], ['description']) || !nodeString(entry.name, 256)
      || entry.source !== 'command' && entry.source !== 'skill'
      || Object.hasOwn(entry, 'description') && !nodeString(entry.description, 8192, true)) return null;
    commands.push({ name: entry.name, source: entry.source, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) });
  }
  return { kind: value.kind, instanceId: value.instanceId, workspaceId: value.workspaceId, commands };
}

export function captureNodeProviderCommandsReply(instanceId: string, workspaceId: string, commands: readonly SlashCommand[]): NodeProviderCommandsReply | null {
  if (!isNodeData(commands) || !Array.isArray(commands)) return null;
  const captured: SlashCommand[] = [];
  const descriptions: (string | undefined)[] = [];
  const reply = { kind: 'provider-commands' as const, instanceId, workspaceId, commands: captured };
  let bytes = Buffer.byteLength(JSON.stringify(reply));
  for (const entry of commands) {
    if (!exactNodeFields(entry, ['name', 'source'], ['description']) || typeof entry.name !== 'string'
      || entry.source !== 'command' && entry.source !== 'skill'
      || entry.description !== undefined && typeof entry.description !== 'string') return null;
    if (!nodeString(entry.name, 256)) continue;
    const command: SlashCommand = { name: entry.name, source: entry.source };
    const addedBytes = Buffer.byteLength(JSON.stringify(command)) + (captured.length ? 1 : 0);
    if (bytes + addedBytes > MAX_NODE_COMMANDS_BYTES) continue;
    captured.push(command);
    descriptions.push(entry.description);
    bytes += addedBytes;
    if (captured.length === MAX_NODE_COMMANDS) break;
  }
  // Command identities consume the budget before optional display text.
  for (const [index, description] of descriptions.entries()) {
    if (description === undefined) continue;
    let text = description.slice(0, 8192);
    if (description.length > 8192 && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    if (!nodeString(text, 8192, true)) continue;
    const command = captured[index]!;
    const withDescription = { ...command, description: text };
    const addedBytes = Buffer.byteLength(JSON.stringify(withDescription)) - Buffer.byteLength(JSON.stringify(command));
    if (bytes + addedBytes > MAX_NODE_COMMANDS_BYTES) continue;
    captured[index] = withDescription;
    bytes += addedBytes;
  }
  return parseNodeProviderCommandsReply(reply);
}

function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_COMMANDS_BYTES;
}
