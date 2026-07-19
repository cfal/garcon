import { describe, expect, it } from 'bun:test';

import {
  createCursorAcpNativePath,
  getCursorAgentSessionIdFromNativePath,
  getCursorStreamJsonAgentSessionIdFromNativePath,
} from '../cursor-native-path.js';

describe('Cursor native path helpers', () => {
  it('creates ACP native paths for new Cursor sessions', () => {
    expect(createCursorAcpNativePath('session-1')).toBe('!cursor-acp:session-1');
  });

  it('accepts stream-json, ACP, and legacy Cursor native path namespaces', () => {
    expect(getCursorAgentSessionIdFromNativePath('!cursor-stream-json:session-1')).toBe('session-1');
    expect(getCursorAgentSessionIdFromNativePath('!cursor-acp:session-2')).toBe('session-2');
    expect(getCursorAgentSessionIdFromNativePath('!cursor:session-3')).toBe('session-3');
    expect(getCursorAgentSessionIdFromNativePath('!amp:session-4')).toBeNull();
  });

  it('detects only stream-json native paths for startup migration', () => {
    expect(getCursorStreamJsonAgentSessionIdFromNativePath('!cursor-stream-json:session-1')).toBe('session-1');
    expect(getCursorStreamJsonAgentSessionIdFromNativePath('!cursor-acp:session-2')).toBeNull();
  });
});
