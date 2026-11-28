import { expect, test } from 'bun:test';
import {
  DEFAULT_PULL_REQUEST_REVIEW_SETTINGS as defaults, isActivePullRequestReviewRun, isPullRequestReviewsSnapshot,
  normalizePullRequestReviewRepositoryInput, normalizePullRequestReviewSettings, parseReviewedCommit,
  pullRequestReviewCommentBody, pullRequestReviewMarkerPrefix, pullRequestReviewPromptFits, renderPullRequestReviewPrompt,
  type PullRequestReviewRepositoryInput,
} from '../../../../../common/pull-request-reviews.ts';

const sha = 'aB'.repeat(32);
const target = {
  type: 'new-chat', agentId: 'codex', projectPath: '/workspace/project', model: 'gpt-5',
  apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
  agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' },
} satisfies PullRequestReviewRepositoryInput['target'];

test('records all run states and shallow snapshot checks', () => {
  for (const state of ['queued', 'reviewing', 'needs-input'] as const) expect(isActivePullRequestReviewRun(state)).toBe(true);
  for (const state of ['completed', 'outdated', 'failed', 'stopped', 'interrupted'] as const) expect(isActivePullRequestReviewRun(state)).toBe(false);
  const snapshot = { revision: 42, repositories: [null], inbox: [false], recentRuns: [10] };
  expect(isPullRequestReviewsSnapshot(snapshot)).toBe(true);
  for (const revision of [-1, 0.5, 2 ** 53, '42']) expect(isPullRequestReviewsSnapshot({ ...snapshot, revision })).toBe(false);
  expect(isPullRequestReviewsSnapshot({ ...snapshot, recentRuns: {} })).toBe(false);
});

test('records the multiline commit grammar and comment suffix', () => {
  expect(parseReviewedCommit(`outside\u2028> reVIEWed commit: \`${sha}\`\rnext`)).toBe(sha.toLowerCase());
  expect(parseReviewedCommit(`Reviewed commit: ${sha}\u2029Reviewed commit: ${sha.toLowerCase()}`)).toBe(sha.toLowerCase());
  expect(parseReviewedCommit(`not a line\u0085Reviewed commit: ${sha}`)).toBeNull();
  expect(parseReviewedCommit(`Reviewed commit: ${sha}a`)).toBeNull();
  expect(pullRequestReviewMarkerPrefix('OWNER/REPO', 1e21)).toBe('garcon-review owner/repo#1e+21 ');
  expect(pullRequestReviewCommentBody('  Synthetic review\ufeff\u00a0\r\n', 'Owner/Repo', 5, sha))
    .toBe(`  Synthetic review\n\n<!-- garcon-review owner/repo#5 ${sha} -->`);
});

test('records settings and repository normalization', () => {
  const settings = {
    ...defaults,
    filters: { ...defaults.filters, baseBranches: [' main ', 'main', 'release'], includeLabels: ['Review'], maxChangedLines: null },
  };
  expect(normalizePullRequestReviewSettings(settings)?.filters.baseBranches).toEqual(['main', 'release']);
  expect(normalizePullRequestReviewSettings({ ...settings, filters: { ...settings.filters, includeLabels: ['\0'] } })).toBeNull();
  expect(normalizePullRequestReviewSettings({ ...settings, filters: { ...settings.filters, baseBranches: Array(21).fill('main') } })).toBeNull();
  expect(normalizePullRequestReviewRepositoryInput({ target, settings })?.target.type).toBe('new-chat');
  expect(normalizePullRequestReviewRepositoryInput({ target: { ...target, projectPath: '\t' }, settings })).toBeNull();
  expect(normalizePullRequestReviewRepositoryInput({ target, settings: { ...settings, dailyReviewLimit: 501 } })).toBeNull();
});

test('records bounded expansion and stripped repository URL', () => {
  const values = { repository: 'o/r', repositoryUrl: 'https://git.invalid/o/r/', projectPath: '/repo', number: 5 };
  expect(renderPullRequestReviewPrompt('{{repository_url}} {{pull_request_number}} {{typo}}', values))
    .toBe('https://git.invalid/o/r 5 {{typo}}');
  expect(() => renderPullRequestReviewPrompt('{{project_path}}', { ...values, projectPath: 'x'.repeat(32_001) })).toThrow();
  expect(pullRequestReviewPromptFits('{{project_path}}', 'x'.repeat(32_000))).toBe(true);
  expect(pullRequestReviewPromptFits('{{project_path}}!', 'x'.repeat(32_000))).toBe(false);
});
