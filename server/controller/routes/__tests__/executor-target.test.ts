import { expect, test } from 'bun:test';
import { executorIdFromUrl } from '../executor-target.js';
import { createProjectResolutionRoutes } from '../project-resolution.js';
import { ProjectAdmission } from '../../projects/project-admission.js';
import type { IChatRegistry } from '../../chats/store.js';
import { normalizeChatRegistryEntry } from '../../chats/registry-entry-codec.js';

const EXECUTOR_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = '1783725900000400';

function makeChatEntry() {
  return normalizeChatRegistryEntry({ agentId: 'test', projectPath: '/project',
    agentSettingsById: {}, carryOverSegments: [], agentOwnershipEpoch: 'synthetic-epoch',
    nativeSeedReceipt: null, carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] } }, CHAT_ID);
}

test('executor selectors resolve chat ownership and reject stale or invalid targets', () => {
  const registry = { getChat: () => ({ ...makeChatEntry(), executorId: EXECUTOR_ID }) } satisfies Pick<IChatRegistry, 'getChat'>;
  expect(executorIdFromUrl(new URL('http://localhost/'))).toBe('local');
  expect(executorIdFromUrl(new URL(`http://localhost/?executorId=${EXECUTOR_ID}`))).toBe(EXECUTOR_ID);
  expect(executorIdFromUrl(new URL(`http://localhost/?chatId=${CHAT_ID}`), registry)).toBe(EXECUTOR_ID);
  expect(() => executorIdFromUrl(new URL(`http://localhost/?chatId=${CHAT_ID}&executorId=local`), registry))
    .toThrow(expect.objectContaining({ code: 'STALE_CHAT_OWNERSHIP' }));
  for (const query of ['executorId=invalid', 'executorId=', 'executorId=local&executorId=local']) {
    expect(() => executorIdFromUrl(new URL(`http://localhost/?${query}`))).toThrow('Invalid executor ID');
  }
});

test('project admission and resolution reject executor changes across awaited inspection', async () => {
  let chat = { ...makeChatEntry(), executorId: EXECUTOR_ID };
  const registry = { getChat: () => chat } satisfies Pick<IChatRegistry, 'getChat'>;
  const inspected: (string | null | undefined)[] = [];
  const inspect = async (_path: string, executorId?: string | null) => {
    inspected.push(executorId);
    chat = { ...chat, executorId: 'local' };
    return { kind: 'available' as const, effectiveProjectKey: chat.projectPath };
  };
  await expect(new ProjectAdmission(registry, inspect).assertAvailable(CHAT_ID)).rejects.toMatchObject({ code: 'PROJECT_PATH_CHANGED' });
  chat = { ...chat, executorId: EXECUTOR_ID };
  const routes = createProjectResolutionRoutes({ registry, inspect });
  const url = new URL('http://localhost/api/v1/projects/resolve');
  url.search = new URLSearchParams({ chatId: CHAT_ID, executorId: EXECUTOR_ID, expectedProjectPath: chat.projectPath }).toString();
  const response = await routes['/api/v1/projects/resolve']!.GET!(new Request(url), url);
  expect(response.status).toBe(409);
  expect(inspected).toEqual([EXECUTOR_ID, EXECUTOR_ID]);
});
