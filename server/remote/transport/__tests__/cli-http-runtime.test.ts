import { expect, test } from 'bun:test';
import { CLI_CONTRACTS, CLI_CONTRACT_HEADER } from '@garcon/common/cli-contracts';
import { parseStartChatCommandRequest } from '@garcon/common/chat-command-contracts';
import { normalizeScheduledPromptDefinitionInput } from '@garcon/common/scheduled-prompts';
import { GarconClient } from '../../../../cli/garcon-client.js';
import start from './fixtures/cli-runtime/cli.chats.start@1.json';
import schedule from './fixtures/cli-runtime/cli.schedules.create@1.json';

function clientFor(operation: string, path: string, request: unknown, result: unknown) {
  return new GarconClient({ baseUrl: 'http://127.0.0.1:1', instanceId: 'synthetic-controller',
    endpointInstanceId: 'synthetic-controller', defaultExecutorId: 'local', workspaceName: null,
    localCapability: 'synthetic-capability', protocol: { bootstrap: 1, contracts: CLI_CONTRACTS },
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(path);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get(CLI_CONTRACT_HEADER)).toBe(operation);
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json(result);
    },
  });
}

test('cli.chats.start@1 retains its accepted HTTP request and result', async () => {
  const request = parseStartChatCommandRequest(start.request);
  expect(request).toEqual(start.request);
  const client = clientFor('cli.chats.start@1', '/api/v1/chats/start', start.request, start.result);
  expect(await client.startChat(request)).toEqual(start.result);
});

test('cli.schedules.create@1 retains its accepted HTTP request and result', async () => {
  const scheduledPrompt = normalizeScheduledPromptDefinitionInput(schedule.request.scheduledPrompt);
  expect(scheduledPrompt).toEqual(schedule.request.scheduledPrompt);
  if (!scheduledPrompt) throw new Error('Invalid literal definition');
  const client = clientFor('cli.schedules.create@1', '/api/v1/scheduled-prompts', schedule.request, schedule.result);
  expect(await client.createScheduledPrompt({ expectedRevision: schedule.request.expectedRevision, scheduledPrompt })).toEqual(schedule.result);
});
