import { describe, expect, it, mock } from 'bun:test';
import { agentSpeed } from '@garcon/common/agent-speed';
import { assertCodexFastModel } from '../service-tier.ts';
import {
  buildThreadStartParams, buildThreadResumeParams, buildTurnStartParams,
  buildThreadSettingsUpdateParams, codexThreadSettingsTarget,
  threadSettingsMatch, threadSettingsTargetFromSnapshot,
} from '../app-server/request-builders.ts';

const configuration = { model: 'supported-model', permissionMode: 'default', thinkingMode: 'none' };

describe('Codex per-chat speed', () => {
  it('treats existing empty settings as Standard', () => {
    expect(agentSpeed({ ownerId: 'codex', schemaVersion: 1, values: {} })).toBe('standard');
  });

  it.each([[undefined, 'default'], ['standard', 'default'], ['fast', 'priority']])(
    'sets %s explicitly on start, resume, turn and settings updates', (speed, tier) => {
      const request = { ...configuration, projectPath: '/project', command: 'hello', speed };
      expect(buildThreadStartParams(request).serviceTier).toBe(tier);
      expect(buildThreadResumeParams({ ...request, agentSessionId: 'thread' }).serviceTier).toBe(tier);
      expect(buildTurnStartParams({ ...request, threadId: 'thread' }).serviceTier).toBe(tier);
      expect(buildThreadSettingsUpdateParams('thread', codexThreadSettingsTarget(request)).serviceTier).toBe(tier);
    },
  );

  it('requires the confirmed tier to match and accepts the native fast alias', () => {
    const target = codexThreadSettingsTarget({ ...configuration, speed: 'fast' });
    const confirmed = (serviceTier) => threadSettingsTargetFromSnapshot({
      ...target, serviceTier, cwd: '/project', modelProvider: 'test',
    }, 'default');
    expect(threadSettingsMatch(confirmed(null), target)).toBe(false);
    expect(threadSettingsMatch(confirmed('default'), target)).toBe(false);
    expect(threadSettingsMatch(confirmed('priority'), target)).toBe(true);
    expect(threadSettingsMatch(confirmed('fast'), target)).toBe(true);
  });

  it('checks the selected model across catalog pages', async () => {
    const request = mock()
      .mockResolvedValueOnce({ data: [{ model: 'another-model' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ data: [{ model: 'supported-model', serviceTiers: [{ id: 'priority' }] }] });
    await assertCodexFastModel({ request }, 'supported-model');
    expect(request).toHaveBeenLastCalledWith('model/list', { includeHidden: true, limit: 100, cursor: 'next' });
  });

  it.each([
    { data: [] },
    { data: [{ model: 'supported-model', serviceTiers: [] }] },
    { data: [{ model: 'supported-model', serviceTiers: [{ id: 'flex' }] }] },
    { data: null },
  ])('rejects unavailable or unsupported Fast rather than silently falling back', async (result) => {
    await expect(assertCodexFastModel({ request: async () => result }, 'supported-model'))
      .rejects.toThrow('Fast mode is not advertised');
  });
});
