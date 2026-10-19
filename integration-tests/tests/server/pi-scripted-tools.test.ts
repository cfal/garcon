import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messagesOfType } from '../../support/chat-assertions.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains, waitForVisibleResponse } from '../../support/live-agent.js';
import { piNativeSession, scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';

test('keeps malformed Pi built-in calls canonical without executing their valid argument prefix', async () => {
  const environment = startScriptedPiTestEnvironment({ extensionSource: `
export default function (pi) {
  pi.on('session_start', () => pi.setActiveTools(['bash', 'read', 'write', 'edit', 'codemode']));
}
` });
  const malformed = [
    ['bash', '{"command":"touch rejected-bash.txt","invalid":.5}'],
    ['read', '{"path":"rejected-write.txt","invalid":.5}'],
    ['write', '{"path":"rejected-write.txt","content":"not written","invalid":.5}'],
    ['edit', '{"path":"rejected-edit.txt","edits":[{"oldText":"unchanged sentinel","newText":"not edited"}],"invalid":.5}'],
    ['codemode', '{"code":"text(await tools.bash({command:\\"touch rejected-codemode.txt\\"}))","invalid":.5}'],
  ] as const;
  try {
    environment.model.scriptTurn(malformed.map(([name, rawArguments]) =>
      chatCompletionsToolUse(`invalid-${name}`, name, {}, { rawArguments })));
    environment.model.scriptTurn((request) => {
      for (const [name, rawArguments] of malformed) {
        const result = request.toolResults.find((item) => item.toolCallId === `invalid-${name}`);
        expect(result?.content).toContain('Received arguments:');
        expect(result?.content).toContain(rawArguments);
      }
      return [chatCompletionsText('invalid tools rejected')];
    });
    await withIntegrationFixture('pi-scripted-invalid-tools', async (fixture) => {
      await writeFile(join(fixture.dirs.project, 'rejected-write.txt'), 'unchanged sentinel');
      await writeFile(join(fixture.dirs.project, 'rejected-edit.txt'), 'unchanged sentinel');
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'try invalid tools',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: 'invalid tools rejected', afterIndex: cursor });
      const { messages } = await fixture.client.getMessages(chatId);
      expect(messagesOfType(messages, 'bash-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'invalid-bash', command: '' }),
      ]);
      expect(messagesOfType(messages, 'read-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'invalid-read', filePath: '' }),
      ]);
      expect(messagesOfType(messages, 'write-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'invalid-write', filePath: '' }),
      ]);
      expect(messagesOfType(messages, 'edit-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'invalid-edit', filePath: '' }),
      ]);
      expect(messagesOfType(messages, 'exec-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'invalid-codemode', code: '', language: 'javascript' }),
      ]);
      const results = messagesOfType(messages, 'tool-result');
      for (const [name] of malformed) {
        expect(results.filter((result) => result.toolId === `invalid-${name}`)).toEqual([
          expect.objectContaining({ isError: true }),
        ]);
      }
      expect(messagesOfType(messages, 'unknown-tool-use')).toEqual([]);
      expect(await Bun.file(join(fixture.dirs.project, 'rejected-bash.txt')).exists()).toBe(false);
      expect(await Bun.file(join(fixture.dirs.project, 'rejected-codemode.txt')).exists()).toBe(false);
      expect(await Bun.file(join(fixture.dirs.project, 'rejected-write.txt')).text()).toBe('unchanged sentinel');
      expect(await Bun.file(join(fixture.dirs.project, 'rejected-edit.txt')).text()).toBe('unchanged sentinel');
      await reloadUntilNativeContains(fixture, chatId, 'invalid tools rejected');
      const reloaded = (await fixture.client.getMessages(chatId)).messages;
      for (const type of ['bash-tool-use', 'read-tool-use', 'write-tool-use', 'edit-tool-use', 'exec-tool-use', 'tool-result', 'unknown-tool-use'] as const) {
        expect(messagesOfType(reloaded, type)).toEqual(messagesOfType(messages, type));
      }
      const native = await piNativeSession(fixture, chatId);
      const entries = (await Bun.file(native.path).text()).trim().split('\n').map((line) => JSON.parse(line));
      const calls = entries.flatMap((entry) => entry.message?.role === 'assistant' ? entry.message.content : [])
        .filter((part) => part.type === 'toolCall');
      for (const [name, rawArguments] of malformed) {
        const call = calls.find((part) => part.id === `invalid-${name}`);
        expect(call?.arguments).toEqual({});
        expect(call?.argumentsError).toContain(rawArguments);
      }
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);

test('runs Pi codemode worker assets and renders tool discovery with canonical messages', async () => {
  const environment = startScriptedPiTestEnvironment({ extensionSource: `
export default function (pi) {
  pi.on('session_start', () => pi.setActiveTools(['bash', 'codemode', 'tool_search']));
}
` });
  const code = "console.log('console-before'); text(await tools.bash({ command: 'printf codemode-output' })); text('second-output'); console.log('console-after');";
  try {
    environment.model.scriptTurn([chatCompletionsToolUse('discover', 'tool_search', { query: 'read files', limit: 2 })]);
    environment.model.scriptTurn([chatCompletionsToolUse('execute', 'codemode', { code })]);
    environment.model.scriptTurn([chatCompletionsText('tools finished')]);
    await withIntegrationFixture('pi-scripted-tools', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'run tools',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: 'tools finished', afterIndex: cursor });
      const { messages } = await fixture.client.getMessages(chatId);
      expect(messagesOfType(messages, 'pi-tool-search-tool-use')).toEqual([
        expect.objectContaining({ query: 'read files', limit: 2 }),
      ]);
      const execution = messagesOfType(messages, 'exec-tool-use').find((message) => message.code === code);
      expect(execution?.language).toBe('javascript');
      const result = messagesOfType(messages, 'tool-result').find((message) => message.toolId === execution?.toolId);
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain('codemode-output');
      const output = JSON.stringify(result?.content);
      const firstText = output.indexOf('==> text 1/2 <==');
      const secondText = output.indexOf('==> text 2/2 <==');
      const consoleOutput = output.indexOf('<console_output>');
      expect(firstText).toBeGreaterThanOrEqual(0);
      expect(secondText).toBeGreaterThan(firstText);
      expect(output.indexOf('second-output')).toBeGreaterThan(secondText);
      expect(consoleOutput).toBeGreaterThan(secondText);
      expect(output.indexOf('console-before')).toBeGreaterThan(consoleOutput);
      expect(output.indexOf('console-after')).toBeGreaterThan(output.indexOf('console-before'));
      expect(output).toContain('</console_output>');
      expect(messagesOfType(messages, 'unknown-tool-use')).toEqual([]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);

test('keeps explicit read-only tool declarations restricted when Pi retains MCP registrations', async () => {
  const environment = startScriptedPiTestEnvironment({ extensionSource: `
export default function (pi) {
  pi.registerTool({
    name: 'mcp__synthetic__mutate', label: 'Mutate', description: 'Synthetic mutating MCP tool',
    parameters: { type: 'object', properties: {} },
    async execute() { throw new Error('Restricted mode must not execute MCP tools'); },
  });
  pi.on('session_start', () => pi.setActiveTools([
    'read', 'grep', 'find', 'ls', 'codemode', 'tool_search', 'mcp__synthetic__mutate',
  ]));
}
` });
  try {
    environment.model.scriptTurn((request) => {
      const tools = request.body.tools as Array<{ function: { name: string } }>;
      expect(tools.map((tool) => tool.function.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
      return [chatCompletionsText('inspection finished')];
    });
    await withIntegrationFixture('pi-scripted-restricted-tools', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'inspect only',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: 'inspection finished', afterIndex: cursor });
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      async prepareWorkspace(directories) {
        await environment.prepareWorkspace(directories);
        // Pi does not advertise plan mode in Garcon; the real CLI is restricted explicitly.
        const binary = environment.serverEnvironment.GARCON_PI_BINARY!.replaceAll("'", "'\\''");
        const wrapper = join(directories.home, '.garcon-test-bin', 'pi-read-only');
        await writeFile(wrapper, `#!/bin/sh\nexec '${binary}' --tools read,grep,find,ls "$@"\n`, { mode: 0o700 });
        environment.serverEnvironment.GARCON_PI_BINARY = wrapper;
      },
    });
  } finally {
    environment.dispose();
  }
}, 120_000);
