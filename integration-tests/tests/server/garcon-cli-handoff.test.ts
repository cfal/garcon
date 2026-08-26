import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseChatHandoffArtifactResponse,
  type ChatHandoffArtifactResponse,
} from '../../../common/chat-handoff-artifact-contracts.js';
import {
  parseTranscriptExportResponse,
  type TranscriptExportResponse,
} from '../../../common/chat-export-contracts.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-handoff';
const CONTEXT_WINDOW_TOKENS = 131_072;
const USABLE_TOKEN_BUDGET = 98_304;
const HANDOFF_SUMMARY = 'Synthetic objective and verification state.';
const ORDINARY_NOTICE_MARKER = 'synthetic-ordinary-notice-excluded';

describe('garcon-cli handoff', () => {
  test('publishes a pinned ordinal artifact without mutating a running chat', async () => {
    await withIntegrationFixture('garcon-cli-handoff', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedLargeHistory(fixture, source, 25);
      await enableCompaction(fixture, source);

      const compactionCall = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'synthetic artifact handoff',
        agent: target,
      });
      await compactionCall.received;
      expect(compactionCall.releaseText(`<summary>${HANDOFF_SUMMARY}</summary>`)).toBeTrue();
      await targetCall.received;
      expect(targetCall.releaseText('synthetic target answer')).toBeTrue();
      const acceptedHandoff = await handoff;
      await fixture.client.waitForTurnTerminal(chatId, acceptedHandoff.turnId);

      const notice = await runCli(fixture, [
        'add-row', chatId,
        '--type', 'notice',
        '--title', 'Synthetic ordinary notice',
        ORDINARY_NOTICE_MARKER,
      ]);
      expect(notice).toMatchObject({ exitCode: 0, stderr: '' });

      const held = fixture.fakeProviders.anthropic.holdNext({
        lastUserText: 'synthetic held artifact turn',
      });
      const eventCursor = fixture.client.markEvents();
      const heldTurn = await fixture.client.runDirectChat({
        chatId,
        content: 'synthetic held artifact turn',
        agent: target,
      });
      await held.received;
      await fixture.client.waitForProcessing(chatId, true, { afterIndex: eventCursor });

      const beforeChats = await fixture.client.listChats();
      const beforeControl = await fixture.client.getExecutionControl(chatId);
      const beforeMessages = await fixture.client.getMessages(chatId, { limit: 200 });
      const beforeExport = await completeXmlExport(fixture, chatId);
      const beforeOpenAiRequests = fixture.fakeProviders.openAi.requests().length;
      const beforeAnthropicRequests = fixture.fakeProviders.anthropic.requests().length;
      const outputPath = path.join(fixture.dirs.home, 'handoff-artifact.xml');

      const cli = await runCli(fixture, [
        'handoff', chatId,
        '--context-window-size', String(CONTEXT_WINDOW_TOKENS),
        '--output', outputPath,
      ]);

      expect(cli).toMatchObject({ exitCode: 0, stderr: '' });
      expect(cli.stdout).toContain('operation: read-only handoff artifact');
      expect(cli.stdout).toContain(`chat id: ${chatId}`);
      expect(cli.stdout).toContain(`transcript view id: ${beforeExport.transcriptViewId}`);
      expect(cli.stdout).toContain(`last ordinal: ${beforeExport.lastOrdinal}`);
      expect(cli.stdout).toContain(`context window: ${CONTEXT_WINDOW_TOKENS} tokens`);
      expect(cli.stdout).toContain(
        `usable artifact budget: ${USABLE_TOKEN_BUDGET} tokens (75%; usage estimated)`,
      );
      expect(cli.stdout).toContain('fold: handoff-v1');
      expect(cli.stdout).toContain('budget-omitted eligible entries:');
      expect(cli.stdout).toContain('gaps:');
      expect(cli.stdout).toContain('(eligible entries only)');
      expect(cli.stdout).toContain('projection truncated: yes');

      const document = await readFile(outputPath, 'utf8');
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(cli.stdout).toContain(
        `sha256: ${createHash('sha256').update(document).digest('hex')}`,
      );
      expect(document).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n');
      expect(rootNumber(document, 'context-window-tokens')).toBe(CONTEXT_WINDOW_TOKENS);
      expect(rootNumber(document, 'usable-token-budget')).toBe(USABLE_TOKEN_BUDGET);
      expect(rootNumber(document, 'estimated-tokens')).toBeLessThanOrEqual(USABLE_TOKEN_BUDGET);
      expect(rootAttribute(document, 'transcript-view-id')).toBe(beforeExport.transcriptViewId);
      expect(rootNumber(document, 'last-ordinal')).toBe(beforeExport.lastOrdinal);
      expect(rootAttribute(document, 'fold')).toBe('handoff-v1');
      expect(rootAttribute(document, 'gap-unit')).toBe('eligible-entry');
      expect(rootNumber(document, 'source-entries')).toBe(beforeExport.totalEntryCount);
      expect(rootAttribute(document, 'projection-truncated')).toBe('true');
      expect(rootNumber(document, 'budget-omitted-entries')).toBeGreaterThan(0);
      expect(rootNumber(document, 'gaps')).toBeGreaterThan(0);
      expect(document).toContain('<gap ');
      expect(document).toContain('<fixed-fold-excluded ');
      expect(document).toMatch(/<fixed-fold-excluded [^>]*diagnostics="[1-9]\d*"/);
      expect(document).toContain('<handoff ordinal=');
      expect(document).toContain('type="handoff-summary"');
      expect(document).not.toContain(ORDINARY_NOTICE_MARKER);
      expect(document).not.toContain('providerMeta');
      expect(document).not.toContain('provider-meta');
      expect(document).not.toContain('<session');
      expect(document).not.toContain('<tool-result');
      expect(document).not.toContain('data:image/');

      const fullExportOrdinals = ordinalsIn(beforeExport.document);
      const artifactOrdinals = artifactSourceOrdinals(document);
      expect(artifactOrdinals.length).toBe(rootNumber(document, 'included-entries'));
      expect(artifactOrdinals.length).toBeGreaterThan(0);
      for (const ordinal of artifactOrdinals) {
        expect(fullExportOrdinals.has(ordinal)).toBe(true);
      }

      expect(await fixture.client.listChats()).toEqual(beforeChats);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(beforeControl);
      expect(await fixture.client.getMessages(chatId, { limit: 200 })).toEqual(beforeMessages);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(beforeOpenAiRequests);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(beforeAnthropicRequests);
      expect(beforeChats.sessions.find((chat) => chat.id === chatId)?.isProcessing).toBe(true);

      expect(held.releaseText('synthetic held artifact answer')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, heldTurn.turnId);
      const afterArtifact = await handoffArtifact(fixture, chatId);
      expect(afterArtifact.transcriptViewId).toBe(beforeExport.transcriptViewId);
      expect(afterArtifact.lastOrdinal).toBeGreaterThan(beforeExport.lastOrdinal);
      expect(afterArtifact.document).toContain('synthetic held artifact turn');
      expect(afterArtifact.document).toContain('synthetic held artifact answer');
    }, { namedWorkspace: WORKSPACE });
  }, 120_000);

  test('reports missing chats and rejects invalid context sizes through the real CLI', async () => {
    await withIntegrationFixture('garcon-cli-handoff-errors', async (fixture) => {
      const missing = await runCli(fixture, ['handoff', fixture.newChatId()]);
      expect(missing.exitCode).toBe(2);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('handoff artifact: Session not found');
      expect(missing.stderr).toContain('SESSION_NOT_FOUND');

      const invalid = await runCli(fixture, [
        'handoff', fixture.newChatId(), '--context-window-size', '1000',
      ]);
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain(
        'arguments: --context-window-size must be between 1024 and 10000000 tokens',
      );
    }, { namedWorkspace: WORKSPACE });
  }, 30_000);
});

async function seedLargeHistory(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
  count: number,
): Promise<string> {
  const turns = Array.from({ length: count }, (_, index) => (
    `synthetic-artifact-turn-${index}-${'界'.repeat(8_000)}`
  ));
  const [first, ...rest] = turns;
  if (!first) throw new Error('At least one turn is required.');
  const chatId = fixture.newChatId();
  const started = await fixture.client.startDirectChat({
    chatId,
    content: first,
    projectPath: fixture.dirs.project,
    agent,
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  for (const content of rest) {
    const accepted = await fixture.client.runDirectChat({ chatId, content, agent });
    await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
  }
  return chatId;
}

function enableCompaction(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
): Promise<unknown> {
  return fixture.client.updateSettings({
    ui: {
      agentSwitchCompaction: {
        enabled: true,
        contextWindowTokens: 200_000,
        agentId: agent.agentId,
        model: agent.provider.model,
        apiProviderId: agent.provider.providerId,
        modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol,
        thinkingMode: 'none',
      },
    },
  });
}

async function completeXmlExport(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<TranscriptExportResponse> {
  return parseTranscriptExportResponse(await fixture.client.get<unknown>(
    `/api/v1/chats/export?chatId=${chatId}&format=xml`,
  ));
}

async function handoffArtifact(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<ChatHandoffArtifactResponse> {
  return parseChatHandoffArtifactResponse(await fixture.client.get<unknown>(
    `/api/v1/chats/handoff-artifact?chatId=${chatId}&contextWindowTokens=${CONTEXT_WINDOW_TOKENS}`,
  ));
}

function rootAttribute(document: string, name: string): string {
  const root = document.match(/<handoff-artifact [^>]+>/)?.[0];
  const value = root?.match(new RegExp(` ${name}="([^"]+)"`))?.[1];
  if (value === undefined) throw new Error(`Missing root attribute ${name}.`);
  return value;
}

function rootNumber(document: string, name: string): number {
  return Number(rootAttribute(document, name));
}

function artifactSourceOrdinals(document: string): number[] {
  return [...document.matchAll(
    /<(?:user|assistant|compaction|tool-call|handoff|notice) ordinal="(\d+)"/g,
  )].map((match) => Number(match[1]));
}

function ordinalsIn(document: string): Set<number> {
  return new Set([...document.matchAll(/ ordinal="(\d+)"/g)].map((match) => Number(match[1])));
}

async function runCli(
  fixture: IntegrationFixture,
  arguments_: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      ...arguments_,
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
