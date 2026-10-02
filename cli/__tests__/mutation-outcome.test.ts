import { expect, spyOn, test } from 'bun:test';
import { GarconClient, GarconHttpError } from '../garcon-client.js';

const chatId = '1785337200123456';
const mutations = [
  (client: GarconClient, signal?: AbortSignal) => client.updateChatTitle({ chatId, title: 'Synthetic' }, signal),
  (client: GarconClient, signal?: AbortSignal) => client.setChatPinned({ chatId, isPinned: true }, signal),
  (client: GarconClient, signal?: AbortSignal) => client.setChatArchived({ chatId, isArchived: true }, signal),
  (client: GarconClient, signal?: AbortSignal) => client.setChatTags({ chatId, tags: ['review'] }, signal),
  (client: GarconClient, signal?: AbortSignal) => client.setTranscriptSearchEnabled(true, signal),
  (client: GarconClient, signal?: AbortSignal) => client.rebuildTranscriptSearch(signal),
];

function harness(reply: () => Response | Promise<Response>) {
  let submissions = 0;
  const client = new GarconClient({
    baseUrl: 'http://localhost:8080', instanceId: 'instance', endpointInstanceId: 'instance',
    defaultExecutorId: 'local', workspaceName: 'default', workspaceDir: '/workspace', localCapability: 'synthetic',
    fetch: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET') return Response.json({ success: true, chatId, tags: [] });
      submissions += 1;
      return reply();
    }, { preconnect() {} }),
  });
  return { client, submissions: () => submissions };
}

const ambiguousReplies = [
  () => { throw new Error('Synthetic commit then connection reset'); },
  () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Synthetic broken body')); } })),
  () => new Response('invalid JSON'),
  () => Response.json({ unexpected: true }),
  () => new Response('Synthetic proxy failure', { status: 502 }),
  () => Response.json({ error: 'Synthetic post-rename failure', errorCode: 'INTERNAL_ERROR' }, { status: 500 }),
];

test.each(mutations)('one-shot mutation reports uncertain replies without resubmitting', async (mutate) => {
  for (const reply of ambiguousReplies) {
    const { client, submissions } = harness(reply);
    await expect(mutate(client)).rejects.toThrow('mutation outcome is unknown');
    expect(submissions()).toBe(1);
  }
});

test.each(mutations)('one-shot mutation preserves definitive rejections and preflight cancellation', async (mutate) => {
  for (const [status, errorCode] of [[400, 'VALIDATION_FAILED'], [403, 'CLI_ACCESS_DENIED'],
    [409, 'CLI_CONTROLLER_CHANGED'], [503, 'CLI_SERVICE_BUSY'], [503, 'CLI_CONTROLLER_UNAVAILABLE']] as const) {
    const { client, submissions } = harness(() => Response.json({ error: 'Synthetic rejection', errorCode }, { status }));
    await expect(mutate(client)).rejects.toBeInstanceOf(GarconHttpError);
    expect(submissions()).toBe(1);
  }
  const { client, submissions } = harness(() => { throw new Error('No mutation expected'); });
  const signal = AbortSignal.abort(new Error('Synthetic preflight cancellation'));
  await expect(mutate(client, signal)).rejects.toThrow('Synthetic preflight cancellation');
  expect(submissions()).toBe(0);
});

test('failed tag recovery is not described as a submitted mutation', async () => {
  const client = new GarconClient({
    baseUrl: 'http://localhost:8080', instanceId: 'instance', endpointInstanceId: 'instance',
    defaultExecutorId: 'local', workspaceName: 'default', workspaceDir: '/workspace', localCapability: 'synthetic',
    fetch: Object.assign(async () => { throw new Error('Synthetic preflight failure'); }, { preconnect() {} }),
  });
  await expect(client.setChatTags({ chatId, tags: [] })).rejects.toThrow('no confirmed response');
});

test('a timed-out submitted write remains unknown rather than claiming non-delivery', async () => {
  const timeout = new AbortController();
  const timer = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  try {
    const { client, submissions } = harness(() => {
      timeout.abort(new DOMException('Synthetic timeout after commit', 'TimeoutError'));
      throw timeout.signal.reason;
    });
    await expect(client.updateChatTitle({ chatId, title: 'Synthetic' })).rejects.toThrow('mutation outcome is unknown');
    expect(submissions()).toBe(1);
  } finally {
    timer.mockRestore();
  }
});
