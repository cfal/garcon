import { describe, expect, test } from 'bun:test';
import type { AgentRunCommandRequest } from '@garcon/common/chat-command-contracts';
import { GarconClient, GarconHttpError } from '../garcon-client.js';

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

describe('GarconClient', () => {
  test('authenticates requests with the process capability', async () => {
    let authorization: string | null = null;
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return accepted(runRequest);
      },
    });
    expect((await client.runChat(runRequest)).turnId).toBe('turn-1');
    expect(authorization).toBe('Bearer garcon_local_secret');
  });

  test('retries an ambiguous submission with the identical request body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (_input, init) => {
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

  test('retries a malformed successful submission response', async () => {
    const bodies: string[] = [];
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1 ? Response.json({ success: true }) : accepted(runRequest);
      },
    });
    expect((await client.runChat(runRequest)).turnId).toBe('turn-1');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('does not retry a terminal admission error', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      fetch: async () => {
        attempts += 1;
        return Response.json({
          success: false,
          error: 'Chat is busy',
          errorCode: 'SESSION_BUSY',
          retryable: false,
        }, { status: 409 });
      },
    });
    await expect(client.runChat(runRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(attempts).toBe(1);
  });

  test('requires correlated fields in accepted responses', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ success: true, status: 'accepted' }),
    });
    await expect(client.runChat(runRequest)).rejects.toThrow('invalid command acceptance');
  });
});
