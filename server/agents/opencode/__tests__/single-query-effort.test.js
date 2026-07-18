import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

describe('OpenCode one-shot effort', () => {
  it('rejects explicit generic effort before creating an SDK instance', async () => {
    const createInstance = mock(() => {
      throw new Error('SDK instance should not be created');
    });
    const runtime = new OpenCodeRuntime({ createInstance });

    await expect(runtime.runSingleQuery('hello', { thinkingMode: 'xhigh' })).rejects.toThrow(
      'opencode does not support explicit one-shot effort xhigh',
    );
    expect(createInstance).not.toHaveBeenCalled();
  });
});
