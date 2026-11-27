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

test('frames a batch before interpreting the multiline bodies inside it', () => {
  const report = '<garcon-workflow-emit signal="report" content-type="text">\r\nFirst.\r\n\r\nSecond.\r\n</garcon-workflow-emit>';
  expect(workflowSignalCandidates(`\n${report}\r\n \r\n${emit}\n`)).toEqual([
    { kind: 'emit', name: 'report', payload: { contentType: 'text', text: 'First.\r\n\r\nSecond.' } },
    { kind: 'emit', name: 'research.finding_ready', payload: { contentType: 'json', text: '{"finding_id":"f1"}' } },
  ]);
});

test('counts leading blank lines against the byte limit without treating indented examples as emits', () => {
  const oversized = '\t\r\n' + emit.padEnd(65_536);
  expect(workflowSignalCandidates(oversized)).toEqual([{ kind: 'invalid', reason: 'Workflow emit message is too large.' }]);
  expect(workflowSignalCandidates('    ' + oversized.trimStart())).toEqual([]);
  expect(workflowSignalCandidates('Example:\n' + oversized)).toEqual([]);
});

test('rejects ambiguous raw emit delimiters without publishing partial text', () => {
  const start = '<garcon-workflow-emit signal="report">';
  const close = '</garcon-workflow-emit>';
  for (const content of [start + 'First.\n\n' + emit, start + 'First ' + close + ' second.' + close]) {
    expect(workflowSignalCandidates(content)).toEqual([{ kind: 'invalid', reason: expect.any(String) }]);
  }
  expect(workflowSignalCandidates(start + '<garcon-workflow-emit-example>' + close)).toEqual([
    { kind: 'emit', name: 'report', payload: { contentType: null, text: '<garcon-workflow-emit-example>' } },
  ]);
});

test('a nested opener invalidates the entire batch, including apparent siblings', () => {
  const start = '<garcon-workflow-emit signal="outer"';
  const done = '<garcon-workflow-emit signal="done" />';
  for (const malformed of [start + '>\n' + emit, start + ' ' + done]) {
    expect(workflowSignalCandidates([done, malformed, done].join('\n\n'))).toEqual([
      { kind: 'invalid', reason: expect.any(String) },
    ]);
  }
});

test.each([
  `> ${emit}`, `\`${emit}\``, `"${emit}"`, `    ${emit}`, `\\${emit}`,
  `~~~xml\n${emit}\n~~~`, `~~~xml\n${emit}`, `<!--\n${emit}\n-->`,
  `<blockquote>\n\n${emit}\n\n</blockquote>`, `- Example\n\n  ${emit}`,
  `Example:\n\n${emit}`, `<garcon-other>\n\n${emit}\n\n</garcon-other>`,
  `${emit} was the first example.\n\n${emit}`, `${emit}\n\n${emit}\nThese were examples.`,
  `${emit}\n${emit}`, `${emit}\n\n  ${emit}`,
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
