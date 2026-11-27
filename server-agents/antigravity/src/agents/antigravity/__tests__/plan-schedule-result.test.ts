import { expect, test } from 'bun:test';
import type { ChatMessage, ToolResultMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '@garcon/server-agent-common/search/message-projector';
import { session, textBlock } from './acp-tool-call-fixture.js';

const timer = { name: 'schedule', rawInput: { DurationSeconds: 1, Prompt: 'Check' } };
const image = { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } };

function assertToolResult(row: ChatMessage | undefined): asserts row is ToolResultMessage {
  if (row?.type !== 'tool-result') throw new Error('Expected a tool result');
}

test('shows a repeated terminal schedule diagnostic alongside metadata without promoting cached progress', () => {
  const s = session();
  const content = [textBlock('Could not save this schedule')];
  const started = { ...timer, content };
  const rawOutput = { attempts: 1 };
  s.start('reported', started);
  expect(s.patch('reported', { status: 'failed', content, rawOutput }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', raw: 'Could not save this schedule', rawOutput }, isError: true,
  }));
  s.start('cached', started);
  expect(s.patch('cached', { status: 'failed', rawOutput }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', items: content, rawOutput }, isError: true,
  }));
  const progress = { output: 'Preparing schedule', attempts: 1 };
  s.start('earlier-output', { ...started, rawOutput: progress });
  expect(s.patch('earlier-output', { status: 'failed', content }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', raw: 'Could not save this schedule', rawOutput: { attempts: 1 } }, isError: true,
  }));
});

test.each([
  ['schedule', timer.rawInput],
  ['enter_plan_mode', { Reason: 'Check' }],
  ['exit_plan_mode', { Plan: 'Check' }],
] as const)('prioritizes explicit terminal output for %s over intervening progress', (name, rawInput) => {
  const s = session();
  const rawOutput = { output: 'Operation refused' };
  const content = [textBlock('Checking limits')];
  s.start('call', { name, rawInput, rawOutput });
  s.patch('call', { content });
  expect(s.patch('call', { rawOutput, status: 'failed' }).at(-1)).toEqual(expect.objectContaining({
    content: { raw: 'Operation refused', status: 'failed' }, isError: true,
  }));
});

test('terminal output replaces cached narrative, retaining attachments and annotations on success or failure', () => {
  const annotated = { type: 'content', content: { type: 'text', text: 'Old annotated progress', priority: 1 } };
  for (const status of ['completed', 'failed']) {
    const s = session();
    s.start('timer', { name: 'schedule', rawInput: { DurationSeconds: 60, Prompt: 'Check' },
      content: [textBlock('Earlier progress'), image, annotated] });
    const row = s.patch('timer', { status, rawOutput: { output: 'Terminal report', attempts: 1 } }).at(-1);
    expect(row).toMatchObject({ content: { items: [image, { ...annotated, content: { ...annotated.content, text: '' } }],
      rawOutput: { output: 'Terminal report', attempts: 1 } } });
    expect(JSON.stringify(row)).not.toContain('progress');
  }
});

test('uses explicit completed schedule output before echoed progress and falls back to terminal blocks before cached data', () => {
  const s = session();
  const progress = [textBlock('Preparing')];
  const rawOutput = { output: 'Timer saved', id: 'job' };
  s.start('both', { ...timer, rawOutput });
  s.patch('both', { content: progress });
  expect(s.patch('both', { rawOutput, content: progress, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({
    content: { rawOutput, items: progress }, isError: false,
  }));
  const content = [textBlock('Timer saved')];
  s.start('text', { ...timer, content });
  expect(s.patch('text', { rawOutput: { id: 'job' }, content, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({
    content: { raw: 'Timer saved', rawOutput: { id: 'job' } }, isError: false,
  }));
});

test('retains every terminal block when a cached output is echoed alongside other text', () => {
  for (const rawOutput of [{ output: 'Operation refused' }, { output: 'Operation refused', attempts: 1 }]) {
    const s = session();
    const progress = textBlock('Checking limits');
    s.start('call', { ...timer, content: [progress] });
    s.patch('call', { rawOutput });
    const items = [progress, textBlock('Operation refused')];
    const row = s.patch('call', { status: 'failed', content: items }).at(-1);
    expect(row).toEqual(expect.objectContaining({ isError: true, primaryTextItems: [1], content: {
      items, status: 'failed', ...('attempts' in rawOutput ? { rawOutput: { attempts: 1 } } : {}),
    } }));
  }
});

test('publishes a large aggregate echo only once and keeps interleaved attachments in order', () => {
  const s = session();
  const timer = { name: 'schedule', rawInput: { DurationSeconds: 60, Prompt: 'Check' } };
  const first = 'x'.repeat(9 * 1024 * 1024);
  const output = first + '\nOperation refused';
  s.start('aggregate', { ...timer, rawOutput: { output, attempts: 1 } });
  const row = s.patch('aggregate', { status: 'failed', content: [textBlock(first), textBlock('Operation refused')] }).at(-1);
  assertToolResult(row);
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(output.length + 1024);
  expect(row.content.raw === output).toBe(true);
  expect(row.content.rawOutput).toEqual({ attempts: 1 });

  const content = [textBlock('Checking'), { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
    textBlock('Operation refused')];
  s.start('mixed', { ...timer, rawOutput: { output: 'Operation refused', attempts: 1 } });
  expect(s.patch('mixed', { status: 'failed', content }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', items: content, rawOutput: { attempts: 1 } },
  }));
});

test('references the explicit output within ordered blocks without repeating it', () => {
  const progress = 'Checking '.repeat(500);
  const content = [textBlock(progress), image, textBlock('Operation refused')];
  for (const [output, refs] of [
    ['Operation refused', [2]],
    [progress + '\nOperation refused', [0, 2]],
  ] as const) {
    const s = session();
    const row = s.start('timer', { name: 'schedule', rawInput: { DurationSeconds: 60, Prompt: 'Check' },
      status: 'failed', content, rawOutput: { output, attempts: 1 } }).at(-1);
    expect(row).toMatchObject({ type: 'tool-result', primaryTextItems: refs });
    assertToolResult(row);
    expect(row.content).toEqual({ items: content, status: 'failed', rawOutput: { attempts: 1 } });
  }
});

test('references terminal output echoed by one or all cached text blocks', () => {
  const progress = textBlock('Checking');
  const diagnostic = textBlock('Operation refused');
  const content = [progress, image, diagnostic];
  for (const [output, items, refs] of [
    ['Operation refused', [image, diagnostic], [1]],
    ['Checking\nOperation refused', content, [0, 2]],
  ] as const) {
    const s = session();
    s.start('timer', { ...timer, content });
    const row = s.patch('timer', { status: 'failed', rawOutput: { output, attempts: 1 } }).at(-1);
    assertToolResult(row);
    expect(row.content).toEqual({ items, status: 'failed', rawOutput: { attempts: 1 } });
    expect(row.primaryTextItems).toEqual(refs);
  }
});

test.each(['cached', 'terminal'])('keeps a terminal report at its unique run of whole %s blocks', source => {
  const s = session();
  const saved = { type: 'content', content: { type: 'text', text: '  Saved', annotations: { priority: 1 } } };
  const detail = textBlock('Job details  ');
  const blocks = [textBlock('Previously: Saved\nJob details were not confirmed.'), saved, image, detail, textBlock('Waiting')];
  s.start('timer', { ...timer,
    content: source === 'cached' ? blocks : undefined });
  const result = s.patch('timer', { status: 'completed', rawOutput: { output: 'Saved\nJob details', id: 'job' },
    content: source === 'terminal' ? blocks : undefined }).at(-1);
  assertToolResult(result);
  expect(result.content).toEqual({ items: source === 'cached' ? [saved, image, detail] : blocks, rawOutput: { id: 'job' } });
  expect(result.primaryTextItems).toEqual(source === 'cached' ? [0, 2] : [1, 3]);
});

test('ranks a cached diagnostic echoed by terminal blocks ahead of long progress', () => {
  const s = session();
  const diagnostic = 'Operation refused';
  const content = [textBlock('Checking '.repeat(600)), { type: 'image', data: 'AA==', mimeType: 'image/png' }, textBlock(diagnostic)];
  s.start('timer', { ...timer, rawOutput: { output: diagnostic } });
  const row = s.patch('timer', { status: 'failed', content }).at(-1);
  expect(row).toMatchObject({ type: 'tool-result', primaryTextItems: [2], content: { items: content } });
});

test('ranks newly reported terminal text ahead of an unchanged raw progress snapshot', () => {
  const s = session();
  const rawOutput = { output: 'Checking '.repeat(600), attempts: 1 };
  const content = [textBlock('Operation refused')];
  s.start('timer', { ...timer, rawOutput });
  const row = s.patch('timer', { status: 'failed', content, rawOutput }).at(-1);
  expect(row).toMatchObject({ type: 'tool-result', primaryTextItems: [0], content: { items: content, rawOutput } });
});

test('a textless terminal frame preserves the search priority of the latest cached report', () => {
  const progress = 'Checking '.repeat(600);
  const diagnostic = 'Operation refused';
  for (const frames of [
    [{ content: [textBlock(progress)] }, { rawOutput: { output: diagnostic } }, { content: [] }],
    [{ rawOutput: { output: progress } }, { content: [textBlock(diagnostic)] }, { rawOutput: { id: 'job' } }],
    [{ rawOutput: { output: progress } }, { content: [{ type: 'image', data: 'AA==' }, textBlock(diagnostic)] }, {}],
    [{ rawOutput: { output: progress } }, { content: [{ type: 'text', text: diagnostic }] }, {}],
    [{ rawOutput: { details: progress } }, { content: [{ type: 'text', text: diagnostic }] }, {}],
    [{ rawOutput: { output: progress }, content: [textBlock('Working'), textBlock(progress)] },
      { content: [textBlock(diagnostic), textBlock(progress)] }, {}],
    [{ rawOutput: { output: progress } }, { content: [textBlock(diagnostic)] },
      { rawOutput: { output: progress }, content: [textBlock(diagnostic)] }],
    [{ name: undefined, rawOutput: { output: progress } }, { content: [{ type: 'text', text: diagnostic }] }, { name: 'schedule' }],
  ] as const) {
    const s = session();
    s.start('timer', { ...timer, ...frames[0] });
    s.patch('timer', frames[1]);
    const row = s.patch('timer', { status: 'failed', ...frames[2] }).at(-1);
    assertToolResult(row);
    expect(projectSearchMessage(row)?.body).toContain(diagnostic);
  }
});

test('a replacement image keeps the exact cached report within the relay budget', () => {
  const s = session();
  const large = 'x'.repeat(9 * 1024 * 1024);
  const content = [textBlock('Status'), textBlock('   '), textBlock(large)];
  const image = { type: 'image', data: 'AA==' };
  s.start('timer', { ...timer,
    content: [...content, image], rawOutput: { output: 'Status\n   \n' + large } });
  const replacement = { ...image, data: 'AQ==' };
  const row = s.patch('timer', { status: 'completed', content: [replacement] }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: [...content, replacement] });
  expect(row.primaryTextItems).toEqual([0, 2]);
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(large.length + 1024);
});

test('the terminal attachment order wins without erasing uniquely aligned annotations', () => {
  const s = session();
  const annotated = { type: 'content', content: { type: 'text', text: 'Saved', annotations: { priority: 1 } } };
  const replacement = { type: 'image', data: 'AQ==' };
  s.start('timer', { ...timer, content: [annotated, image] });
  const row = s.patch('timer', { status: 'completed', rawOutput: { output: 'Saved' },
    content: [replacement, textBlock('Saved')] }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: [replacement, annotated] });
  expect(row.primaryTextItems).toEqual([1]);
});

test.each([false, true])('indexes the only report before large attachments (explicit terminal: %s)', explicit => {
  const s = session();
  const diagnostic = 'Operation refused';
  const content = [{ type: 'image', data: 'A'.repeat(5000) }, textBlock(diagnostic)];
  if (explicit) {
    s.start('timer', { ...timer, rawOutput: { output: diagnostic } });
    s.patch('timer', { content: [textBlock('Step 1')] });
    content.push(textBlock(diagnostic));
  } else {
    s.start('timer', { ...timer, content });
  }
  const row = s.patch('timer', { status: 'failed', ...(explicit ? { content } : {}) }).at(-1);
  assertToolResult(row);
  expect(row.content.items).toEqual(content);
  expect(row.primaryTextItems).toEqual(explicit ? [1, 2] : [1]);
  expect(projectSearchMessage(row)?.body).toStartWith(diagnostic);
});

test('indexes diagnostics by changed narrative rather than echo segmentation, metadata or blank blocks', () => {
  const progress = 'Checking '.repeat(600);
  const diagnostic = 'Operation refused';
  const multi = [textBlock(diagnostic), textBlock('Quota exhausted')];
  const old = { output: progress, attempts: 1 };
  for (const [name, before, middle, terminal] of [
    ['split echo', { rawOutput: { output: diagnostic + '\nQuota exhausted' } }, { content: [textBlock(progress), ...multi] }, {}],
    ['new diagnostic', { rawOutput: old, content: [textBlock(progress)] }, {}, { content: [textBlock(diagnostic), textBlock(progress)] }],
    ['ambiguous echo', { rawOutput: old, content: [textBlock(progress)] }, { content: [textBlock(progress), textBlock(diagnostic), textBlock(progress)] }, {}],
    ['changed metadata', { rawOutput: old }, { content: [textBlock(diagnostic)] }, { rawOutput: { ...old, attempts: 2 }, status: 'in_progress' }],
    ['added blank', { content: [textBlock(progress)] }, { rawOutput: { output: diagnostic } }, { content: [textBlock(progress), textBlock(' ')], status: 'in_progress' }],
  ] as const) {
    const s = session();
    s.start('timer', { ...timer, ...before });
    s.patch('timer', middle);
    const rows = s.patch('timer', { status: 'failed', ...terminal });
    const row = rows.at(-1) ?? s.patch('timer', { status: 'failed' }).at(-1);
    assertToolResult(row);
    expect(projectSearchMessage(row)?.body, name).toContain(diagnostic);
  }
});

test('retains both cached texts when terminal metadata occupies the output field', () => {
  for (const rawOutput of [{ output: null, id: 'job' }, ['job']]) {
    const s = session();
    s.start('timer', { ...timer, rawOutput: 'Earlier output' });
    const content = [textBlock('New report')];
    s.patch('timer', { content });
    const row = s.patch('timer', { status: 'failed', rawOutput }).at(-1);
    assertToolResult(row);
    expect(row.content).toEqual({ status: 'failed', raw: 'Earlier output', rawOutput, items: content });
    expect(projectSearchMessage(row)?.body).toStartWith('New report');
  }
});

test('changing only an echo does not reverse the search priority of a cached report', () => {
  const s = session();
  const progress = textBlock('Checking '.repeat(600));
  const output = 'Operation\nrefused';
  s.start('format', { ...timer, rawOutput: { output }, content: [progress, textBlock('Operation'), textBlock('refused')] });
  s.patch('format', { content: [progress, textBlock('Operation '), textBlock('refused')] });
  const formatted = s.patch('format', { status: 'failed' }).at(-1);
  assertToolResult(formatted);
  expect(formatted.primaryTextItems).toBeUndefined();
  expect(projectSearchMessage(formatted)?.body).toContain('refused');

  const echo = [textBlock('Operation'), textBlock('refused')];
  s.start('repeated', { ...timer, rawOutput: { output }, content: [progress, ...echo, ...echo] });
  s.patch('repeated', { content: [progress, textBlock('Operation '), echo[1], ...echo] });
  const repeated = s.patch('repeated', { status: 'failed' }).at(-1);
  assertToolResult(repeated);
  expect(repeated.primaryTextItems).toEqual([3, 4]);
  expect(projectSearchMessage(repeated)?.body).toContain('refused');

  s.start('append', { ...timer, rawOutput: progress.content.text });
  const diagnostic = textBlock('Operation refused');
  s.patch('append', { content: [diagnostic] });
  s.patch('append', { content: [progress, diagnostic] });
  const appended = s.patch('append', { status: 'failed' }).at(-1);
  assertToolResult(appended);
  expect(appended.primaryTextItems).toEqual([1]);
  expect(projectSearchMessage(appended)?.body).toStartWith('Operation refused');
});

test.each([true, false])('ambiguous multi-block echoes stay unassociated (independent text: %s)', withDiagnostic => {
  const s = session();
  const parts = ['Checking '.repeat(400), 'Waiting '.repeat(400)];
  const rawOutput = { output: parts.join('\n'), attempts: 1 };
  const echo = parts.map(textBlock);
  const content = [...echo, ...(withDiagnostic ? [textBlock('Operation refused')] : []), ...echo];
  s.start('timer', { ...timer, rawOutput, content: echo });
  s.patch('timer', { content });
  const row = s.patch('timer', { status: 'failed' }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ status: 'failed', rawOutput, items: content });
  expect(row.primaryTextItems).toEqual(withDiagnostic ? [2] : undefined);
  if (withDiagnostic) expect(projectSearchMessage(row)?.body).toStartWith('Operation refused');
});

test('excludes overlapping echoes from the independent report text', () => {
  const s = session();
  const line = textBlock('Checking');
  const rawOutput = { output: 'Checking\nChecking' };
  s.start('timer', { ...timer, rawOutput, content: [line, line] });
  const items = [line, line, line, textBlock('Operation refused')];
  const row = s.patch('timer', { status: 'failed', content: items, rawOutput }).at(-1);
  expect(row).toMatchObject({ primaryTextItems: [3], content: { items, rawOutput } });
});

test('aligns flat and wrapped report text and overlays matching empty annotations once', () => {
  const s = session();
  const first = { ...textBlock('First'), priority: 1 };
  const gap = { ...textBlock(''), annotations: { audience: ['user'] } };
  const image = { type: 'image', data: 'AA==' };
  const last = textBlock('Last');
  s.start('timer', { ...timer, content: [first, image, gap, last] });
  const row = s.patch('timer', { status: 'completed', content: [first.content, gap, last.content] }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: [first, image, gap, last] });
});

test('does not associate independent output with an ambiguous annotated echo', () => {
  const s = session();
  const content = [1, 2].map(priority => ({ ...textBlock('Saved'), priority }));
  s.start('timer', { ...timer, rawOutput: 'Saved', content });
  const row = s.patch('timer', { status: 'completed' }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: content, rawOutput: 'Saved' });
  expect(row.primaryTextItems).toBeUndefined();
});

test('retains annotation and image positions for uniquely aligned terminal text', () => {
  const s = session();
  const saved = { ...textBlock('Saved'), priority: 1 };
  const image = { type: 'image', data: 'AA==' };
  const detail = textBlock('Job ID');
  const blank = { ...textBlock(' '), priority: 2 };
  s.start('timer', { ...timer, content: [saved, image, detail] });
  const row = s.patch('timer', { status: 'completed', content: [textBlock('Saved'), detail, blank] }).at(-1);
  assertToolResult(row);
  expect(row.content.items).toEqual([saved, image, detail, blank]);
});

test('overlays independent ACP annotations and counts an echoed whitespace block once', () => {
  const s = session();
  const first = { ...textBlock('Saved'), annotations: { audience: ['user'], priority: 1 } };
  const gap = { ...textBlock('   '), priority: 1 };
  const detail = textBlock('Details');
  const image = { type: 'image', data: 'AA==' };
  s.start('timer', { ...timer, content: [first, gap, detail, image] });
  const row = s.patch('timer', { status: 'completed', rawOutput: { output: 'Saved\n   \nDetails' },
    content: [{ ...first, annotations: { lastModified: 'now', priority: 2 } }, textBlock('   '), detail] }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: [{ ...first, annotations: { audience: ['user'], priority: 2, lastModified: 'now' } }, gap, detail, image] });
  expect(row.primaryTextItems).toEqual([0, 2]);
});

test.each(['Saved', ' '])('retains superseded annotation metadata with an annotated terminal report (%j)', text => {
  const s = session();
  const old = { ...textBlock('Old progress'), priority: 1 };
  const terminal = { ...textBlock(text), priority: 2 };
  s.start('timer', { ...timer, content: [old] });
  const row = s.patch('timer', { status: 'completed', rawOutput: { output: 'Saved' }, content: [terminal] }).at(-1);
  assertToolResult(row);
  expect(row.content.items).toEqual([{ ...textBlock(''), priority: 1 }, terminal]);
});

test('falls back to cached text when terminal fields are explicitly blank', () => {
  for (const content of [[], [textBlock(' \t')]]) {
    const s = session();
    s.start('blocks', { ...timer, content: [textBlock('Only report')] });
    expect(s.patch('blocks', { status: 'completed', content }).at(-1)).toMatchObject({ content: { raw: 'Only report' } });
    s.start('raw', { ...timer, rawOutput: { output: 'Only report', attempts: 1 } });
    expect(s.patch('raw', { status: 'failed', content, rawOutput: { output: ' ', id: 'job' } }).at(-1))
      .toMatchObject({ content: { status: 'failed', rawOutput: { output: 'Only report', attempts: 1, id: 'job' } } });
  }
});

test('keeps flat content in item form without declaring whitespace as primary text', () => {
  const content = [{ type: 'text', text: ' \n' }, { type: 'text', text: 'Saved' }];
  const row = session().start('flat', { ...timer, status: 'completed', content }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: content });
  expect(row.primaryTextItems).toEqual([1]);
});

test('terminal text replaces progress without erasing cached attachments or independent metadata', () => {
  const s = session();
  const saved = textBlock('Done');
  s.start('timer', { ...timer,
    content: [textBlock('Preparing'), image], rawOutput: { output: 'Checking', attempts: 1 } });
  const row = s.patch('timer', { status: 'completed', content: [saved], rawOutput: { id: 'job' } }).at(-1);
  assertToolResult(row);
  expect(row.content).toEqual({ items: [image, saved], rawOutput: { attempts: 1, id: 'job' } });
  expect(row.primaryTextItems).toEqual([1]);
});

test.each(['Saved', ' '])('keeps cached images when terminal text carries annotations (%j)', text => {
  const s = session();
  const cached = textBlock('Cached report');
  const annotated = { ...textBlock(text), annotations: { priority: 1 } };
  s.start('timer', { ...timer, content: [cached, image] });
  const row = s.patch('timer', { status: 'completed', content: [annotated] }).at(-1);
  assertToolResult(row);
  expect(row.content.items).toEqual(text.trim() ? [image, annotated] : [cached, image, annotated]);
  expect(row.primaryTextItems).toEqual(text.trim() ? [1] : [0]);
});
