import { describe, expect, it, mock } from 'bun:test';

import {
  assignmentsForCursorModel,
  configureCursorAcpSessionOptions,
  cursorConfigSelectionForModel,
} from '../cursor-acp-model-config.js';

function option(id, currentValue, values) {
  return {
    id,
    currentValue,
    options: values.map((value) => ({ value })),
  };
}

function configOptions(state, overrides = {}) {
  const effective = { ...state, ...overrides };
  return [
    option('mode', effective.mode, ['agent', 'plan', 'ask']),
    option('model', effective.model, ['default', 'composer-2.5', 'gpt-5.5', 'claude-opus-4-8']),
    option('context', effective.context, ['272k', '1m']),
    option('reasoning', effective.reasoning, ['none', 'low', 'medium', 'high', 'extra-high']),
    option('effort', effective.effort, ['low', 'medium', 'high', 'xhigh', 'max']),
    option('thinking', effective.thinking, ['false', 'true']),
    option('fast', effective.fast, ['false', 'true']),
  ];
}

function configOptionsWithoutExtraHighReasoning(state) {
  return configOptions(state).map((entry) =>
    entry.id === 'reasoning'
      ? option('reasoning', state.reasoning, ['none', 'low', 'medium', 'high'])
      : entry);
}

function defaultState() {
  return {
    mode: 'agent',
    model: 'default',
    context: '272k',
    reasoning: 'medium',
    effort: 'medium',
    thinking: 'false',
    fast: 'false',
  };
}

function clientForState(state, overrideCurrentValue = null) {
  return {
    setSessionConfigOption: mock(async ({ configId, value }) => {
      state[configId] = value;
      const overrides = overrideCurrentValue?.configId === configId
        ? { [configId]: overrideCurrentValue.currentValue }
        : {};
      return { configOptions: configOptions(state, overrides) };
    }),
  };
}

describe('Cursor ACP model config', () => {
  it('maps GPT-5.5 Extra High to explicit Cursor ACP options', () => {
    expect(assignmentsForCursorModel('gpt-5.5-extra-high')).toEqual([
      { configId: 'model', value: 'gpt-5.5' },
      { configId: 'context', value: '1m' },
      { configId: 'reasoning', value: 'extra-high' },
      { configId: 'fast', value: 'false' },
    ]);
  });

  it('maps GPT-5.5 Extra High Fast to fast mode', () => {
    expect(cursorConfigSelectionForModel('gpt-5.5-extra-high-fast')).toEqual({
      model: 'gpt-5.5',
      context: '1m',
      reasoning: 'extra-high',
      fast: 'true',
    });
  });

  it('resets known GPT base models to their default Cursor parameters', () => {
    expect(assignmentsForCursorModel('gpt-5.5')).toEqual([
      { configId: 'model', value: 'gpt-5.5' },
      { configId: 'context', value: '272k' },
      { configId: 'reasoning', value: 'medium' },
      { configId: 'fast', value: 'false' },
    ]);
  });

  it('maps auto and default to Cursor default', () => {
    expect(assignmentsForCursorModel('auto', 'agent')).toEqual([
      { configId: 'mode', value: 'agent' },
      { configId: 'model', value: 'default' },
    ]);
    expect(assignmentsForCursorModel('default')).toEqual([
      { configId: 'model', value: 'default' },
    ]);
  });

  it('maps Cursor Claude variants to model config options', () => {
    expect(assignmentsForCursorModel('claude-opus-4-8-thinking-xhigh-fast')).toEqual([
      { configId: 'model', value: 'claude-opus-4-8' },
      { configId: 'context', value: '1m' },
      { configId: 'effort', value: 'xhigh' },
      { configId: 'thinking', value: 'true' },
      { configId: 'fast', value: 'true' },
    ]);
  });

  it('resets fast mode for explicit variants only when Cursor exposes that toggle', () => {
    expect(assignmentsForCursorModel('claude-opus-4-8-thinking-xhigh')).toEqual([
      { configId: 'model', value: 'claude-opus-4-8' },
      { configId: 'context', value: '1m' },
      { configId: 'effort', value: 'xhigh' },
      { configId: 'thinking', value: 'true' },
      { configId: 'fast', value: 'false' },
    ]);

    expect(assignmentsForCursorModel('gpt-5.4-mini-medium')).toEqual([
      { configId: 'model', value: 'gpt-5.4-mini' },
      { configId: 'reasoning', value: 'medium' },
    ]);
  });

  it('fails unsupported parameterized forms explicitly', () => {
    expect(() => assignmentsForCursorModel('gpt-5.5-ultra')).toThrow(/not supported/);
  });

  it('applies and validates Cursor config options', async () => {
    const state = defaultState();
    const client = clientForState(state);

    await expect(configureCursorAcpSessionOptions({
      client,
      sessionId: 'cursor-session',
      model: 'gpt-5.5-extra-high',
      mode: 'agent',
      configOptions: configOptions(state),
    })).resolves.toEqual(configOptions({
      ...state,
      model: 'gpt-5.5',
      context: '1m',
      reasoning: 'extra-high',
      fast: 'false',
    }));

    expect(client.setSessionConfigOption.mock.calls.map((call) => call[0])).toEqual([
      { sessionId: 'cursor-session', configId: 'mode', value: 'agent' },
      { sessionId: 'cursor-session', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 'cursor-session', configId: 'context', value: '1m' },
      { sessionId: 'cursor-session', configId: 'reasoning', value: 'extra-high' },
      { sessionId: 'cursor-session', configId: 'fast', value: 'false' },
    ]);
  });

  it('fails when Cursor does not expose the requested reasoning value', async () => {
    const state = defaultState();
    const missingReasoningOptions = [
      option('mode', 'agent', ['agent']),
      option('model', 'gpt-5.5', ['gpt-5.5']),
      option('context', '272k', ['272k', '1m']),
      option('reasoning', 'medium', ['none', 'low', 'medium', 'high']),
      option('fast', 'false', ['false', 'true']),
    ];
    const client = {
      setSessionConfigOption: mock(async ({ configId, value }) => {
        state[configId] = value;
        return { configOptions: configOptionsWithoutExtraHighReasoning(state) };
      }),
    };

    await expect(configureCursorAcpSessionOptions({
      client,
      sessionId: 'cursor-session',
      model: 'gpt-5.5-extra-high',
      mode: 'agent',
      configOptions: missingReasoningOptions,
    })).rejects.toThrow(/requires reasoning=extra-high/);
  });

  it('fails when Cursor reports a different current value after setting', async () => {
    const state = defaultState();
    const client = clientForState(state, { configId: 'reasoning', currentValue: 'medium' });

    await expect(configureCursorAcpSessionOptions({
      client,
      sessionId: 'cursor-session',
      model: 'gpt-5.5-extra-high',
      mode: 'agent',
      configOptions: configOptions(state),
    })).rejects.toThrow(/Expected reasoning=extra-high, got medium/);
  });
});
