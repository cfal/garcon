import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type { AgentRunCommandRequest } from '@garcon/common/chat-command-contracts';
import { runtimeProofPayload } from '@garcon/common/server-runtime';
import { GarconClient, GarconHttpError, GarconTransportError } from '../garcon-client.js';

const connection = {
  baseUrl: 'http://127.0.0.1:8080',
  instanceId: 'instance',
  localCapability: 'garcon_local_secret',
  workspaceDir: '/config/workspace-default',
};

const runRequest: AgentRunCommandRequest = {
  clientRequestId: 'request',
  clientMessageId: 'message',
  chatId: '1785337200123456',
  command: 'Continue',
  tagsToAdd: ['cli'],
};

function accepted(request: AgentRunCommandRequest): Response {
  return Response.json({
    success: true,
    commandType: 'agent-run',
    clientRequestId: request.clientRequestId,
    chatId: request.chatId,
    turnId: 'turn-1',
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
  });
}

function runtimeResponse(input: string | URL | Request, instanceId = connection.instanceId): Response {
  const url = new URL(input instanceof Request ? input.url : input);
  const challenge = url.searchParams.get('challenge') ?? '';
  const proof = crypto.createHmac('sha256', connection.localCapability)
    .update(runtimeProofPayload(instanceId, challenge))
    .digest('base64url');
  return Response.json({ schemaVersion: 1, instanceId, proof });
}

describe('GarconClient', () => {
  test('authenticates requests with the process capability', async () => {
    let authorization: string | null = null;
    let redirect: RequestRedirect | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        redirect = init?.redirect;
        return accepted(runRequest);
      },
    });
    expect((await client.runChat(runRequest)).turnId).toBe('turn-1');
    expect(authorization).toBe('Bearer garcon_local_secret');
    expect(redirect).toBe('error');
  });

  test('updates a chat title through the existing workspace API', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          body: String(init?.body),
        };
        return Response.json({ success: true });
      },
    });

    await client.updateChatTitle({ chatId: runRequest.chatId, title: 'Delegated review' });

    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/app/session-name`,
      method: 'PUT',
      body: JSON.stringify({ chatId: runRequest.chatId, title: 'Delegated review' }),
    });
  });

  test('retries an ambiguous submission with the identical request body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new TypeError('connection reset');
        return accepted(runRequest);
      },
    });
    await client.runChat(runRequest);
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('retries when an accepted response body is interrupted', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":true'));
              controller.error(new TypeError('connection reset'));
            },
          }), { status: 202, headers: { 'Content-Type': 'application/json' } });
        }
        return accepted(runRequest);
      },
    });

    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('classifies an interrupted receipt body as a transport failure', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError('connection reset'));
        },
      }), { status: 200 }),
    });

    await expect(client.getTurnReceipt(runRequest.chatId, 'turn-1'))
      .rejects.toBeInstanceOf(GarconTransportError);
  });

  test('retries a malformed successful submission response with the exact body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        return attempts === 1
          ? Response.json({ success: true })
          : accepted(runRequest);
      },
    });
    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('reports the candidate chat after ambiguous recovery is exhausted', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return new Response('{"success":', { status: 202 });
      },
    });

    await expect(client.runChat(runRequest)).rejects.toThrow(
      `chat ${runRequest.chatId} may still be running`,
    );
    expect(attempts).toBe(3);
  });

  test.each([408, 425, 429, 500, 502, 503, 504])('retries ambiguous HTTP %i responses', async (status) => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: 'try again' }, { status })
          : accepted(runRequest);
      },
    });

    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
  });

  test('does not retry an ambiguous submission on a replacement runtime', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) {
          return runtimeResponse(input, 'replacement-instance');
        }
        submissions += 1;
        throw new TypeError('connection reset');
      },
    });

    await expect(client.runChat(runRequest)).rejects.toThrow(
      `chat ${runRequest.chatId} may have been accepted`,
    );
    expect(submissions).toBe(1);
  });

  test('does not confuse a retryable busy admission with an ambiguous outcome', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      fetch: async () => {
        attempts += 1;
        return Response.json({
          success: false,
          error: 'Chat is busy',
          errorCode: 'SESSION_BUSY',
          retryable: true,
        }, { status: 409 });
      },
    });
    await expect(client.runChat(runRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(attempts).toBe(1);
  });

  test('parses Retry-After for receipt recovery', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ error: 'busy' }, {
        status: 503,
        headers: { 'Retry-After': '3' },
      }),
    });

    try {
      await client.getTurnReceipt(runRequest.chatId, 'turn-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).retryAfterMs).toBe(3_000);
    }
  });

  test('caps Retry-After values used by recovery', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ error: 'busy' }, {
        status: 503,
        headers: { 'Retry-After': '31536000' },
      }),
    });

    try {
      await client.getTurnReceipt(runRequest.chatId, 'turn-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).retryAfterMs).toBe(5_000);
    }
  });

  test('does not accept a response without correlated fields', async () => {
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => String(input).includes('/api/v1/runtime')
        ? runtimeResponse(input)
        : Response.json({ success: true, status: 'accepted' }),
    });
    await expect(client.runChat(runRequest)).rejects.toThrow('may still be running');
  });

  test('recovers from an accepted response for a different request', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return attempts === 1
          ? Response.json({
            ...await accepted(runRequest).json(),
            clientRequestId: 'other',
          })
          : accepted(runRequest);
      },
    });
    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
  });
});
