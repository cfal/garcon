import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from '../args.js';
import type { IssueCliCommand } from '../issue-args.js';
import { applyIssueStdin } from '../issue-commands.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';
const COMMENT = '33333333-3333-4333-8333-333333333333';
const CHAT = '1000000000000001';
function parse(...args: string[]): IssueCliCommand {
  const command = parseCliArgs(['issue', ...args], {}, '/working');
  if (command.kind !== 'issue') throw new Error('Expected issue command');
  return command;
}

describe('issue CLI arguments', () => {
  test('parses every action into the shared contract', () => {
    const cases = [
      ['create', '--title', 'Synthetic task', '--project', 'Release', '--priority', '1', '--label', 'bug', '--label', 'ui', '--assignee', `chat:${CHAT}`, '--parent-id', 'G-2'],
      ['list', '--ready', '--include-closed', '--priority', '0', '--status', 'open', '--project', 'Release', '--assignee', 'user:author:team', '--label', 'bug', '--query', '%_'],
      ['read', 'G-1', '--include-description', 'false', '--comment-limit', '1', '--before-comment-sequence', '3', '--expected-collection-revision', '4'],
      ['history', 'G-1', '--before-sequence', '20', '--limit', '10'],
      ['update', 'G-1', '--expected-revision', '2', '--patch', '{"project":"Other","assignee":null,"labels":[],"description":""}'],
      ...['claim', 'release', 'reopen'].map((action) => [action, 'G-1', '--expected-revision', '2']),
      ['close', 'G-1', '--expected-revision', '2', '--resolution', 'canceled', '--comment', 'Synthetic reason'],
      ['comment', 'G-1', '--body', 'Synthetic comment'],
      ['comment-edit', 'G-1', '--comment-id', COMMENT, '--expected-revision', '2', '--body', 'Synthetic edit'],
      ['comment-delete', 'G-1', '--comment-id', COMMENT, '--expected-revision', '2'],
      ...['link', 'unlink'].map((action) => [action, 'G-1', '--expected-revision', '2', '--target-id', 'G-2', '--target-revision', '1', '--link-kind', 'blocks']),
    ];
    for (const args of cases) expect(parse(...args).operation.action).toBe(args[0]);
    const list = parse(...cases[1]!).operation;
    expect(list).toMatchObject({ query: { assignee: { kind: 'user', username: 'author:team' }, query: '%_' } });
  });

  test('defaults cwd only for a new implicit-project create and keeps explicit project opaque', () => {
    expect(parse('create', '--title', 'Task').cwd).toBe('/working');
    expect(parse('create', '--title', 'Task', '--cwd', 'nested').cwd).toBe('/working/nested');
    expect(parse('create', '--title', 'Task', '--project', ' Release ', '--cwd', '/absent')).toMatchObject({ operation: { input: { project: 'Release' } } });
    expect(parse('create', '--title', 'Task', '--project', 'Release').cwd).toBeUndefined();
    expect(parse('list').cwd).toBeUndefined();
  });

  test('requires paired retry identity and frozen create project', () => {
    const retry = ['--request-id', REQUEST, '--expected-store-id', STORE];
    expect(parse('comment', 'G-1', '--body', 'Synthetic', '--from-chat', CHAT, ...retry))
      .toMatchObject({ retry: { requestId: REQUEST, expectedStoreId: STORE }, fromChatId: CHAT });
    expect(() => parse('create', '--title', 'Task', ...retry)).toThrow('requires --project');
    for (const flags of [['--request-id', REQUEST], ['--expected-store-id', STORE]]) {
      expect(() => parse('comment', 'G-1', '--body', 'Synthetic', ...flags)).toThrow('supplied together');
    }
  });

  test('rejects aliases, irrelevant/duplicate flags, missing targets/revisions and invalid query combinations', () => {
    const invalid = [
      ['show', 'G-1'], ['view', 'G-1'], ['list', 'G-1'], ['read'],
      ['list', '--cwd', '/working'], ['list', '--from-chat', CHAT],
      ['list', '--label', 'a', '--label', 'b'], ['list', '--before-number', '3'],
      ['list', '--limit', '101'], ['list', '--priority', '2.0'], ['list', '--limit', '1e2'],
      ['read', 'G-1', '--include-description', 'yes'],
      ['read', 'G-1', '--comment-limit', '0', '--before-comment-sequence', '2', '--expected-collection-revision', '0'],
      ['history', 'G-1', '--expected-collection-revision', '2'],
      ['create', '--title', 'Task', '--project', ''], ['create', '--title', 'Task', '--project', 'a', '--project', 'b'],
      ['claim', 'G-1'], ['claim', 'G-1', '--expected-revision', '0'],
      ['comment-edit', 'G-1', '--expected-revision', '1', '--body', 'Synthetic'],
      ['update', 'G-1', '--expected-revision', '1', '--patch', '{"status":"closed"}'],
      ['update', 'G-1', '--expected-revision', '1', '--patch', '{}'],
      ['comment', 'G-1', '--body', 'Synthetic', '--stdin'],
      ['create', '--title', 'Task', '--description', 'Synthetic', '--stdin'],
    ];
    for (const args of invalid) {
      expect(() => parse(...args)).toThrow();
      try { parse(...args); } catch (error) { expect(error).toMatchObject({ exitCode: 2 }); }
    }
  });

  test('resolves strict stdin into description, comment and closing comment before submission', () => {
    const body = 'Synthetic\n\ttext\0';
    for (const args of [['create', '--title', 'Task'], ['comment', 'G-1'],
      ['comment-edit', 'G-1', '--comment-id', COMMENT, '--expected-revision', '1'],
      ['close', 'G-1', '--expected-revision', '1']]) {
      const result = applyIssueStdin(parse(...args, '--stdin'), body);
      expect(result.readsBodyFromStdin).toBe(false);
      expect(JSON.stringify(result.operation)).toContain('Synthetic\\n\\ttext\\u0000');
    }
    expect(() => applyIssueStdin(parse('comment', 'G-1', '--stdin'), ' \n')).toThrow();
    expect(() => applyIssueStdin(parse('comment', 'G-1', '--stdin'), '\ud800')).toThrow();
    expect(() => applyIssueStdin(parse('comment', 'G-1', '--stdin'), 'x'.repeat(49153))).toThrow();
  });
});
