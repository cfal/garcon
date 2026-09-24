import { expect, test } from 'bun:test';
import { GarconClient } from '../../../cli/garcon-client.js';
import { CLI_OPERATIONS } from '../cli-protocol.js';

test('the reverse CLI allowlist accounts for every client HTTP operation and nothing else', async () => {
  const operations = new Set<string>();
  const chatId = '1234567890123456';
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    operations.add(`${init?.method} ${path}`);
    if (path === '/api/v1/chats/tags' && init?.method === 'GET') return Response.json({ success: true, chatId, tags: [] });
    return Response.json({ error: 'Synthetic boundary rejection', errorCode: 'VALIDATION_FAILED', retryable: false }, { status: 400 });
  }, { preconnect() {} }) satisfies typeof fetch;
  const client = new GarconClient({ baseUrl: 'http://127.0.0.1:1', instanceId: 'controller', endpointInstanceId: 'endpoint',
    defaultNodeId: 'local', workspaceName: null, localCapability: 'synthetic', fetch: fetcher });
  type Operation = Exclude<keyof GarconClient, 'defaultNodeId' | 'workspaceName' | 'serverInstanceId' | 'verifyRuntime'>;
  // Minimal payloads exercise transport paths; the fake endpoint rejects before application DTO parsing.
  const args = {
    getModelCatalog: [], getSettings: [], getPreambles: [], listChats: [],
    getChatMessages: [{ chatId }], searchChats: [{ query: 'synthetic' }],
    getTranscriptSearchStatus: [], rebuildTranscriptSearch: [], setTranscriptSearchEnabled: [true],
    getChatSnapshot: [chatId, 0], getTranscriptExport: [{ chatId, format: 'json', exclusions: [] }],
    getChatHandoffArtifact: [{ chatId, contextWindowTokens: 1000 }],
    lookupNativeSession: [{ nativeSessionId: 'synthetic' }],
    startChat: [{ chatId }], runChat: [{ chatId }], forkChat: [{ chatId }], forkRun: [{ chatId }],
    steerChat: [{ chatId }], stopChat: [{ chatId }], decidePermission: [{ chatId }],
    getChatRowTarget: [chatId], addChatRow: [{ chatId }], updateChatTitle: [{ chatId }],
    setChatPinned: [{ chatId }], setChatArchived: [{ chatId }], setChatTags: [{ chatId, tags: [] }],
    getTurnReceipt: [chatId, 'synthetic'], getTicketBootstrap: [], getTicketProjectDefault: ['/synthetic'],
    listTickets: [{}], readTicket: [{ ticketId: 'synthetic' }], getTicketHistory: [{ ticketId: 'synthetic' }],
    mutateTicket: [{}],
  } satisfies Record<Operation, unknown[]>;
  expect(Object.entries(Object.getOwnPropertyDescriptors(GarconClient.prototype))
    .filter(([name, descriptor]) => typeof descriptor.value === 'function' && name !== 'constructor' && name !== 'verifyRuntime')
    .map(([name]) => name).sort()).toEqual(Object.keys(args).sort());
  for (const [name, parameters] of Object.entries(args)) {
    await Reflect.apply(client[name as Operation], client, parameters).catch(() => {});
  }
  expect([...operations].sort()).toEqual(Object.keys(CLI_OPERATIONS).sort());
});
