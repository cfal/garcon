import { describe, expect, it } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
} from '../../../common/transcript-seed.js';
import { CarryOverCompactionService } from '../carryover-compaction.ts';

const TIME = '2026-01-01T00:00:00.000Z';
const DESTINATION = { agentId: 'claude', model: 'opus', prompt: 'keep going' };

function transcript() {
  const messages = [];
  for (let turn = 0; turn < 8; turn += 1) {
    messages.push(new UserMessage(TIME, `request ${turn}`));
    messages.push(new AssistantMessage(TIME, `answer ${turn}`));
  }
  return messages;
}

function service({ enabled = true, respond }) {
  const warnings = [];
  const instance = new CarryOverCompactionService({
    agents: {
      getAgentAuthStatusMap: async () => ({ claude: { authenticated: true } }),
      getAgentReadinessMap: async () => ({ claude: { ready: true } }),
      getAgentCatalogEntries: async () => ([{
        id: 'claude',
        label: 'Claude',
        kind: 'agent',
        models: [{ id: 'haiku', label: 'Haiku' }],
      }]),
      runSingleQuery: async (prompt) => respond(prompt),
    },
    getUiSettings: () => ({
      agentSwitchCompaction: { enabled, agentId: 'claude', model: 'haiku' },
    }),
    warn: (chatId, message) => warnings.push({ chatId, message }),
  });
  return { instance, warnings };
}

function run(instance, messages = transcript()) {
  return instance.carriedContextFor({
    chatId: 'chat-1',
    projectPath: '/workspace',
    messages,
    destination: DESTINATION,
  });
}

describe('carryover compaction', () => {
  it('keeps the newest turns verbatim beside the summary', async () => {
    const { instance, warnings } = service({
      respond: async () => '<summary>objective: ship it</summary>',
    });

    const context = await run(instance);

    expect(context.prefix).toContain('<summary>objective: ship it</summary>');
    // The spine is the last three turns, rendered rather than summarized.
    expect(context.prefix).toContain('<user>request 7</user>');
    expect(context.prefix).toContain('<user>request 5</user>');
    expect(context.prefix).not.toContain('<user>request 4</user>');
    expect(warnings).toEqual([]);
  });

  it('never sends the pinned turns to the model', async () => {
    let seen = '';
    const { instance } = service({ respond: async (prompt) => { seen = prompt; return '<summary>s</summary>'; } });

    await run(instance);

    expect(seen).toContain('<user>request 0</user>');
    expect(seen).not.toContain('<user>request 7</user>');
  });

  it('falls back to the deterministic projection when output overflows', async () => {
    const { instance, warnings } = service({
      respond: async () => `<summary>${'x'.repeat(CARRYOVER_INJECTION_MAX_CHARS)}</summary>`,
    });
    const messages = transcript();

    const context = await run(instance, messages);

    expect(context.prefix)
      .toBe(createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS).prefix);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('over the');
  });

  it('falls back and warns when the model returns no summary element', async () => {
    const { instance, warnings } = service({ respond: async () => 'here is a summary, roughly' });

    const context = await run(instance);

    expect(context.prefix).not.toContain('<summary>');
    expect(warnings[0].message).toContain('no <summary> element');
  });

  it('falls back and warns when the model throws', async () => {
    const { instance, warnings } = service({
      respond: async () => { throw new Error('model unavailable'); },
    });
    const messages = transcript();

    const context = await run(instance, messages);

    expect(context.prefix)
      .toBe(createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS).prefix);
    expect(warnings[0].message).toContain('model unavailable');
  });

  it('does not call the model when the setting is off', async () => {
    let called = false;
    const { instance, warnings } = service({
      enabled: false,
      respond: async () => { called = true; return '<summary>s</summary>'; },
    });
    const messages = transcript();

    const context = await run(instance, messages);

    expect(called).toBeFalse();
    expect(warnings).toEqual([]);
    expect(context.prefix)
      .toBe(createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS).prefix);
  });
});
