import { afterEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { symlink, writeFile } from 'node:fs/promises';
import { createLocatedInstanceFixture, LOCATED_CHATS } from '../../agents/__tests__/located-instance-fixture.js';
import createCommandsRoutes from '../commands.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const f = await createLocatedInstanceFixture();
  fixtures.push(f);
  const routes = createCommandsRoutes({ registry: f.chats, agents: f.agents });
  return {
    ...f,
    request(query, signal) {
      const url = new URL(`http://localhost/api/v1/commands?${new URLSearchParams(query)}`);
      return routes['/api/v1/commands'].GET(new Request(url, { signal }), url);
    },
  };
}

describe('slash-command owner routing', () => {
  test('discovers commands on the chat instance, not the provider default', async () => {
    const f = await fixture();
    const response = await f.request({ chatId: LOCATED_CHATS.secondary, agent: 'test' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [{ name: 'secondary-command', source: 'command' }] });
    expect(f.secondary.integration.commands.discover).toHaveBeenCalledTimes(1);
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test.each(['missing-profile', 'remote-node'])('fails closed for %s before inspecting a controller path', async (missing) => {
    const f = await fixture();
    const chatId = LOCATED_CHATS.secondary;
    const entry = f.chats.getChat(chatId);
    await f.chats.updateChat(chatId, {
      executionLocation: {
        ...entry.executionLocation,
        ...(missing === 'remote-node' ? { nodeId: 'remote-node' } : { instanceId: 'missing-profile' }),
      },
      projectPath: join(f.root, 'not-on-controller'),
    });
    const response = await f.request({ chatId, agent: 'test' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: 'NODE_UNAVAILABLE' });
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
    expect(f.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('project-only discovery explicitly uses the local provider default', async () => {
    const f = await fixture();
    const response = await f.request({ projectPath: f.root, agent: 'test' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [{ name: 'primary-command', source: 'command' }] });
    expect(f.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('a staged provider override cannot bypass an unavailable source owner', async () => {
    const f = await fixture();
    const chatId = LOCATED_CHATS.secondary;
    const entry = f.chats.getChat(chatId);
    await f.chats.updateChat(chatId, {
      executionLocation: { ...entry.executionLocation, nodeId: 'unavailable-node' },
      projectPath: join(f.root, 'not-on-controller'),
    });
    const response = await f.request({ chatId, agent: 'staged' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: 'NODE_UNAVAILABLE' });
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
    expect(f.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('preserves project filesystem errors before discovery', async () => {
    const f = await fixture();
    const missing = join(f.root, 'missing-project');
    const missingResponse = await f.request({ agent: 'test', projectPath: missing });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: `Project path not found: ${missing}` });
    const filePath = join(f.root, 'not-a-directory');
    await writeFile(filePath, 'synthetic file');
    const fileResponse = await f.request({ agent: 'test', projectPath: filePath });
    expect(fileResponse.status).toBe(400);
    expect(await fileResponse.json()).toMatchObject({ errorCode: 'PROJECT_PATH_NOT_DIRECTORY' });
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('passes the canonical project path to the exact chat instance', async () => {
    const f = await fixture();
    const alias = join(f.root, 'project-alias');
    await symlink(f.root, alias);
    await f.chats.updateChat(LOCATED_CHATS.secondary, {
      projectPath: alias, executionLocation: f.chats.getChat(LOCATED_CHATS.secondary).executionLocation,
    });
    expect((await f.request({ chatId: LOCATED_CHATS.secondary, agent: 'test' })).status).toBe(200);
    expect(f.secondary.integration.commands.discover.mock.calls[0][0]).toBe(f.root);
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('keeps a null commands facet empty on the selected instance', async () => {
    const f = await fixture();
    f.secondary.integration.commands = null;
    const response = await f.request({ chatId: LOCATED_CHATS.secondary, agent: 'test' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [] });
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('passes cancellation to command discovery', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const called = Promise.withResolvers();
    f.secondary.integration.commands.discover.mockImplementation(async (_path, signal) => {
      called.resolve(signal);
      return [];
    });
    const pending = f.request({ chatId: LOCATED_CHATS.secondary, agent: 'test' }, controller.signal);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(f.secondary.integration.commands.discover).toHaveBeenCalledTimes(1);
    const signal = await called.promise;
    controller.abort();
    expect(signal.aborted).toBeTrue();
  });

  test.each(['chat', 'default'])('%s command cancellation returns 499 without a provider error body', async (target) => {
    const f = await fixture();
    const controller = new AbortController();
    const called = Promise.withResolvers();
    const reply = Promise.withResolvers();
    const integration = target === 'chat' ? f.secondary.integration : f.primary.integration;
    integration.commands.discover.mockImplementation(() => { called.resolve(); return reply.promise; });
    const query = target === 'chat' ? { chatId: LOCATED_CHATS.secondary, agent: 'test' }
      : { projectPath: f.root, agent: 'test' };
    const pending = f.request(query, controller.signal);
    await called.promise;
    controller.abort(new Error('Synthetic command cancellation'));
    reply.resolve([]);
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe('');
  });

  test('rejects missing chats and project inputs without discovery', async () => {
    const f = await fixture();
    expect((await f.request({ agent: 'test', chatId: '1000000000000099', projectPath: f.root })).status).toBe(404);
    expect((await f.request({ agent: 'test' })).status).toBe(400);
    expect((await f.request({ projectPath: f.root })).status).toBe(400);
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
  });

  test('preserves an intentional staged provider selection within the chat node', async () => {
    const discover = mock(async () => [{ name: 'staged-command', source: 'command' }]);
    /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'descriptor' | 'commands'>} */
    const staged = {
      descriptor: {
        id: 'staged', label: 'Synthetic staged provider', icon: null,
        supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
        supportsImages: false, supportsProjectPathUpdate: false,
        requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
      },
      commands: { discover },
    };
    const f = await createLocatedInstanceFixture([{
      configuration: {
        nodeId: 'local-node', id: 'staged-default', agentId: 'staged', label: 'Synthetic staged provider',
        storageNamespace: 'instances/staged', default: true, removedAt: null,
      },
      integration: staged,
    }]);
    fixtures.push(f);
    const routes = createCommandsRoutes({ registry: f.chats, agents: f.agents });
    const url = new URL(`http://localhost/api/v1/commands?chatId=${LOCATED_CHATS.secondary}&agent=staged`);
    const response = await routes['/api/v1/commands'].GET(new Request(url), url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [{ name: 'staged-command', source: 'command' }] });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
    expect(f.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });
});
