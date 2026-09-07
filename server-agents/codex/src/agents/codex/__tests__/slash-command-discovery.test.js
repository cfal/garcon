import { describe, expect, it, mock } from 'bun:test';

import { CodexSkillDiscovery, parseSkillsListResponse } from '../slash-command-discovery.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

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

  it('logs rejected client shutdowns while clearing active discovery', async () => {
    let rejectRequest;
    const request = mock(() => new Promise((_, reject) => {
      rejectRequest = reject;
    }));
    const shutdown = mock(async () => {
      rejectRequest?.(new Error('request stopped'));
      throw new Error('shutdown failed');
    });
    const warn = mock();
    const discovery = new CodexSkillDiscovery({
      createClient: () => ({ request, shutdown }),
      logger: { ...logger, warn },
    });
    const pending = discovery.commands('/repo');
    await Promise.resolve();

    await discovery.clear();
    await expect(pending).rejects.toThrow('shutdown failed');
    expect(warn).toHaveBeenCalledWith('Codex app-server shutdown failed', {
      operation: 'skills-discovery-clear',
      error: 'shutdown failed',
    });
  });
});
