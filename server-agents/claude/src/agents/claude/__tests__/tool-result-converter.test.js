import { describe, expect, it } from 'bun:test';

import { claudeToolResultContent } from '../tool-result-converter.js';

describe('claudeToolResultContent', () => {
  it('preserves live tool metadata with normalized output', () => {
    expect(claudeToolResultContent('command output', {
      stdout: 'command output',
      stderr: '',
      interrupted: false,
    })).toEqual({
      raw: 'command output',
      toolUseResult: {
        stdout: 'command output',
        stderr: '',
        interrupted: false,
      },
    });
  });

  it('normalizes tool output without provider metadata', () => {
    expect(claudeToolResultContent([
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ], undefined)).toEqual({
      items: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });
  });
});
