import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { runtimeProofPayload } from '@garcon/common/server-runtime';
import { parseCliArgs } from '../args.js';
import { GarconClient, GarconHttpError } from '../garcon-client.js';

const connection = {
  baseUrl: 'http://127.0.0.1:8080', instanceId: 'controller', endpointInstanceId: 'gateway',
  defaultNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceName: null,
  localCapability: 'secret', workspaceDir: null,
};
const request = { clientRequestId: 'request', clientMessageId: 'message', chatId: '1785337200123456', command: 'Continue' };

function runtimeResponse(input: string | URL | Request, controller = 'controller'): Response {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/cli/context')) return Response.json({
    serverInstanceId: controller, defaultNodeId: connection.defaultNodeId, workspaceName: null,
  });
  return Response.json({ schemaVersion: 1, instanceId: 'gateway', proof: crypto.createHmac('sha256', 'secret')
    .update(runtimeProofPayload('gateway', url.searchParams.get('challenge')!)).digest('base64url') });
}

describe('CLI endpoint context', () => {
  test('catalogs, native lookups and project defaults use the authenticated node', async () => {
    const client = new GarconClient({ ...connection, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/models')) {
        expect(url.searchParams.get('nodeId')).toBe(connection.defaultNodeId);
        return Response.json({ catalog: { agents: [], apiProviders: [] } });
      }
      expect(JSON.parse(String(init?.body)).nodeId).toBe(connection.defaultNodeId);
      return Response.json(url.pathname.endsWith('/project-default')
        ? { project: '/worker/project', kind: 'folder' } : { chatId: request.chatId });
    } });
    await client.getModelCatalog();
    await client.lookupNativeSession({ nativeSessionId: 'native' });
    await client.getTicketProjectDefault('/worker/project');
  });
  test('pins inherited runtime, ignores ambient selectors, and accepts workspace only as an assertion', () => {
    const env = { GARCON_CLI_RUNTIME: '/private/runtime.json', GARCON_WORKSPACE: 'wrong', GARCON_CONFIG_DIR: '/wrong' };
    expect(parseCliArgs(['list', 'agents', '--workspace', 'right'], env)).toMatchObject({
      runtimeFile: '/private/runtime.json', expectedWorkspace: 'right', workspace: 'right',
    });
    expect(() => parseCliArgs(['chats', '--runtime-file', '/other'], env)).toThrow('conflicts');
    expect(() => parseCliArgs(['chats', '--config-dir', '/other'], env)).toThrow('--config-dir');
    expect(parseCliArgs(['chats', '--runtime-file', '/private/runtime.json'], env)).toMatchObject({ runtimeFile: '/private/runtime.json' });
  });

  test('a stable endpoint proof cannot hide controller restart', async () => {
    const client = new GarconClient({ ...connection, fetch: async (input, init) => {
      if (String(input).endsWith('/cli/context')) expect(new Headers(init?.headers).get('X-Garcon-Server-Instance')).toBe('controller');
      return runtimeResponse(input, 'replacement');
    } });
    expect(await client.verifyRuntime()).toBe(false);
  });

  test.each(['CLI_SERVICE_BUSY', 'CLI_CONTROLLER_UNAVAILABLE', 'CLI_CONTROLLER_CHANGED', 'CLI_ACCESS_DENIED'])('%s never triggers a mutation retry by itself', async (errorCode) => {
    let calls = 0;
    const client = new GarconClient({ ...connection, fetch: async () => {
      calls++;
      return Response.json({ error: 'rejected before dispatch', errorCode, retryable: false }, { status: 503 });
    } });
    await expect(client.runChat(request)).rejects.toBeInstanceOf(GarconHttpError);
    expect(calls).toBe(1);
  });

  test('later admission rejection cannot erase an uncertain steer attempt', async () => {
    const bodies: string[] = [];
    const client = new GarconClient({ ...connection, submissionDelay: async () => {}, fetch: async (input, init) => {
      if (/runtime|cli\/context/.test(String(input))) return runtimeResponse(input);
      bodies.push(String(init?.body));
      return Response.json({ error: 'unavailable', errorCode: bodies.length === 1 ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_SERVICE_BUSY' }, { status: 503 });
    } });
    await expect(client.steerChat({ ...request, expectedTurnId: 'turn' })).rejects.toThrow('may have been accepted');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });
});
