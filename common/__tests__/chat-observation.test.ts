import { describe, expect, it } from 'bun:test';
import { parseChatObservation } from '../chat-observation.js';
import { parseTranscriptNoticeDetail } from '../transcript-notice-details.js';

describe('native child presentation contracts', () => {
  it('requires an explicit observer projection or null', () => {
    expect(parseChatObservation(null)).toBeNull();
    for (const captureStatus of ['attached', 'detached'] as const) {
      expect(parseChatObservation({ kind: 'native-child', captureStatus }))
        .toEqual({ kind: 'native-child', captureStatus });
    }
    for (const value of [undefined, {}, { kind: 'native-child', captureStatus: 'running' }]) {
      expect(() => parseChatObservation(value)).toThrow();
    }
  });

  it('round trips only recognized native lifecycle and recovery details', () => {
    for (const status of ['running', 'completed', 'failed', 'interrupted'] as const) {
      const detail = { type: 'native-child-status', status } as const;
      expect(parseTranscriptNoticeDetail(detail)).toEqual(detail);
    }
    for (const type of ['native-child-gap', 'native-history-snapshot'] as const) {
      expect(parseTranscriptNoticeDetail({ type })).toEqual({ type });
    }
    expect(parseTranscriptNoticeDetail({ type: 'native-child-status', status: 'unknown' })).toBeNull();
  });
});
