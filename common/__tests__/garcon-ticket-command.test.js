import { describe, expect, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '../chat-types.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { parseGarconTicketCommand } from '../garcon-ticket-command.js';
import { TICKET_ACTIONS } from '../ticket-commands.js';

const at = '2026-01-01T00:00:00.000Z';
const commentId = '11111111-1111-4111-8111-111111111111';
const commands = {
  create: '<garcon-ticket-create ref="create">{"title":"Synthetic ticket"}</garcon-ticket-create>',
  list: '<garcon-ticket-list />',
  read: '<garcon-ticket-read ticket-id="G-1" />',
  history: '<garcon-ticket-history ticket-id="G-1">{"limit":3,"beforeSequence":7}</garcon-ticket-history>',
  update: '<garcon-ticket-update ref="edit" ticket-id="G-1" expected-revision="1">{"status":"in-review","assignee":null}</garcon-ticket-update>',
  claim: '<garcon-ticket-claim ref="claim" ticket-id="G-1" expected-revision="1" />',
  release: '<garcon-ticket-release ref="release" ticket-id="G-1" expected-revision="1" />',
  reopen: '<garcon-ticket-reopen ref="reopen" ticket-id="G-1" expected-revision="1" />',
  close: '<garcon-ticket-close ref="close" ticket-id="G-1" expected-revision="1" />',
  comment: '<garcon-ticket-comment ref="comment" ticket-id="G-1">Synthetic &lt;text&gt; &amp; &amp;lt;</garcon-ticket-comment>',
  'comment-edit': `<garcon-ticket-comment-edit ref="edit-comment" ticket-id="G-1" comment-id="${commentId}" expected-revision="1">Edited.</garcon-ticket-comment-edit>`,
  'comment-delete': `<garcon-ticket-comment-delete ref="remove" ticket-id="G-1" comment-id="${commentId}" expected-revision="1" />`,
  link: '<garcon-ticket-link ref="link" ticket-id="G-1" expected-revision="1">{"targetId":"G-2","targetRevision":2,"kind":"blocks"}</garcon-ticket-link>',
  unlink: '<garcon-ticket-unlink ref="unlink" ticket-id="G-1" expected-revision="1">{"targetId":"G-2","targetRevision":2,"kind":"related"}</garcon-ticket-unlink>',
};

describe('ticket command grammar', () => {
  test('rejects the retired command names and target attribute', () => {
    for (const xml of Object.values(commands)) {
      const retired = xml.replaceAll('garcon-ticket-', 'garcon-issue-').replaceAll('ticket-id', 'issue-id');
      expect(parseGarconTicketCommand(retired)).toBeNull();
      expect(extractGarconCommands(new AssistantMessage(at, retired))).toBeNull();
    }
    expect(parseGarconTicketCommand(commands.read.replace('ticket-id', 'issue-id'))).toBeNull();
  });

  test('parses all verbs and preserves optional versus required correlation', () => {
    expect(Object.keys(commands).sort()).toEqual([...TICKET_ACTIONS].sort());
    for (const [action, xml] of Object.entries(commands)) {
      const parsed = parseGarconTicketCommand(xml);
      expect(parsed?.type).toBe('ticket');
      expect(parsed?.payload.action).toBe(action);
      expect(extractGarconCommands(new AssistantMessage(at, xml))?.commands).toEqual([parsed]);
      if (!['list', 'read', 'history'].includes(action)) {
        expect(parseGarconTicketCommand(xml.replace(/ ref="[^"]*"/u, ''))).toBeNull();
      }
    }
    expect(parseGarconTicketCommand(commands.comment).payload.body).toBe('Synthetic <text> & &lt;');
    expect(parseGarconTicketCommand(commands.create).payload.input.project).toBeUndefined();
    expect(parseGarconTicketCommand(commands.read).ref).toBeUndefined();
    expect(parseGarconTicketCommand(commands.read.replace(' ticket-id', ' ref="read &quot;one&quot;" ticket-id')).ref).toBe('read "one"');
  });

  test('supports exact structured query, clear, and close semantics', () => {
    expect(parseGarconTicketCommand('<garcon-ticket-read ticket-id="G-1">{"includeDescription":false,"commentLimit":1,"beforeCommentSequence":3,"expectedCollectionRevision":5}</garcon-ticket-read>')?.payload.query)
      .toEqual({ ticketId: 'G-1', includeDescription: false, commentLimit: 1, beforeCommentSequence: 3, expectedCollectionRevision: 5 });
    expect(parseGarconTicketCommand('<garcon-ticket-list>{"includeClosed":true,"ready":false,"assignee":{"kind":"chat","chatId":"1000000000000001"}}</garcon-ticket-list>')?.payload.query.ready).toBe(false);
    expect(parseGarconTicketCommand(commands.close.replace(' />', '>{"resolution":"canceled","comment":"Stopped."}</garcon-ticket-close>'))?.payload.resolution).toBe('canceled');
    expect(parseGarconTicketCommand(commands.update)?.payload.patch.assignee).toBeNull();
  });

  test('rejects ambiguous attributes, bodies, aliases and invalid domain input', () => {
    const invalid = [
      commands.create.replace('ref="create"', 'request-id="create"'),
      commands.create.replace('ref="create"', 'ref="create" ref="other"'),
      commands.create.replace('ref="create"', 'ref=" "'),
      commands.create.replace('ref="create"', `ref="${'x'.repeat(129)}"`),
      commands.create.replace('Synthetic ticket', ''),
      commands.create.replace('"title":', '"unknown":'),
      commands.read.replace('read', 'show'), commands.read.replace('read', 'view'),
      commands.read.replace('G-1', 'G-01'),
      commands.claim.replace('"1"', '"1.0"'),
      commands.claim.replace(' />', '> </garcon-ticket-claim>'),
      commands.update.replace('in-review', 'closed'),
      commands.comment.replace('Synthetic &lt;text&gt; &amp; &amp;lt;', ' '),
      commands['comment-delete'].replace(` comment-id="${commentId}"`, ''),
      '<garcon-ticket-read ticket-id="G-1">{"beforeCommentSequence":2}</garcon-ticket-read>',
      '<garcon-ticket-read ticket-id="G-1">{"includeDescription":"false"}</garcon-ticket-read>',
      '<garcon-ticket-create ref="empty" />',
    ];
    for (const xml of invalid) expect(parseGarconTicketCommand(xml)).toBeNull();
  });

  test('extracts edge commands once, leaving fenced, nested and user text inert', () => {
    const transformed = extractGarconCommands(new AssistantMessage(at, `${commands.create}\nSummary.\n${commands.read}`));
    expect(transformed.commands.map((command) => command.payload.action)).toEqual(['create', 'read']);
    expect(transformed.message.content).toBe('Summary.');
    for (const content of [`\`\`\`xml\n${commands.create}\n\`\`\``, `Example ${commands.read} in text.`,
      `<garcon-ticket-comment ref="nested" ticket-id="G-1">${commands.create}</garcon-ticket-comment>`]) {
      expect(extractGarconCommands(new AssistantMessage(at, content))?.commands ?? []).toEqual([]);
    }
    expect(extractGarconCommands(new UserMessage(at, commands.create))).toBeNull();
    const malformed = extractGarconCommands(new AssistantMessage(at, '<garcon-ticket-create>{}</garcon-ticket-create>'));
    expect(malformed.commands).toEqual([]);
    expect(malformed.issues).toEqual([{ command: 'ticket-create', reason: 'malformed', edge: 'leading' }]);
    expect(extractGarconCommands(new AssistantMessage(at, '<garcon-ticket-read-result />'))).toBeNull();
  });
});
