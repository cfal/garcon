import { describe, expect, it } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../../../common/chat-types.js';
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

function service({ enabled = true, respond, discovery = 'ok', selection } = {}) {
  const warnings = [];
  const empty = discovery === 'empty';
  const fail = () => {
    throw new Error('provider unavailable');
  };
  const instance = new CarryOverCompactionService({
    agents: {
      getAgentAuthStatusMap: async () => (discovery === 'throws'
        ? fail()
        : { claude: { authenticated: !empty } }),
      getAgentReadinessMap: async () => (discovery === 'throws'
        ? fail()
        : { claude: { ready: !empty } }),
      getAgentCatalogEntries: async () => (discovery === 'throws' ? fail() : (empty ? [] : [{
        id: 'claude',
        label: 'Claude',
        kind: 'agent',
        models: [{ id: 'haiku', label: 'Haiku' }],
      }])),
      runSingleQuery: async (prompt) => respond(prompt),
    },
    getUiSettings: () => ({
      agentSwitchCompaction: enabled === null
        ? { agentId: 'claude', model: 'haiku' }
        : { enabled, ...(selection ?? { agentId: 'claude', model: 'haiku' }) },
    }),
    warn: (chatId, message) => warnings.push({ chatId, message }),
  });
  return { instance, warnings };
}

function run(instance, messages = transcript(), signal) {
  return instance.carriedContextFor({
    chatId: 'chat-1',
    projectPath: '/workspace',
    messages,
    destination: DESTINATION,
    ...(signal ? { signal } : {}),
  });
}

// Three turns whose newest carries the bulk, so the pinned spine is genuinely
// large rather than being three short asks.
function spineOf(commands) {
  const messages = [];
  // Five turns, so the three-turn spine still leaves older material to summarize.
  for (const turn of [0, 1, 2, 3, 4]) {
    messages.push(new UserMessage(TIME, `request ${turn}`));
    messages.push(new AssistantMessage(TIME, `answer ${turn}`));
  }
  for (let index = 0; index < commands; index += 1) {
    messages.push(new BashToolUseMessage(TIME, `t${index}`, `command-${index} ${'x'.repeat(140)}`));
  }
  return messages;
}

function deterministic(messages = transcript()) {
  return createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS).prefix;
}

describe('carryover compaction', () => {
  it('falls back rather than clipping the pinned turns', async () => {
    // A spine that fits on its own beside a summary that only fits if part of it
    // is dropped. The verbatim guarantee wins and the operator is told why.
    const messages = spineOf(200);
    const { instance, warnings } = service({
      respond: async () => `<summary>${'x'.repeat(225_000)}</summary>`,
    });

    const context = await run(instance, messages);

    expect(context.prefix).toBe(deterministic(messages));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('too large to carry');
  });

  it('skips the query when the pinned turns already fill the budget', async () => {
    const messages = spineOf(2_000);
    const { instance, warnings } = service({
      respond: async () => {
        throw new Error('no model should be queried');
      },
    });

    const context = await run(instance, messages);

    expect(context.prefix).toBe(deterministic(messages));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('already fill');
  });

  it('warns when it is enabled but no model can be resolved', async () => {
    // Discovery turns provider failures into empty catalogs, so an operator who
    // opted in would otherwise silently pay the full carryover cost.
    const { instance, warnings } = service({
      discovery: 'empty',
      selection: {},
      respond: async () => {
        throw new Error('no model should be queried');
      },
    });

    const context = await run(instance);

    expect(context.prefix).toBe(deterministic());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].chatId).toBe('chat-1');
    expect(warnings[0].message).toContain('could not be resolved');
  });

  it('warns when discovery itself fails', async () => {
    const { instance, warnings } = service({
      discovery: 'throws',
      selection: {},
      respond: async () => {
        throw new Error('no model should be queried');
      },
    });

    const context = await run(instance);

    expect(context.prefix).toBe(deterministic());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('could not be resolved');
  });

  it('stays silent when the setting is off or the turn was abandoned', async () => {
    const off = service({
      enabled: false,
      respond: async () => {
        throw new Error('no model should be queried');
      },
    });
    expect((await run(off.instance)).prefix).toBe(deterministic());
    expect(off.warnings).toEqual([]);

    const aborted = service({
      discovery: 'empty',
      selection: {},
      respond: async () => {
        throw new Error('no model should be queried');
      },
    });
    expect((await run(aborted.instance, transcript(), AbortSignal.abort())).prefix)
      .toBe(deterministic());
    // Warning about a torn-down turn would notify a chat the user abandoned.
    expect(aborted.warnings).toEqual([]);
  });

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

  it('renders one envelope so the rewritten-prefix guard can still anchor', async () => {
    const { instance } = service({ respond: async () => '<summary>objective: ship it</summary>' });

    const context = await run(instance);

    // A bare <summary> beside a second <carried-context> root would escape
    // sanitizeRecordedCarriedContext's startsWith('<carried-context') check.
    expect(context.prefix).toStartWith('<carried-context version="3">');
    expect(context.prefix.match(/<carried-context/g)).toHaveLength(1);
    expect(context.prefix.indexOf('<summary>')).toBeGreaterThan(0);
    expect(context.prefix.endsWith('</carried-context>\n\n')).toBeTrue();
  });

  it('holds the injection ceiling when the summary lands exactly on it', async () => {
    const { instance, warnings } = service({
      respond: async () => `<summary>${'x'.repeat(CARRYOVER_INJECTION_MAX_CHARS - 200)}</summary>`,
    });

    const context = await run(instance);

    expect(context.prefix.length).toBeLessThanOrEqual(CARRYOVER_INJECTION_MAX_CHARS);
    if (warnings.length > 0) expect(warnings[0].message).toContain('too large to carry');
  });

  it('stays off until the setting is explicitly enabled', async () => {
    let called = false;
    const { instance } = service({
      enabled: null,
      respond: async () => { called = true; return '<summary>s</summary>'; },
    });

    await run(instance);

    // `resolveEffectiveGenerationConfig` auto-enables generation whenever some
    // agent resolves; compaction must not inherit that default.
    expect(called).toBeFalse();
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
    expect(warnings[0].message).toContain('too large to carry');
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
