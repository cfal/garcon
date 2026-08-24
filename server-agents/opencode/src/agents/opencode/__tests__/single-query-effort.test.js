import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function createCapturingInstance(promptCalls) {
  return {
    client: {
      session: {
        create: async () => ({ data: { id: 'ses_test' } }),
        prompt: async (body) => {
          promptCalls.push(body);
          return { data: { info: { role: 'assistant' }, parts: [] } };
        },
        delete: async () => ({}),
      },
      permission: { reply: async () => ({}) },
      config: { providers: async () => ({}) },
    },
  };
}

describe('OpenCode one-shot effort', () => {
  it('maps explicit generic effort onto the prompt variant', async () => {
    const promptCalls = [];
    const createInstance = mock(() => Promise.resolve(createCapturingInstance(promptCalls)));
    const runtime = new OpenCodeRuntime({ createInstance });

    await runtime.runSingleQuery('hello', { thinkingMode: 'xhigh' });
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.variant).toBe('xhigh');
  });

  it('omits the variant for the default none mode', async () => {
    const promptCalls = [];
    const createInstance = mock(() => Promise.resolve(createCapturingInstance(promptCalls)));
    const runtime = new OpenCodeRuntime({ createInstance });

    await runtime.runSingleQuery('hello', {});
    expect(promptCalls).toHaveLength(1);
    expect('variant' in (promptCalls[0] ?? {})).toBe(false);
  });
});
