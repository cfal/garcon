import { expect, mock, test } from 'bun:test';
import { LocalProviderCommandsService } from '../local-provider-commands.js';

test('captures the requested project and returns cloned commands from the owner-validated path', async () => {
  const resolution = Promise.withResolvers();
  const inspect = mock(() => resolution.promise);
  /** @type {import('@garcon/common/slash-commands').SlashCommand[]} */
  const commands = [{ name: 'synthetic-command', source: 'command', description: 'Synthetic command' }];
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'commands'>} */
  const integration = { commands: { discover: mock(async () => commands) } };
  const service = new LocalProviderCommandsService(integration, inspect);
  const request = { projectPath: '/synthetic/alias' };
  const signal = new AbortController().signal;
  const pending = service.discover(request, signal);
  request.projectPath = '/synthetic/changed';
  resolution.resolve({ kind: 'available', effectiveProjectKey: '/synthetic/canonical' });
  const result = await pending;
  expect(inspect).toHaveBeenCalledWith('/synthetic/alias');
  expect(integration.commands.discover).toHaveBeenCalledWith('/synthetic/canonical', signal);
  expect(result).toEqual(commands);
  result[0].description = 'Caller mutation';
  expect(commands[0].description).toBe('Synthetic command');
});

test('validates the project even when the instance has no command facet', async () => {
  const inspect = mock(async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }));
  const service = new LocalProviderCommandsService({ commands: null }, inspect);
  expect(await service.discover({ projectPath: '/synthetic/project' }, new AbortController().signal)).toEqual([]);
  expect(inspect).toHaveBeenCalledTimes(1);
});

test('an unavailable project never enters provider command discovery', async () => {
  const discover = mock(async () => []);
  const service = new LocalProviderCommandsService({ commands: { discover } }, async () => ({
    kind: 'unavailable', reason: 'outside-base',
  }));
  await expect(service.discover({ projectPath: '/synthetic/outside' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
  expect(discover).not.toHaveBeenCalled();
});

test('cancellation before discovery or during path validation does not enter the provider', async () => {
  const resolution = Promise.withResolvers();
  const inspect = mock(() => resolution.promise);
  const discover = mock(async () => []);
  const service = new LocalProviderCommandsService({ commands: { discover } }, inspect);
  const controller = new AbortController();
  const pending = service.discover({ projectPath: '/synthetic/project' }, controller.signal);
  controller.abort(new Error('Synthetic cancellation'));
  resolution.resolve({ kind: 'available', effectiveProjectKey: '/synthetic/project' });
  await expect(pending).rejects.toBe(controller.signal.reason);
  await expect(service.discover({ projectPath: '/synthetic/project' }, controller.signal))
    .rejects.toBe(controller.signal.reason);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(discover).not.toHaveBeenCalled();
});

test('discards results if a provider finishes after its caller cancelled', async () => {
  const result = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const service = new LocalProviderCommandsService({ commands: {
    discover: async (_project, signal) => {
      expect(signal).toBe(controller.signal);
      entered.resolve();
      return result.promise;
    },
  } }, async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }));
  const pending = service.discover({ projectPath: '/synthetic/project' }, controller.signal);
  await entered.promise;
  controller.abort(new Error('Synthetic cancellation'));
  result.resolve([{ name: 'obsolete', source: 'command' }]);
  await expect(pending).rejects.toBe(controller.signal.reason);
});
