import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { AgentInstanceDirectory } from '../agents/instance-directory.js';
import type { LocatedNativeRelease } from '../chats/agent-ownership-journal.js';
import { DomainError } from '../lib/domain-error.js';
import type { LocalExecutionPlacement } from './local-placement.js';

/** Leaves unavailable native cleanup pending without changing its recorded owner. */
export function resolveLocalNativeIntegration(
  reference: LocatedNativeRelease,
  placements: Pick<LocalExecutionPlacement, 'assertAvailable'>,
  instances: Pick<AgentInstanceDirectory, 'requireFor'>,
): AgentIntegration | null {
  const owner = { ...reference.chat, executionLocation: reference.executionLocation };
  try {
    placements.assertAvailable(owner);
    return instances.requireFor(owner);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'NODE_UNAVAILABLE' || error.code === 'NODE_REMOVED')) return null;
    throw error;
  }
}
