import { describe, expect, test } from 'bun:test';
import { AssistantMessage } from '../chat-types.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { escapeGarconXmlText, GARCON_ENVELOPE_COMMANDS } from '../garcon-command-envelope.js';
import { garconCommandRejectionContent, parseGarconCommandRejection, TICKET_COMMAND_REJECTION_GUIDANCE } from '../garcon-command-rejection.js';

const issue = { command: 'ticket-create', reason: 'malformed', edge: 'leading' };
const rejection = { issues: [issue], message: TICKET_COMMAND_REJECTION_GUIDANCE };
const envelope = (body) => `<garcon-command-rejected>${escapeGarconXmlText(JSON.stringify(body))}</garcon-command-rejected>`;
const validEnvelope = garconCommandRejectionContent(rejection);

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

  test.each(GARCON_ENVELOPE_COMMANDS)('recognizes the %s command without changing issue fields', (command) => {
    const expected = { ...rejection, issues: [{ ...issue, command }] };
    expect(parseGarconCommandRejection(envelope(expected))).toEqual(expected);
  });

  test.each([
    ['ASCII byte limit', 'x'.repeat(2048)],
    ['multibyte byte limit', '\u00e9'.repeat(1024)],
    ['surrounding whitespace', ' Guidance. '],
  ])('preserves a valid message at %s', (_name, message) => {
    const expected = { ...rejection, message };
    expect(parseGarconCommandRejection(envelope(expected))).toEqual(expected);
  });

  test.each([
    ['null payload', null],
    ['array payload', []],
    ['missing fields', {}],
    ['unknown payload field', { ...rejection, extra: true }],
    ['missing issues', { message: rejection.message }],
    ['non-array issues', { ...rejection, issues: issue }],
    ['empty issues', { ...rejection, issues: [] }],
    ['too many issues', { ...rejection, issues: [issue, issue, issue] }],
    ['null issue', { ...rejection, issues: [null] }],
    ['array issue', { ...rejection, issues: [[]] }],
    ['missing issue fields', { ...rejection, issues: [{}] }],
    ['unknown issue field', { ...rejection, issues: [{ ...issue, ref: 'not-a-request' }] }],
    ['unknown command', { ...rejection, issues: [{ ...issue, command: 'ticket-unknown' }] }],
    ['non-string command', { ...rejection, issues: [{ ...issue, command: ['ticket-create'] }] }],
    ['invalid edge', { ...rejection, issues: [{ ...issue, edge: 'middle' }] }],
    ['invalid reason', { ...rejection, issues: [{ ...issue, reason: 'failed' }] }],
    ['missing message', { issues: rejection.issues }],
    ['non-string message', { ...rejection, message: 1 }],
    ['empty message', { ...rejection, message: '' }],
    ['whitespace-only message', { ...rejection, message: ' \n\t' }],
    ['oversized ASCII message', { ...rejection, message: 'x'.repeat(2049) }],
    ['oversized multibyte message', { ...rejection, message: '\u00e9'.repeat(1025) }],
    ['malformed Unicode message', { ...rejection, message: '\ud800' }],
  ])('rejects %s', (_name, invalid) => {
    expect(parseGarconCommandRejection(envelope(invalid))).toBeNull();
  });

  test.each([
    ['leading prose', `Prose.\n${validEnvelope}`],
    ['trailing prose', `${validEnvelope}\nProse.`],
    ['fenced example', `\`\`\`xml\n${validEnvelope}\n\`\`\``],
    ['adjacent envelopes', validEnvelope + validEnvelope],
    ['unknown attribute', validEnvelope.replace('<garcon-command-rejected>', '<garcon-command-rejected ref="x">')],
    ['self-closing envelope', '<garcon-command-rejected />'],
    ['empty payload', '<garcon-command-rejected>{}</garcon-command-rejected>'],
    ['invalid JSON', '<garcon-command-rejected>{</garcon-command-rejected>'],
    ['unescaped body', `<garcon-command-rejected>${JSON.stringify(rejection)}</garcon-command-rejected>`],
  ])('rejects %s', (_name, invalid) => {
    expect(parseGarconCommandRejection(invalid)).toBeNull();
  });
});
