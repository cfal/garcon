import { expect, test } from 'bun:test';
import { workflowSignalCandidates } from '../signal-envelope.js';

const emit = '<garcon-workflow-emit signal="research.finding_ready" content-type="json">{"finding_id":"f1"}</garcon-workflow-emit>';

test('accepts only standalone envelopes and preserves unspecified payload text', () => {
  expect(workflowSignalCandidates(`${emit}\n\n<garcon-workflow-emit signal="done" />`)).toEqual([
    { kind: 'emit', name: 'research.finding_ready', payload: { contentType: 'json', text: '{"finding_id":"f1"}' } },
    { kind: 'emit', name: 'done', payload: { contentType: null, text: '' } },
  ]);
  expect(workflowSignalCandidates('<garcon-workflow-emit signal="report">\nA & B < C\n\nAnother paragraph.\n</garcon-workflow-emit>')).toEqual([
    { kind: 'emit', name: 'report', payload: { contentType: null, text: 'A & B < C\n\nAnother paragraph.' } },
  ]);
});

test.each([
  `> ${emit}`, `\`${emit}\``, `"${emit}"`, `    ${emit}`, `\\${emit}`,
  `~~~xml\n${emit}\n~~~`, `~~~xml\n${emit}`, `<!--\n${emit}\n-->`,
  `<blockquote>\n\n${emit}\n\n</blockquote>`, `- Example\n\n  ${emit}`,
  `Example:\n\n${emit}`, `<garcon-other>\n\n${emit}\n\n</garcon-other>`,
])('keeps quotation or snippet inert: %s', content => {
  expect(workflowSignalCandidates(content)).toEqual([]);
});

test.each([
  '<garcon-workflow-emit name="old" format="json" />',
  '<garcon-workflow-emit signal="test" signal="again" />',
  '<garcon-workflow-emit signal="test" content-type="xml" />',
  '<garcon-workflow-emit signal="test" content-type="none">a value</garcon-workflow-emit>',
  '<garcon-workflow-emit signal="open">',
  `<garcon-workflow-emit signal="large">${'x'.repeat(65_536)}</garcon-workflow-emit>`,
])('reports malformed standalone emit without an actionable payload', content => {
  expect(workflowSignalCandidates(content)).toEqual([{ kind: 'invalid', reason: expect.any(String) }]);
});
