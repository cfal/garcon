import { describe, expect, it } from 'bun:test';

import {
  createCursorStreamJsonNativePath,
  getCursorAgentSessionIdFromNativePath,
} from '../cursor/cursor-native-path.js';

describe('Cursor native path helpers', () => {
  it('creates stream-json native paths for new Cursor sessions', () => {
    expect(createCursorStreamJsonNativePath('session-1')).toBe('!cursor-stream-json:session-1');
  });

  it('accepts stream-json, ACP, and legacy Cursor native path namespaces', () => {
    expect(getCursorAgentSessionIdFromNativePath('!cursor-stream-json:session-1')).toBe('session-1');
    expect(getCursorAgentSessionIdFromNativePath('!cursor-acp:session-2')).toBe('session-2');
    expect(getCursorAgentSessionIdFromNativePath('!cursor:session-3')).toBe('session-3');
    expect(getCursorAgentSessionIdFromNativePath('!amp:session-4')).toBeNull();
  });
});
