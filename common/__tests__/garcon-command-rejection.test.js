import { describe, expect, test } from 'bun:test';
import { AssistantMessage } from '../chat-types.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { escapeGarconXmlText } from '../garcon-command-envelope.js';
import { garconCommandRejectionContent, parseGarconCommandRejection, TICKET_COMMAND_REJECTION_GUIDANCE } from '../garcon-command-rejection.js';

const issue = { command: 'ticket-create', reason: 'malformed', edge: 'leading' };
const rejection = { issues: [issue], message: TICKET_COMMAND_REJECTION_GUIDANCE };
const envelope = (body) => `<garcon-command-rejected>${escapeGarconXmlText(JSON.stringify(body))}</garcon-command-rejected>`;

describe('Garcon command rejection feedback', () => {
  test('round trips actionable guidance without inventing a mutation identity or command', () => {
    const content = garconCommandRejectionContent(rejection);
    expect(parseGarconCommandRejection(content)).toEqual(rejection);
    expect(extractGarconCommands(new AssistantMessage('2026-01-01T00:00:00.000Z', content))).toBeNull();
    expect(content).not.toContain('<T>');
    expect(rejection.message).toContain('serialize the JSON first');
    expect(rejection.message).toContain('independently valid commands may already have executed');
    expect(rejection.message).toContain('&& becomes &amp;&amp;');
    expect(content).not.toContain('ref=');
  });

  test('retains separate edge candidates even when both name the same command', () => {
    const grouped = { ...rejection, issues: [issue, { ...issue, edge: 'trailing' }] };
    expect(parseGarconCommandRejection(garconCommandRejectionContent(grouped))).toEqual(grouped);
  });

  test('only recognizes a complete, bounded, strictly typed envelope', () => {
    for (const invalid of [
      null, [], {}, { ...rejection, extra: true }, { ...rejection, issues: [] },
      { ...rejection, issues: [issue, issue, issue] },
      { ...rejection, issues: [{ ...issue, ref: 'not-a-request' }] },
      { ...rejection, issues: [{ ...issue, command: 'ticket-unknown' }] },
      { ...rejection, issues: [{ ...issue, edge: 'middle' }] },
      { ...rejection, issues: [{ ...issue, reason: 'failed' }] },
      { ...rejection, message: '' }, { ...rejection, message: 'x'.repeat(2049) },
      { ...rejection, message: '\ud800' },
    ]) expect(parseGarconCommandRejection(envelope(invalid))).toBeNull();
    const valid = garconCommandRejectionContent(rejection);
    for (const invalid of [`Prose.\n${valid}`, `${valid}\nProse.`, `\`\`\`xml\n${valid}\n\`\`\``,
      valid + valid, valid.replace('<garcon-command-rejected>', '<garcon-command-rejected ref="x">'),
      '<garcon-command-rejected />', '<garcon-command-rejected>{}</garcon-command-rejected>',
      `<garcon-command-rejected>${JSON.stringify(rejection)}</garcon-command-rejected>`,
    ]) expect(parseGarconCommandRejection(invalid)).toBeNull();
  });
});
