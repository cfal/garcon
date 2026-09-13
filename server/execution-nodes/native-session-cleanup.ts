import type { ProviderNativeSessionService } from './provider-native-sessions.js';
import type { AgentInstanceDirectory } from '../agents/instance-directory.js';
import type { LocatedNativeRelease } from '../chats/agent-ownership-journal.js';
import { DomainError } from '../lib/domain-error.js';
import type { ExecutionNodesStore } from './store.js';

/** Leaves unavailable native cleanup pending without changing its recorded owner. */
export function resolveNativeSessionCleanup(
  reference: LocatedNativeRelease,
  nodes: Pick<ExecutionNodesStore, 'requireLocation'>,
  instances: Pick<AgentInstanceDirectory, 'nativeSessionsFor'>,
): ProviderNativeSessionService | null {
  const owner = { ...reference.chat, executionLocation: reference.executionLocation };
  try {
    const { workspace } = nodes.requireLocation(reference.executionLocation, reference.chat.agentId);
    if (workspace.projectPath !== reference.chat.projectPath) return null;
    return instances.nativeSessionsFor(owner);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'NODE_UNAVAILABLE' || error.code === 'NODE_REMOVED')) return null;
    throw error;
  }
}
