import { describe, expect, it, mock } from 'bun:test';
import { updateClaudeContextWindow } from '../context-window-control.js';

type RequestControl = Parameters<typeof updateClaudeContextWindow>[0];

function controller(settings: unknown = { sources: [] }, usage: unknown = {
  model: 'next[1m]', autocompactSource: 'env', rawMaxTokens: 850_000,
}) {
  return mock<RequestControl>(async request => {
    if (request.subtype === 'get_settings') return settings;
    if (request.subtype === 'get_context_usage') return usage;
    return {};
  });
}

describe('updateClaudeContextWindow', () => {
  it('preserves only the raw flag environment and verifies the live window after switching models', async () => {
    const env = { SYNTHETIC_API_KEY: 'synthetic-credential', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '922000' };
    const request = controller({
      effective: { env: { EFFECTIVE_ONLY: 'not-a-flag' } },
      sources: [
        { source: 'userSettings', settings: { env: { USER_ONLY: 'not-a-flag' } } },
        { source: 'flagSettings', settings: { env } },
      ],
    });
    await updateClaudeContextWindow(request, 'previous[1m]', 'next[1m]', 850_000);
    expect(request.mock.calls.map(([value]) => value)).toEqual([
      { subtype: 'get_settings' },
      { subtype: 'apply_flag_settings', settings: { env: {
        SYNTHETIC_API_KEY: 'synthetic-credential', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '850000',
      } } },
      { subtype: 'set_model', model: 'next[1m]' },
      { subtype: 'get_context_usage' },
    ]);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('922000');
  });

  it.each([
    { sources: [] },
    { sources: [{ source: 'flagSettings', settings: {} }] },
  ])('supports an absent flag environment without redundant model controls: %j', async settings => {
    const request = controller(settings);
    await updateClaudeContextWindow(request, 'next[1m]', 'next[1m]', 850_000);
    expect(request.mock.calls.map(([value]) => value)).toEqual([
      { subtype: 'get_settings' },
      { subtype: 'apply_flag_settings', settings: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '850000' } } },
      { subtype: 'get_context_usage' },
    ]);
  });

  it.each([
    null,
    {},
    { sources: null },
    { sources: [null] },
    { sources: [{}] },
    { sources: [{ source: 'flagSettings' }] },
    { sources: [{ source: 'flagSettings', settings: null }] },
    { sources: [{ source: 'flagSettings', settings: { env: null } }] },
    { sources: [{ source: 'flagSettings', settings: { env: [] } }] },
    { sources: [{ source: 'flagSettings', settings: { env: { INVALID: 1 } } }] },
    { sources: [
      { source: 'flagSettings', settings: {} },
      { source: 'flagSettings', settings: {} },
    ] },
  ])('rejects malformed settings before mutating the CLI: %j', async settings => {
    const request = controller(settings);
    await expect(updateClaudeContextWindow(request, 'previous[1m]', 'next[1m]', 850_000))
      .rejects.toThrow('Claude CLI returned invalid');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { model: 'wrong[1m]', autocompactSource: 'env', rawMaxTokens: 850_000 },
    { model: 'next[1m]', autocompactSource: 'settings', rawMaxTokens: 850_000 },
    { model: 'next[1m]', autocompactSource: 'env', rawMaxTokens: 922_000 },
    { model: 'next[1m]', autocompactSource: 'env', rawMaxTokens: '850000' },
  ])('rejects ineffective controls despite successful ACKs: %j', async usage => {
    const request = controller({ sources: [] }, usage);
    await expect(updateClaudeContextWindow(request, 'previous[1m]', 'next[1m]', 850_000))
      .rejects.toThrow('did not apply');
  });

  it.each(['get_settings', 'apply_flag_settings', 'set_model', 'get_context_usage'])
  ('propagates a failed %s control without sending later controls', async failedSubtype => {
    const error = new Error('synthetic control failure');
    const request = controller();
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async value => {
      if (value.subtype === failedSubtype) throw error;
      return implementation(value);
    });
    await expect(updateClaudeContextWindow(request, 'previous[1m]', 'next[1m]', 850_000))
      .rejects.toBe(error);
    expect(request.mock.calls.at(-1)?.[0].subtype).toBe(failedSubtype);
  });
});
