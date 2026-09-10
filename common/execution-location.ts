import { isRecord } from './json.js';

export interface ExecutionInstanceRef {
  readonly nodeId: string;
  readonly instanceId: string;
}

export interface ProjectWorkspaceRef {
  readonly nodeId: string;
  readonly workspaceId: string;
}

export interface ExecutionLocation extends ExecutionInstanceRef, ProjectWorkspaceRef {}

export interface ExecutionOrigin extends ExecutionLocation {
  readonly projectPath: string;
  readonly ownershipEpoch: string;
}

export interface LocatedChatOwner {
  readonly agentId: string;
  readonly executionLocation: ExecutionLocation;
}

export const EXECUTION_NODE_STATUSES = [
  'online', 'reconnecting', 'recovering', 'offline', 'incompatible', 'untrusted', 'cleaning-up', 'removed',
] as const;
export type ExecutionNodeStatus = typeof EXECUTION_NODE_STATUSES[number];

export function isExecutionIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

export function parseExecutionLocation(value: unknown): ExecutionLocation | null {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || !isExecutionIdentity(value.nodeId) || !isExecutionIdentity(value.instanceId)
    || !isExecutionIdentity(value.workspaceId)) return null;
  return { nodeId: value.nodeId, instanceId: value.instanceId, workspaceId: value.workspaceId };
}

export function parseExecutionOrigin(value: unknown): ExecutionOrigin | null {
  if (!isRecord(value) || Object.keys(value).length !== 5
    || !isExecutionIdentity(value.ownershipEpoch)
    || typeof value.projectPath !== 'string' || value.projectPath.trim().length === 0 || value.projectPath.length > 32_768
    || value.projectPath.includes('\0')) return null;
  const location = parseExecutionLocation({ nodeId: value.nodeId, instanceId: value.instanceId, workspaceId: value.workspaceId });
  return location ? { ...location, ownershipEpoch: value.ownershipEpoch, projectPath: value.projectPath } : null;
}

export function sameExecutionOwner(a: LocatedChatOwner, b: LocatedChatOwner): boolean {
  return a.agentId === b.agentId
    && a.executionLocation.nodeId === b.executionLocation.nodeId
    && a.executionLocation.instanceId === b.executionLocation.instanceId
    && a.executionLocation.workspaceId === b.executionLocation.workspaceId;
}

export function projectWorkspaceKey(ref: ProjectWorkspaceRef): string {
  return JSON.stringify([ref.nodeId, ref.workspaceId]);
}

export function executionInstanceKey(ref: ExecutionInstanceRef): string {
  return JSON.stringify([ref.nodeId, ref.instanceId]);
}
