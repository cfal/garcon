import { createHash } from 'node:crypto';
import type { ExecutionLocation } from '../../../common/execution-location.js';
import { LocalExecutionPlacement } from '../local-placement.js';
import { ExecutionNodesStore } from '../store.js';
import { migrateWorkspaceExecutionLocations } from '../workspace-migration.js';

export async function migrateTestWorkspaceLocations(workspaceDir: string): Promise<LocalExecutionPlacement> {
  const nodes = new ExecutionNodesStore(workspaceDir);
  await nodes.init();
  await migrateWorkspaceExecutionLocations(workspaceDir, nodes);
  return new LocalExecutionPlacement(nodes);
}

export function testExecutionLocation(agentId = 'test', projectPath = '/repo'): ExecutionLocation {
  return {
    nodeId: 'test-local-node',
    instanceId: `test-${agentId}`,
    workspaceId: createHash('sha256').update(projectPath).digest('hex'),
  };
}

export const testPlacements = {
  prepare: async (agentId: string, projectPath: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return testExecutionLocation(agentId, projectPath);
  },
  prepareHandoff: async (source, agentId: string) => testExecutionLocation(agentId, source.projectPath),
  prepareRelocation: async (source, projectPath: string) => ({
    ...testExecutionLocation(source.agentId, projectPath),
    instanceId: source.executionLocation.instanceId,
  }),
  assertAvailable: () => undefined,
} satisfies Pick<LocalExecutionPlacement, 'prepare' | 'prepareHandoff' | 'prepareRelocation' | 'assertAvailable'>;
