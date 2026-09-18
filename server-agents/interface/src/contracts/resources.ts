export interface NodeCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AgentResourceScope {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly integrationId: string;
}

export interface AgentResourceRef<K extends string> extends AgentResourceScope {
  readonly kind: K;
  readonly id: string;
}

export type AgentProducerBinding = AgentResourceRef<'producer'>;
export type AgentPermissionResponseRef = AgentResourceRef<'permission-response'>;
export type AgentGoalPreparation = AgentResourceRef<'goal-preparation'>;
export type AgentProjectPathPreparation = AgentResourceRef<'project-path-preparation'>;

export function createAgentResourceRef<K extends string>(
  scope: AgentResourceScope,
  kind: K,
): AgentResourceRef<K> {
  return Object.freeze({ ...scope, kind, id: crypto.randomUUID() });
}

export function isAgentResourceRef<K extends string>(
  value: unknown,
  kind: K,
  scope?: AgentResourceScope,
): value is AgentResourceRef<K> {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return ref.kind === kind
    && ['nodeId', 'instanceId', 'integrationId', 'id'].every((key) => (
      typeof ref[key] === 'string' && ref[key].length > 0
    ))
    && (!scope || (ref.nodeId === scope.nodeId
      && ref.instanceId === scope.instanceId
      && ref.integrationId === scope.integrationId));
}
