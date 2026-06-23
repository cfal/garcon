import { describe, expect, it } from 'bun:test';

import { buildUserInput, parseLeadingSlashCommand } from '../request-builders.js';

const SKILLS = [
  { name: 'dogfood', path: '/skills/dogfood' },
  { name: 'check', path: '/skills/check' },
];

describe('parseLeadingSlashCommand', () => {
  it('parses a bare command and one with arguments', () => {
    expect(parseLeadingSlashCommand('/dogfood')).toEqual({ name: 'dogfood', rest: '' });
    expect(parseLeadingSlashCommand('/dogfood test the app')).toEqual({
      name: 'dogfood',
      rest: 'test the app',
    });
  });

  it('does not match non-leading or multi-segment slashes', () => {
    expect(parseLeadingSlashCommand('hello /dogfood')).toBeNull();
    expect(parseLeadingSlashCommand('/path/to/file is broken')).toBeNull();
    expect(parseLeadingSlashCommand('no slash here')).toBeNull();
  });
});

describe('buildUserInput', () => {
  it('emits a skill item when the command names a known skill', () => {
    expect(buildUserInput('/dogfood', undefined, SKILLS)).toEqual([
      { type: 'skill', name: 'dogfood', path: '/skills/dogfood' },
    ]);
  });

  it('emits a skill item plus trailing text', () => {
    expect(buildUserInput('/dogfood test the app', undefined, SKILLS)).toEqual([
      { type: 'skill', name: 'dogfood', path: '/skills/dogfood' },
      { type: 'text', text: 'test the app', text_elements: [] },
    ]);
  });

  it('falls back to plain text when the name is not a known skill', () => {
    expect(buildUserInput('/unknown do thing', undefined, SKILLS)).toEqual([
      { type: 'text', text: '/unknown do thing', text_elements: [] },
    ]);
  });

  it('sends plain text when no skills are available', () => {
    expect(buildUserInput('/dogfood', undefined, [])).toEqual([
      { type: 'text', text: '/dogfood', text_elements: [] },
    ]);
    expect(buildUserInput('just a message')).toEqual([
      { type: 'text', text: 'just a message', text_elements: [] },
    ]);
  });

  it('appends local images after the input items', () => {
    expect(buildUserInput('/dogfood', ['/tmp/a.png'], SKILLS)).toEqual([
      { type: 'skill', name: 'dogfood', path: '/skills/dogfood' },
      { type: 'localImage', path: '/tmp/a.png' },
    ]);
  });
});
