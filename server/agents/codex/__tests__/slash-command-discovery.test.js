import { describe, expect, it } from 'bun:test';

import { parseSkillsListResponse } from '../slash-command-discovery.js';

describe('parseSkillsListResponse', () => {
  it('flattens skills across cwd entries into name+path refs', () => {
    const refs = parseSkillsListResponse({
      data: [
        {
          cwd: '/p',
          skills: [{
            name: 'dogfood',
            path: '/s/dogfood',
            description: 'Run the dogfood workflow',
            enabled: true,
          }],
          errors: [],
        },
        { cwd: '/p/sub', skills: [{ name: 'check', path: '/s/check', enabled: true }], errors: [] },
      ],
    });
    expect(refs).toEqual([
      { name: 'check', path: '/s/check' },
      { name: 'dogfood', path: '/s/dogfood', description: 'Run the dogfood workflow' },
    ]);
  });

  it('skips disabled skills and entries missing name or path', () => {
    const refs = parseSkillsListResponse({
      data: [
        {
          skills: [
            { name: 'on', path: '/s/on', enabled: true },
            { name: 'off', path: '/s/off', enabled: false },
            { name: 'nopath' },
            { path: '/s/noname' },
          ],
        },
      ],
    });
    expect(refs).toEqual([{ name: 'on', path: '/s/on' }]);
  });

  it('de-duplicates by name and tolerates malformed responses', () => {
    expect(parseSkillsListResponse(null)).toEqual([]);
    expect(parseSkillsListResponse({ data: 'nope' })).toEqual([]);
    const refs = parseSkillsListResponse({
      data: [{ skills: [{ name: 'dup', path: '/a' }, { name: 'dup', path: '/b' }] }],
    });
    expect(refs).toEqual([{ name: 'dup', path: '/a' }]);
  });
});
