import {
  createAgentResourceRef,
  type AgentPermissions,
  type AgentProducerBinding,
  type AgentProducerNotification,
  type AgentProducers,
} from '@garcon/server-agent-interface';

export function createProducerFixture() {
  const scope = { executorId: 'local', instanceId: crypto.randomUUID(), integrationId: 'test' };
  const listeners = new Set<(notification: AgentProducerNotification) => void>();
  const bindings = new Set<string>();
  const producers = {
    scope,
    async bind({ binding }) { bindings.add(binding.id); },
    async close(binding) { bindings.delete(binding.id); },
    detach(binding) { bindings.delete(binding.id); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } satisfies AgentProducers;
  return {
    producers,
    emit(binding: AgentProducerBinding, event: AgentProducerNotification['event']) {
      for (const listener of listeners) listener({ binding, event });
    },
    reference<K extends string>(kind: K) { return createAgentResourceRef(scope, kind); },
  };
}

export function permissionResponse(id: string) {
  return {
    kind: 'permission-response' as const,
    executorId: 'local', instanceId: 'test-instance', integrationId: 'test', id,
  };
}

export function permissionFixture(callbacks: ReadonlyMap<string, (decision: Parameters<AgentPermissions['respond']>[0]['decision']) => Promise<void>>) {
  return {
    async respond({ response, decision }) {
      const callback = callbacks.get(response.id);
      if (!callback) throw new Error('Permission reference is unavailable');
      await callback(decision);
    },
  } satisfies AgentPermissions;
}
