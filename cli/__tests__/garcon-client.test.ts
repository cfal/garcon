import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  SteerCommandRequest,
} from '@garcon/common/chat-command-contracts';
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

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observedAt: '2026-08-04T12:00:00.000Z',
    messageLimit: 10,
    chat: {
      id: runRequest.chatId,
      title: 'Review',
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      carryOverRevision: 'carry-v1:0',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      projectPath: '/project',
      tags: ['cli'],
      canReloadFromNativeHistory: false,
      activity: { createdAt: null, lastActivityAt: null },
    },
    processingPhase: null,
    control: {
      serverInstanceId: connection.instanceId,
      queue: {
        entries: [],
        steeringEntryId: null,
        recentlyDispatched: [],
        pause: null,
        reorderRevision: 0,
      },
      version: 0,
      updatedAt: null,
    },
    transcript: {
      availability: 'available',
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 0,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 0,
      nextBeforeOrdinal: null,
      hasMore: false,
    },
    transientFeed: {
      serverInstanceId: connection.instanceId,
      chatId: runRequest.chatId,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    },
    ...overrides,
  };
}

describe('GarconClient', () => {
  test('fetches and validates a correlated transcript export', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validExport());
      },
    });

    await expect(client.getTranscriptExport({
      chatId: runRequest.chatId,
      format: 'xml',
      exclusions: ['tool-calls', 'reasoning'],
    })).resolves.toMatchObject({ format: 'xml', entryCount: 1 });
    expect(requestedUrl).toBe(
      `${connection.baseUrl}/api/v1/chats/export?chatId=${runRequest.chatId}&format=xml&exclude=tool-calls&exclude=reasoning`,
    );
  });

  test('rejects malformed and uncorrelated transcript exports', async () => {
    for (const response of [
      { ...validExport(), document: 'missing newline' },
      { ...validExport(), chatId: '1785337200123457' },
      { ...validExport(), exclusions: [], omitted: [] },
    ]) {
      const client = new GarconClient({ ...connection, fetch: async () => Response.json(response) });
      await expect(client.getTranscriptExport({
        chatId: runRequest.chatId,
        format: 'xml',
        exclusions: ['tool-calls', 'reasoning'],
      })).rejects.toBeInstanceOf(Error);
    }
  });

  test('maps export validation failures to an argument-level exit', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Invalid filter',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      }, { status: 400 }),
    });
    await expect(client.getTranscriptExport({
      chatId: runRequest.chatId,
      format: 'markdown',
      exclusions: [],
    })).rejects.toMatchObject({ phase: 'export', exitCode: 2 });
  });

  test('fetches and validates a correlated chat snapshot', async () => {
    let request: { url: string; method: string | undefined; authorization: string | null } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization'),
        };
        return Response.json(validSnapshot());
      },
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10)).resolves.toMatchObject({
      chat: { id: runRequest.chatId },
      messageLimit: 10,
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/snapshot?chatId=${runRequest.chatId}&limit=10`,
      method: 'GET',
      authorization: `Bearer ${connection.localCapability}`,
    });
  });

  test.each([
    ['chat ID', () => validSnapshot({
      chat: { ...validSnapshot().chat as object, id: '1785337200123457' },
      transientFeed: {
        ...validSnapshot().transientFeed as object,
        chatId: '1785337200123457',
      },
    })],
    ['message limit', () => validSnapshot({ messageLimit: 9 })],
    ['server instance', () => validSnapshot({
      control: { ...validSnapshot().control as object, serverInstanceId: 'other-instance' },
    })],
  ])('rejects an uncorrelated snapshot by %s', async (_label, response) => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json(response()),
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10))
      .rejects.toThrow('uncorrelated chat snapshot');
  });

  test('rejects a malformed chat snapshot contract', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json(validSnapshot({ processingPhase: 'busy' })),
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10))
      .rejects.toThrow('invalid chat snapshot');
  });

  test('maps a missing snapshot to an argument-level exit', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Session not found',
        errorCode: 'SESSION_NOT_FOUND',
        retryable: false,
      }, { status: 404 }),
    });

    try {
      await client.getChatSnapshot(runRequest.chatId, 10);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).phase).toBe('chat status');
      expect((error as GarconHttpError).exitCode).toBe(2);
    }
  });

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

  const steerRequest: SteerCommandRequest = {
    clientRequestId: 'steer-request',
    clientMessageId: 'steer-message',
    chatId: runRequest.chatId,
    content: 'Follow up',
  };

  function steerAccepted(request: SteerCommandRequest): Response {
    return Response.json({
      success: true,
      commandType: 'steer',
      clientRequestId: request.clientRequestId,
      chatId: request.chatId,
      turnId: 'turn-active',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    });
  }

  test('submits a steer to the existing endpoint with the exact body', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = { url: String(input), method: init?.method, body: String(init?.body) };
        return steerAccepted(steerRequest);
      },
    });

    await expect(client.steerChat(steerRequest)).resolves.toMatchObject({
      commandType: 'steer',
      turnId: 'turn-active',
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/steer`,
      method: 'POST',
      body: JSON.stringify(steerRequest),
    });
  });

  test('does not retry a recorded unknown steering outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        submissions += 1;
        return Response.json({
          success: false,
          error: 'Steering delivery could not be confirmed.',
          errorCode: 'STEER_OUTCOME_UNKNOWN',
          retryable: false,
        }, { status: 500 });
      },
    });

    await expect(client.steerChat(steerRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(submissions).toBe(1);
  });

  test('does not retry a definitively non-delivered steering outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        submissions += 1;
        return Response.json({
          success: false,
          error: 'Steering delivery failed.',
          errorCode: 'STEER_NOT_DELIVERED',
          retryable: false,
        }, { status: 502 });
      },
    });

    await expect(client.steerChat(steerRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(submissions).toBe(1);
  });

  test('retries an ambiguous errorCode-less steer submission with the exact body', async () => {
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
          ? Response.json({ error: 'try again' }, { status: 503 })
          : steerAccepted(steerRequest);
      },
    });

    await expect(client.steerChat(steerRequest)).resolves.toMatchObject({ turnId: 'turn-active' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('does not accept a steer response without a correlated turn identity', async () => {
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => String(input).includes('/api/v1/runtime')
        ? runtimeResponse(input)
        : Response.json({ success: true, status: 'accepted' }),
    });
    await expect(client.steerChat(steerRequest)).rejects.toThrow('may still be running');
  });

  const stopRequest: AgentStopCommandRequest = {
    clientRequestId: 'stop-request',
    chatId: runRequest.chatId,
  };

  const validControl = {
    serverInstanceId: 'instance',
    queue: {
      entries: [],
      steeringEntryId: null,
      recentlyDispatched: [],
      pause: null,
      reorderRevision: 0,
    },
    version: 0,
    updatedAt: null,
  };

  function stopAccepted(overrides: Record<string, unknown> = {}): Response {
    return Response.json({
      success: true,
      commandType: 'agent-stop',
      clientRequestId: stopRequest.clientRequestId,
      chatId: stopRequest.chatId,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      outcome: 'interrupt-requested',
      control: validControl,
      ...overrides,
    });
  }

  test('parses and correlates a stop response', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = { url: String(input), method: init?.method, body: String(init?.body) };
        return stopAccepted();
      },
    });

    await expect(client.stopChat(stopRequest)).resolves.toMatchObject({
      outcome: 'interrupt-requested',
      control: validControl,
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/stop`,
      method: 'POST',
      body: JSON.stringify(stopRequest),
    });
  });

  test('retries an ambiguous stop submission with the exact request', async () => {
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
        return stopAccepted();
      },
    });

    await expect(client.stopChat(stopRequest)).resolves.toMatchObject({ outcome: 'interrupt-requested' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('never accepts a stop response with a malformed outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        submissions += 1;
        return stopAccepted({ outcome: 'stopped-somehow' });
      },
    });

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may still be running`,
    );
    expect(submissions).toBe(3);
  });

  test('never accepts a stop response with a malformed control state', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        submissions += 1;
        return stopAccepted({ control: { serverInstanceId: 'instance' } });
      },
    });

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may still be running`,
    );
    expect(submissions).toBe(3);
  });

  test('does not retry a stop submission against a replacement runtime', async () => {
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

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may have been accepted`,
    );
    expect(submissions).toBe(1);
  });
});

function validExport(): Record<string, unknown> {
  return {
    success: true,
    chatId: runRequest.chatId,
    format: 'xml',
    transcriptViewId: 'view-1',
    lastOrdinal: 3,
    generatedAt: '2026-08-23T00:00:00.000Z',
    entryCount: 1,
    totalEntryCount: 3,
    exclusions: ['tool-calls', 'reasoning'],
    omitted: [
      { category: 'tool-calls', count: 1 },
      { category: 'reasoning', count: 1 },
    ],
    document: '<?xml version="1.0"?>\n',
  };
}

describe('GarconClient add-row', () => {
  const addRequest = {
    clientRequestId: 'row-request',
    clientMessageId: 'row-message',
    chatId: runRequest.chatId,
    transcriptViewId: 'view-1',
    type: 'error' as const,
    title: 'Release validation',
    content: 'durable error',
  };

  test('validates the target and correlates every mutation identity', async () => {
    const seen: Array<{ url: string; body: string | null }> = [];
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, body: init?.body ? String(init.body) : null });
        if (url.includes('?chatId=')) {
          return Response.json({
            success: true,
            chatId: runRequest.chatId,
            transcriptViewId: 'view-1',
          });
        }
        const body = JSON.parse(String(init?.body));
        return Response.json({
          success: true,
          commandType: 'chat-row-add',
          ...body,
          ordinal: 3,
          status: 'appended',
          timestamp: '2026-08-18T00:00:00.000Z',
        });
      },
    });

    await expect(client.getChatRowTarget(runRequest.chatId)).resolves.toMatchObject({
      transcriptViewId: 'view-1',
    });
    await expect(client.addChatRow(addRequest)).resolves.toMatchObject({
      ordinal: 3,
      status: 'appended',
    });
    expect(seen[1]?.body).toBe(JSON.stringify(addRequest));
  });

  test('retries an ambiguous mutation with the byte-identical request body', async () => {
    const bodies: string[] = [];
    let postAttempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/v1/runtime?')) return runtimeResponse(input);
        bodies.push(String(init?.body));
        postAttempts += 1;
        if (postAttempts === 1) throw new TypeError('connection reset');
        return Response.json({
          success: true,
          commandType: 'chat-row-add',
          ...addRequest,
          ordinal: 3,
          status: 'duplicate',
          timestamp: '2026-08-18T00:00:00.000Z',
        });
      },
    });

    await expect(client.addChatRow(addRequest)).resolves.toMatchObject({ status: 'duplicate' });
    expect(bodies).toEqual([JSON.stringify(addRequest), JSON.stringify(addRequest)]);
  });

  test('does not retry or refresh a definitive stale-view response', async () => {
    let calls = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        calls += 1;
        return Response.json({
          success: false,
          error: 'The transcript changed before the row was added.',
          errorCode: 'STALE_TRANSCRIPT_VIEW',
          retryable: false,
        }, { status: 409 });
      },
    });

    await expect(client.addChatRow(addRequest)).rejects.toMatchObject({
      errorCode: 'STALE_TRANSCRIPT_VIEW',
    });
    expect(calls).toBe(1);
  });
});
