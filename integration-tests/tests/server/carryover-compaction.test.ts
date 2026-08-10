// Black-box coverage for agent-switch compaction. The unit tests drive the
// service directly; this exercises the whole path, including the one-shot query
// actually reaching a provider — the surface where the Claude argv limit hides,
// and which no unit test can see.
import { describe, expect, test } from 'bun:test';
import { CARRIED_CONTEXT_VERSION } from '../../../common/transcript-seed.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const ENVELOPE = `<carried-context version="${CARRIED_CONTEXT_VERSION}">`;

describe('agent switch compaction', () => {
  test('summarizes older history and keeps the recent turns verbatim', async () => {
    await withIntegrationFixture('compaction-summary', async (fixture) => {
      // The compaction model is a different provider from the handoff target, so
      // the one-shot query and the target's first turn are distinguishable.
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedHistory(fixture, source);
      await enableCompaction(fixture, source);

      const compactionCall = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      const compactionPrompt = (await compactionCall.received).lastUserText;
      // The compactor receives the older material and is told where the work is going.
      expect(compactionPrompt).toContain('turn-0');
      expect(compactionPrompt).toContain(target.agentId);
      // The newest turns are the verbatim spine and must not be summarized.
      expect(compactionPrompt).not.toContain('turn-4');
      expect(compactionCall.releaseText('<summary>objective: ship the fix</summary>')).toBeTrue();

      const injected = (await targetCall.received).lastUserText;
      // One envelope containing the summary, then the spine, then the prompt.
      expect(occurrences(injected, ENVELOPE)).toBe(1);
      expect(injected).toContain('<summary>objective: ship the fix</summary>');
      expect(injected).toContain('turn-4');
      expect(injected.endsWith('carry on')).toBeTrue();
      expect(targetCall.releaseText('echo:carry on')).toBeTrue();
      await handoff;
    });
  }, 90_000);

  test('falls back to the full projection when the compactor misbehaves', async () => {
    await withIntegrationFixture('compaction-fallback', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedHistory(fixture, source);
      await enableCompaction(fixture, source);

      const compactionCall = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      await compactionCall.received;
      // No <summary> element at all: the documented malformed-model response.
      expect(compactionCall.releaseText('here is a summary, roughly')).toBeTrue();

      const injected = (await targetCall.received).lastUserText;
      // The handoff still succeeds, carrying the deterministic ladder projection.
      expect(occurrences(injected, ENVELOPE)).toBe(1);
      expect(injected).not.toContain('<summary>');
      expect(injected).toContain('turn-0');
      expect(injected).toContain('turn-4');
      expect(targetCall.releaseText('echo:carry on')).toBeTrue();
      await handoff;
    });
  }, 90_000);

  test('does not query any model while the setting is off', async () => {
    await withIntegrationFixture('compaction-disabled', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const chatId = await seedHistory(fixture, source);
      // Deliberately no enableCompaction: an unset setting must not inherit the
      // auto-enable that generation config applies to chat titles.

      const targetCall = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoff = fixture.client.handoffDirectChat({
        chatId,
        content: 'carry on',
        agent: target,
      });

      const injected = (await targetCall.received).lastUserText;
      expect(injected).not.toContain('<summary>');
      expect(injected).toContain('turn-0');
      expect(targetCall.releaseText('echo:carry on')).toBeTrue();
      await handoff;
    });
  }, 90_000);
});

async function seedHistory(
  fixture: IntegrationFixture,
  agent: ConfiguredDirectTestAgent,
): Promise<string> {
  const client = fixture.client;
  const chatId = fixture.newChatId();
  const started = await client.startDirectChat({
    chatId,
    content: 'turn-0',
    projectPath: fixture.dirs.project,
    agent,
  });
  expect((await client.waitForTurnTerminal(chatId, started.turnId)).type)
    .toBe('agent-run-finished');
  // Five turns total, so the three-turn spine leaves older material to summarize.
  for (const index of [1, 2, 3, 4]) {
    const accepted = await client.runDirectChat({ chatId, content: `turn-${index}`, agent });
    if (!accepted.turnId) throw new Error(`Turn ${index} was accepted without an ID`);
    expect((await client.waitForTurnTerminal(chatId, accepted.turnId)).type)
      .toBe('agent-run-finished');
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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
