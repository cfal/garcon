import { describe, expect, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '../chat-types.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { parseGarconIssueCommand } from '../garcon-issue-command.js';
import { ISSUE_ACTIONS } from '../issue-commands.js';

const at = '2026-01-01T00:00:00.000Z';
const commentId = '11111111-1111-4111-8111-111111111111';
const commands = {
  create: '<garcon-issue-create ref="create">{"title":"Synthetic issue"}</garcon-issue-create>',
  list: '<garcon-issue-list />',
  read: '<garcon-issue-read issue-id="ISS-1" />',
  history: '<garcon-issue-history issue-id="ISS-1">{"limit":3,"beforeSequence":7}</garcon-issue-history>',
  update: '<garcon-issue-update ref="edit" issue-id="ISS-1" expected-revision="1">{"status":"in-review","assignee":null}</garcon-issue-update>',
  claim: '<garcon-issue-claim ref="claim" issue-id="ISS-1" expected-revision="1" />',
  release: '<garcon-issue-release ref="release" issue-id="ISS-1" expected-revision="1" />',
  reopen: '<garcon-issue-reopen ref="reopen" issue-id="ISS-1" expected-revision="1" />',
  close: '<garcon-issue-close ref="close" issue-id="ISS-1" expected-revision="1" />',
  comment: '<garcon-issue-comment ref="comment" issue-id="ISS-1">Synthetic &lt;text&gt; &amp; &amp;lt;</garcon-issue-comment>',
  'comment-edit': `<garcon-issue-comment-edit ref="edit-comment" issue-id="ISS-1" comment-id="${commentId}" expected-revision="1">Edited.</garcon-issue-comment-edit>`,
  'comment-delete': `<garcon-issue-comment-delete ref="remove" issue-id="ISS-1" comment-id="${commentId}" expected-revision="1" />`,
  link: '<garcon-issue-link ref="link" issue-id="ISS-1" expected-revision="1">{"targetId":"ISS-2","targetRevision":2,"kind":"blocks"}</garcon-issue-link>',
  unlink: '<garcon-issue-unlink ref="unlink" issue-id="ISS-1" expected-revision="1">{"targetId":"ISS-2","targetRevision":2,"kind":"related"}</garcon-issue-unlink>',
};

describe('issue command grammar', () => {
  test('parses all verbs and preserves optional versus required correlation', () => {
    expect(Object.keys(commands).sort()).toEqual([...ISSUE_ACTIONS].sort());
    for (const [action, xml] of Object.entries(commands)) {
      const parsed = parseGarconIssueCommand(xml);
      expect(parsed?.type).toBe('issue');
      expect(parsed?.payload.action).toBe(action);
      expect(extractGarconCommands(new AssistantMessage(at, xml))?.commands).toEqual([parsed]);
      if (!['list', 'read', 'history'].includes(action)) {
        expect(parseGarconIssueCommand(xml.replace(/ ref="[^"]*"/u, ''))).toBeNull();
      }
    }
    expect(parseGarconIssueCommand(commands.comment).payload.body).toBe('Synthetic <text> & &lt;');
    expect(parseGarconIssueCommand(commands.create).payload.input.project).toBeUndefined();
    expect(parseGarconIssueCommand(commands.read).ref).toBeUndefined();
    expect(parseGarconIssueCommand(commands.read.replace(' issue-id', ' ref="read &quot;one&quot;" issue-id')).ref).toBe('read "one"');
  });

  test('supports exact structured query, clear, and close semantics', () => {
    expect(parseGarconIssueCommand('<garcon-issue-read issue-id="ISS-1">{"includeDescription":false,"commentLimit":1,"beforeCommentSequence":3,"expectedCollectionRevision":5}</garcon-issue-read>')?.payload.query)
      .toEqual({ issueId: 'ISS-1', includeDescription: false, commentLimit: 1, beforeCommentSequence: 3, expectedCollectionRevision: 5 });
    expect(parseGarconIssueCommand('<garcon-issue-list>{"includeClosed":true,"ready":false,"assignee":{"kind":"chat","chatId":"1000000000000001"}}</garcon-issue-list>')?.payload.query.ready).toBe(false);
    expect(parseGarconIssueCommand(commands.close.replace(' />', '>{"resolution":"canceled","comment":"Stopped."}</garcon-issue-close>'))?.payload.resolution).toBe('canceled');
    expect(parseGarconIssueCommand(commands.update)?.payload.patch.assignee).toBeNull();
  });

  test('rejects ambiguous attributes, bodies, aliases and invalid domain input', () => {
    const invalid = [
      commands.create.replace('ref="create"', 'request-id="create"'),
      commands.create.replace('ref="create"', 'ref="create" ref="other"'),
      commands.create.replace('ref="create"', 'ref=" "'),
      commands.create.replace('ref="create"', `ref="${'x'.repeat(129)}"`),
      commands.create.replace('Synthetic issue', ''),
      commands.create.replace('"title":', '"unknown":'),
      commands.read.replace('read', 'show'), commands.read.replace('read', 'view'),
      commands.read.replace('ISS-1', 'ISS-01'),
      commands.claim.replace('"1"', '"1.0"'),
      commands.claim.replace(' />', '> </garcon-issue-claim>'),
      commands.update.replace('in-review', 'closed'),
      commands.comment.replace('Synthetic &lt;text&gt; &amp; &amp;lt;', ' '),
      commands['comment-delete'].replace(` comment-id="${commentId}"`, ''),
      '<garcon-issue-read issue-id="ISS-1">{"beforeCommentSequence":2}</garcon-issue-read>',
      '<garcon-issue-read issue-id="ISS-1">{"includeDescription":"false"}</garcon-issue-read>',
      '<garcon-issue-create ref="empty" />',
    ];
    for (const xml of invalid) expect(parseGarconIssueCommand(xml)).toBeNull();
  });

  test('extracts edge commands once, leaving fenced, nested and user text inert', () => {
    const transformed = extractGarconCommands(new AssistantMessage(at, `${commands.create}\nSummary.\n${commands.read}`));
    expect(transformed.commands.map((command) => command.payload.action)).toEqual(['create', 'read']);
    expect(transformed.message.content).toBe('Summary.');
    for (const content of [`\`\`\`xml\n${commands.create}\n\`\`\``, `Example ${commands.read} in text.`,
      `<garcon-issue-comment ref="nested" issue-id="ISS-1">${commands.create}</garcon-issue-comment>`]) {
      expect(extractGarconCommands(new AssistantMessage(at, content))?.commands ?? []).toEqual([]);
    }
    expect(extractGarconCommands(new UserMessage(at, commands.create))).toBeNull();
    const malformed = extractGarconCommands(new AssistantMessage(at, '<garcon-issue-create>{}</garcon-issue-create>'));
    expect(malformed.commands).toEqual([]);
    expect(malformed.issues).toEqual([{ command: 'issue-create', reason: 'malformed', edge: 'leading' }]);
    expect(extractGarconCommands(new AssistantMessage(at, '<garcon-issue-read-result />'))).toBeNull();
  });
});
