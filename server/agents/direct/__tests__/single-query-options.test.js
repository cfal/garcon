import { describe, expect, it } from 'bun:test';
import {
  directSingleQueryEffort,
  directSingleQuerySignal,
  directSingleQueryTimeoutMs,
} from '../single-query-options.ts';

describe('Direct single-query options', () => {
  it('keeps the 30-second default and bounds explicit timeouts', () => {
    expect(directSingleQueryTimeoutMs({})).toBe(30_000);
    expect(directSingleQueryTimeoutMs({ timeoutMs: 110_000 })).toBe(110_000);
    expect(directSingleQueryTimeoutMs({ timeoutMs: 10 })).toBe(1_000);
    expect(directSingleQueryTimeoutMs({ timeoutMs: 999_000 })).toBe(120_000);
  });

  it('omits Default and preserves every explicit canonical effort', () => {
    expect(directSingleQueryEffort({ thinkingMode: 'none' })).toBeUndefined();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(directSingleQueryEffort({ thinkingMode: effort })).toBe(effort);
    }
  });

  it('combines a caller deadline with the adapter timeout signal', () => {
    const caller = new AbortController();
    const local = new AbortController();
    const signal = directSingleQuerySignal({ signal: caller.signal }, local.signal);

    caller.abort();

    expect(signal.aborted).toBe(true);
  });
});
