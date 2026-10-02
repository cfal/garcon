import { expect, test } from 'bun:test';
import type { RecentAgentSetting } from '../../../../common/settings.js';
import { effectiveExecutorId } from '../../../../common/executors.js';
import { dedupeRecentAgentSettings, sanitizeRecentAgentSettings } from '../startup-recents.js';

const REMOTE = '22222222-2222-4222-8222-222222222222';

function recent(executorId: string | null | undefined, model: string): RecentAgentSetting {
  return { executorId, agentId: 'claude', model, apiProviderId: null, modelEndpointId: null, modelProtocol: null };
}

test('retains twenty recents per executor in global newest-first order', () => {
  const entries = Array.from({ length: 25 }, (_, index) => [
    recent(REMOTE, `model-${index}`), recent(undefined, `model-${index}`),
  ]).flat();
  const result = dedupeRecentAgentSettings(entries);
  expect(result).toEqual(entries.slice(0, 40));
  expect(result.filter(entry => effectiveExecutorId(entry.executorId) === 'local')).toHaveLength(20);
  expect(result.filter(entry => entry.executorId === REMOTE)).toHaveLength(20);
  expect(dedupeRecentAgentSettings([
    ...entries.filter(entry => entry.executorId === REMOTE), recent(undefined, 'older-local'),
  ]).at(-1)?.model).toBe('older-local');
});

test('deduplicates Local aliases without merging identical targets on different hosts', () => {
  const entries = [recent(null, 'same'), recent('local', 'same'), recent(undefined, 'same'), recent(REMOTE, 'same')];
  expect(dedupeRecentAgentSettings(entries)).toEqual([entries[0]!, entries[3]!]);
});

test('sanitizes per-host overflow once without repeatedly migrating a mixed history', () => {
  const entries = Array.from({ length: 25 }, (_, index) => [
    recent(REMOTE, `model-${index}`), recent('local', `model-${index}`),
  ]).flat();
  const sanitized = sanitizeRecentAgentSettings(entries);
  expect(sanitized.entries).toHaveLength(40);
  expect(sanitized.migrated).toBe(true);
  expect(sanitizeRecentAgentSettings(sanitized.entries)).toEqual({ entries: sanitized.entries, migrated: false });
});
