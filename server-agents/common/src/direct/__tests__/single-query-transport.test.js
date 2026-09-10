import { expect, it } from 'bun:test';
import { runAnthropicCompatibleSingleQuery } from '../anthropic-compatible-chat-runtime.ts';
import { runOpenAiCompatibleSingleQuery } from '../openai-compatible-chat-runtime.ts';
import { runOpenAiResponsesSingleQuery } from '../openai-compatible-responses-runtime.ts';

// Bun clamps positive client idle timeouts to a minimum of eight seconds.
const SIMULATED_IDLE_TIMEOUT_MS = 100;
const SILENT_RESPONSE_DELAY_MS = 9_000;

function eventStream(body) {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function responseFor(pathname) {
  if (pathname === '/chat/completions') {
    return eventStream([
      'data: {"choices":[{"delta":{"content":"chat"}}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'));
  }

  if (pathname === '/v1/messages') {
    return eventStream([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic"}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n\n'));
  }

  if (pathname === '/responses') {
    return eventStream([
      'data: {"type":"response.output_text.delta","delta":"responses"}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
    ].join('\n\n'));
  }

  return new Response('Not found', { status: 404 });
}

it('keeps direct single queries alive beyond Bun client idle timeouts', async () => {
  const originalFetch = globalThis.fetch;
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    async fetch(request) {
      await Bun.sleep(SILENT_RESPONSE_DELAY_MS);
      return responseFor(new URL(request.url).pathname);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  globalThis.fetch = (input, init) => originalFetch(input, {
    ...init,
    timeout: init?.timeout ?? SIMULATED_IDLE_TIMEOUT_MS,
  });

  try {
    const results = await Promise.all([
      runOpenAiCompatibleSingleQuery({
        runtimeLabel: 'OpenAI Chat',
        defaultModel: 'test-model',
        getApiKey: () => 'test-key',
        getBaseUrl: () => baseUrl,
      }, 'test'),
      runAnthropicCompatibleSingleQuery({
        runtimeLabel: 'Anthropic',
        defaultModel: 'test-model',
        getApiKey: () => 'test-key',
        getBaseUrl: () => baseUrl,
      }, 'test'),
      runOpenAiResponsesSingleQuery({
        runtimeLabel: 'OpenAI Responses',
        defaultModel: 'test-model',
        getApiKey: () => 'test-key',
        getBaseUrl: () => baseUrl,
      }, 'test'),
    ]);

    expect(results).toEqual(['chat', 'anthropic', 'responses']);
  } finally {
    globalThis.fetch = originalFetch;
    await server.stop(true);
  }
}, 15_000);
