import { spyOn } from 'bun:test';
import { DomainError, ProjectUnavailableError } from '../../../../server/common/domain-error.ts';
import type { ChatRegistryEntry } from '../../../../server/controller/chats/registry-contracts.ts';
import { ProjectAdmission } from '../../../../server/controller/projects/project-admission.ts';

const REMOTE = '11111111-1111-4111-8111-111111111111';

export async function projectAdmissionTrace(scenario: string) {
  const clock = spyOn(performance, 'now').mockReturnValue(1000);
  try {
    let chat: ChatRegistryEntry | null = scenario === 'missing' ? null : {
      executorId: scenario === 'local-null' ? null : REMOTE,
      projectPath: '/workspace/project', agentOwnershipEpoch: 'first',
      agentId: 'test', nativeSession: null, agentSettingsById: {},
      tags: [], agentSessionId: null, model: 'synthetic', permissionMode: 'default', thinkingMode: 'none',
      carryOverSegments: [], nativeSeedReceipt: null, carryOverMigrationQuarantine: null,
      pendingPreambleBoundary: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
      parentChatId: null, lineage: null,
    };
    const calls: unknown[] = [];
    const admission = new ProjectAdmission({ getChat: () => chat }, async (path, executor, options) => {
      calls.push([path, executor ?? null, { signal: Boolean(options?.signal),
        deadline: options?.dispatchDeadline ?? null, timeout: options?.timeoutMs ?? null }]);
      await Promise.resolve();
      if (scenario === 'failed') throw new Error('Synthetic inspection failure');
      if (chat) {
        if (scenario === 'path') chat = { ...chat, projectPath: '/other' };
        if (scenario === 'executor') chat = { ...chat, executorId: 'local' };
        if (scenario === 'owner') chat = { ...chat, agentOwnershipEpoch: 'replacement' };
        if (scenario === 'deleted') chat = null;
        if (scenario === 'local-null') { const { executorId: _, ...entry } = chat; chat = entry; }
      }
      return scenario === 'unavailable' || scenario === 'owner'
        ? { kind: 'unavailable', reason: 'not-found' }
        : { kind: 'available', effectiveProjectKey: '/real/project' };
    });
    let error: unknown = null;
    try {
      await admission.assertAvailable('1767225600000000', scenario === 'deadline' ? 21000 : null);
      if (scenario === 'available') await admission.assertAvailable('1767225600000000', null);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      error = e instanceof DomainError ? {
        name: e.name, code: e.code, message: e.message, status: e.status, retryable: e.retryable,
        ...(e instanceof ProjectUnavailableError ? { projectPath: e.projectPath, reason: e.reason } : {}),
      } : { name: e.name, message: e.message };
    }
    return { error, calls };
  } finally { clock.mockRestore(); }
}
