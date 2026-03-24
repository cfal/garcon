import { describe, expect, it } from 'bun:test';
import {
  ARTIFICIAL_NATIVE_PATH_PREFIX,
  createArtificialNativePath,
  getArtificialProviderSessionId,
  isArtificialNativePath,
  parseArtificialNativePath,
} from '../artificial-native-path.js';

describe('artificial native path helpers', () => {
  it('creates prefixed artificial native paths', () => {
    expect(createArtificialNativePath('amp', 'thread-1'))
      .toBe(`${ARTIFICIAL_NATIVE_PATH_PREFIX}amp:thread-1`);
  });

  it('detects prefixed artificial native paths', () => {
    expect(isArtificialNativePath('!opencode:session-1')).toBe(true);
    expect(parseArtificialNativePath('!opencode:session-1')).toEqual({
      provider: 'opencode',
      providerSessionId: 'session-1',
    });
    expect(getArtificialProviderSessionId('!opencode:session-1', 'opencode')).toBe('session-1');
  });

  it('rejects non-prefixed paths', () => {
    expect(isArtificialNativePath('amp:thread-1')).toBe(false);
    expect(parseArtificialNativePath('amp:thread-1')).toBeNull();
    expect(getArtificialProviderSessionId('amp:thread-1', 'amp')).toBeNull();
    expect(isArtificialNativePath('/tmp/opencode:session-1')).toBe(false);
    expect(isArtificialNativePath('C:\\temp\\amp:thread-1')).toBe(false);
    expect(parseArtificialNativePath('/tmp/opencode:session-1')).toBeNull();
  });
});
