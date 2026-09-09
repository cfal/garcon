import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { parseGarconCommandResult } from '../../../common/garcon-command-results.js';
import { escapeGarconXmlText } from '../../../common/garcon-command-envelope.js';
import type { StartChatCommandRequest } from '../../../common/chat-command-contracts.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { codexAssistantMessage, codexExecCommandCall } from '../../support/fake-codex-model.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedPiTestEnvironment, scriptedPiStartRequest } from '../../support/scripted-pi.js';
import { startScriptedOpenCodeTestEnvironment, scriptedOpenCodeStartRequest } from '../../support/scripted-opencode.js';

interface FinalResponseEnvironment {
  options: IntegrationFixtureOptions;
  start(input: { chatId: string; projectPath: string; command: string }): StartChatCommandRequest;
  script(commentary: string, final: string): void;
  settled(): void;
  dispose(): void | Promise<void>;
}

async function environmentFor(agent: string): Promise<FinalResponseEnvironment> {
  if (agent === 'codex') {
    const environment = await startScriptedCodexTestEnvironment();
    return { options: environment, start: liveCodexStartRequest,
      script(commentary, final) {
        environment.model.scriptTurn([{ ...codexAssistantMessage(commentary), phase: 'commentary' },
          codexExecCommandCall('synthetic_tool', 'printf synthetic')]);
        environment.model.scriptTurn([{ ...codexAssistantMessage(final), phase: 'final_answer' }]);
      }, settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  if (agent === 'claude') {
    const environment = await startScriptedClaudeTestEnvironment();
    return { options: environment, start: liveClaudeStartRequest,
      script(commentary, final) {
        environment.model.scriptTurn([claudeText(commentary), claudeToolUse('synthetic_tool', 'Bash', { command: 'printf synthetic' })]);
        environment.model.scriptTurn([claudeText(final)]);
      }, settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  const environment = agent === 'pi' ? startScriptedPiTestEnvironment() : startScriptedOpenCodeTestEnvironment();
  return { options: environment, start: agent === 'pi' ? scriptedPiStartRequest : scriptedOpenCodeStartRequest,
    script(commentary, final) {
      environment.model.scriptTurn([chatCompletionsText(commentary), chatCompletionsToolUse('synthetic_tool', 'bash', { command: 'printf synthetic' })]);
      environment.model.scriptTurn([chatCompletionsText(final)]);
    }, settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
}

for (const agent of ['claude', 'codex', 'pi', 'opencode']) {
  (agent !== 'opencode' || process.platform === 'linux' ? test : test.skip)(`${agent} start and resume receipts contain only final text, including CLI wait`, async () => {
    const environment = await environmentFor(agent);
    try {
      await withIntegrationFixture(`${agent}-final-response`, async (fixture) => {
        const chatId = fixture.newChatId();
        for (const mode of ['start', 'resume']) {
          const commentary = `Synthetic ${mode} progress.`;
          const final = `Synthetic ${mode} final part A.\n\nFinal part B.`;
          environment.script(commentary, final);
          const cursor = fixture.client.markEvents();
          const request = environment.start({ chatId, projectPath: fixture.dirs.project, command: `Synthetic ${mode} task.` });
          const accepted = mode === 'start' ? await fixture.client.startChat(request)
            : await fixture.client.runChat({ chatId, command: request.command, images: [],
              clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
          if (!accepted.turnId) throw new Error('Missing accepted turn');
          await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: cursor, timeoutMs: 60_000 });
          const receipt = parseAgentTurnReceipt(await fixture.client.get(
            `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${accepted.turnId}`,
          ));
          expect(receipt).toMatchObject({ state: 'completed', output: { availability: 'available', completeness: 'complete', text: final } });
          expect(receipt).not.toHaveProperty('output.assistantMessages');
          const transcript = assistantContents((await fixture.client.getMessages(chatId)).messages);
          expect(transcript).toContain(commentary);
          expect(transcript).toContain(final);
          for (const json of [false, true]) {
            const child = Bun.spawn(['bun', 'cli/main.ts', '--config-dir', fixture.dirs.config,
              '--workspace', 'final-response',
              'wait', chatId, '--turn', accepted.turnId, ...(json ? ['--json'] : [])], {
              cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
              env: { ...process.env, GARCON_CONFIG_DIR: '', GARCON_WORKSPACE: '' },
            });
            const [exitCode, stdout, stderr] = await Promise.all([child.exited,
              new Response(child.stdout).text(), new Response(child.stderr).text()]);
            expect(stderr).toBe('');
            expect(exitCode).toBe(0);
            if (json) expect(JSON.parse(stdout)).toEqual(receipt);
            else expect(stdout).toBe(`chat id: ${chatId}\nturn id: ${accepted.turnId}\n${final}\n`);
          }
        }
        environment.settled();
      }, { ...environment.options, namedWorkspace: 'final-response' });
    } finally { await environment.dispose(); }
  }, 120_000);

  (agent !== 'opencode' || process.platform === 'linux' ? test : test.skip)(`${agent} markup start and resume return finals without commentary`, async () => {
    const environment = await environmentFor(agent);
    try {
      await withIntegrationFixture(`${agent}-markup-final-response`, async (fixture) => {
        const parent = fixture.newChatId();
        const parentAgent = fixture.directAgents.openAiResponses;
        const parentModel = fixture.fakeProviders.openAiResponses;
        let emission = parentModel.holdNext({ lastUserText: 'Synthetic delegation request.' });
        const started = environment.start({ chatId: fixture.newChatId(), projectPath: fixture.dirs.project, command: 'Synthetic child task.' });
        await fixture.client.startChat({
          ...fixture.client.directStartRequest({ chatId: parent, projectPath: fixture.dirs.project,
            agent: parentAgent, content: 'Synthetic delegation request.' }),
          permissionMode: 'bypassPermissions',
        });
        await emission.received;
        let child = '';
        for (const mode of ['start', 'resume']) {
          const final = `Synthetic ${mode} final A.\n\nSynthetic final B.`;
          const commentary = `Synthetic ${mode} progress excluded from the result.`;
          environment.script(commentary, final);
          const ack = parentModel.holdNext({ lastUserTextIncludes: 'status="accepted"' });
          const result = parentModel.holdNext({ lastUserTextIncludes: 'status="completed"' });
          emission.releaseText(mode === 'start'
            ? `<garcon-start-agent ref="final-start" agent="${agent}" model="${escapeGarconXmlText(started.model)}" reasoning-effort="${started.thinkingMode}">Synthetic child task.</garcon-start-agent>`
            : `<garcon-resume-agent ref="final-resume" chat-id="${child}">Synthetic child follow-up.</garcon-resume-agent>`);
          const admission = parseGarconCommandResult((await ack.received).lastUserText);
          if (admission?.status !== 'accepted' || !('chatId' in admission)) throw new Error('Missing child admission');
          child = admission.chatId;
          ack.releaseText('Synthetic acknowledgment observed.');
          const terminal = parseGarconCommandResult((await result.received).lastUserText);
          expect(terminal).toMatchObject({ status: 'completed', chatId: child,
            output: { availability: 'available', completeness: 'complete', text: final } });
          const transcript = assistantContents((await fixture.client.getMessages(child)).messages);
          expect(transcript).toContain(commentary);
          expect(transcript).toContain(final);
          emission = result;
        }
        const cursor = fixture.client.markEvents();
        emission.releaseText('Synthetic final results observed.');
        await fixture.client.waitForProcessing(parent, false, { afterIndex: cursor });
        environment.settled();
      }, environment.options);
    } finally { await environment.dispose(); }
  }, 120_000);
}
