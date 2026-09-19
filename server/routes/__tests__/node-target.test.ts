import { expect, test } from 'bun:test';
import { executionNodeIdFromUrl, localMachineRoutes } from '../node-target.js';
import { createProjectResolutionRoutes } from '../project-resolution.js';
import { ProjectAdmission } from '../../projects/project-admission.js';
import type { IChatRegistry } from '../../chats/store.js';
import { normalizeChatRegistryEntry } from '../../chats/registry-entry-codec.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = '1783725900000400';

function makeChatEntry() {
  return normalizeChatRegistryEntry({ agentId: 'test', projectPath: '/project',
    agentSettingsById: {}, carryOverSegments: [], agentOwnershipEpoch: 'synthetic-epoch',
    nativeSeedReceipt: null, carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] } }, CHAT_ID);
}

test('machine routes reject remote query, body, and chat targets before IO', async () => {
  let calls = 0;
  const registry = { getChat: () => ({ ...makeChatEntry(), nodeId: NODE_ID }) } satisfies Pick<IChatRegistry, 'getChat'>;
  const routes = localMachineRoutes({ '/files': { POST: () => { calls++; return Response.json({}); } } }, registry);
  for (const [query, body] of [
    [`?nodeId=${NODE_ID}`, {}], ['', { nodeId: NODE_ID }], [`?chatId=${CHAT_ID}`, {}], ['', { chatId: CHAT_ID }],
  ] as const) {
    const url = new URL(`http://localhost/files${query}`);
    const response = await routes['/files']!.POST!(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), url);
    expect(response.status).toBe(501);
  }
  expect(calls).toBe(0);
  const url = new URL('http://localhost/files');
  expect((await routes['/files']!.POST!(new Request(url, { method: 'POST' }), url)).status).toBe(200);
  expect(calls).toBe(1);
  expect(executionNodeIdFromUrl(new URL(`http://localhost/?chatId=${CHAT_ID}`), registry)).toBe(NODE_ID);
});

test('project admission and resolution reject node changes across awaited inspection', async () => {
  let chat = { ...makeChatEntry(), nodeId: NODE_ID };
  const registry = { getChat: () => chat } satisfies Pick<IChatRegistry, 'getChat'>;
  const inspected: (string | null | undefined)[] = [];
  const inspect = async (_path: string, nodeId?: string | null) => {
    inspected.push(nodeId);
    chat = { ...chat, nodeId: 'local' };
    return { kind: 'available' as const, effectiveProjectKey: chat.projectPath };
  };
  await expect(new ProjectAdmission(registry, inspect).assertAvailable(CHAT_ID)).rejects.toMatchObject({ code: 'PROJECT_PATH_CHANGED' });
  chat = { ...chat, nodeId: NODE_ID };
  const routes = createProjectResolutionRoutes({ registry, inspect });
  const url = new URL('http://localhost/api/v1/projects/resolve');
  url.search = new URLSearchParams({ chatId: CHAT_ID, nodeId: NODE_ID, expectedProjectPath: chat.projectPath }).toString();
  const response = await routes['/api/v1/projects/resolve']!.GET!(new Request(url), url);
  expect(response.status).toBe(409);
  expect(inspected).toEqual([NODE_ID, NODE_ID]);
});

test('machine guards use the same JSON parsing and errors as the route', async () => {
  let calls = 0;
  const registry = { getChat: () => null } satisfies Pick<IChatRegistry, 'getChat'>;
  const routes = localMachineRoutes({ '/files': { POST: () => { calls++; return Response.json({}); } } }, registry);
  const url = new URL('http://localhost/files');
  for (const [body, expectedStatus] of [
    [JSON.stringify({ nodeId: NODE_ID }), 501], ['{', 400], ['', 200],
  ] as const) {
    const response = await routes['/files']!.POST!(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'Application/JSON; charset=UTF-8' }, body,
    }), url);
    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 400) expect(await response.json()).toMatchObject({ error: 'Malformed JSON' });
  }
  expect(calls).toBe(1);
});
