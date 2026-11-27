import { expect, test } from 'bun:test';
import { AntigravityEnterPlanModeToolUseMessage, AntigravityExitPlanModeToolUseMessage, ScheduleToolUseMessage, UserMessage } from '../../../../../common/chat-types.js';
import { createCarryoverTranscript } from '../../../../../common/transcript-seed.js';
import { renderTranscriptExportMarkdown } from '../../transcript-export/markdown.js';
import { renderTranscriptExportXml } from '../../transcript-export/xml.js';
import { redactDataUrl, xmlText } from '../../transcript-export/values.js';
import { foldHandoffArtifactEntries } from '../projection.js';
import { renderFittedHandoffArtifact } from '../xml.js';

const timer = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 120, prompt: 'a\n'.repeat(100) });

test('omits the quoted prompt as a unit when the final artifact budget cannot hold it', () => {
  const sourceFold = foldHandoffArtifactEntries([
    { kind: 'message', ordinal: 1, category: 'conversation', message: new UserMessage('', 'Synthetic request. '.repeat(220)) },
    { kind: 'message', ordinal: 2, category: 'tool-calls', message: timer },
  ]);
  const input = { chat: { id: '1795690000000000', agentId: 'claude', model: 'synthetic', title: 'x'.repeat(3081) },
    sourceFold, lastOrdinal: 2, transcriptViewId: 'synthetic-view' };
  const small = renderFittedHandoffArtifact({ ...input, contextWindowTokens: 1024 });
  expect(small?.abridgedEntryCount).toBe(1);
  expect(small?.document).toContain('<text>Request wakeup in 2 minutes Prompt:...</text>');
  const large = renderFittedHandoffArtifact({ ...input, contextWindowTokens: 8192 });
  expect(large?.document).toMatch(/Prompt: "a\\n.*"\.\.\.<\/text>/);
});

test('applies the same literal boundary to the final carryover fit', () => {
  const full = createCarryoverTranscript([timer], 0)!.prefix;
  expect(full).toContain('Prompt: "a\\n');
  const fitted = createCarryoverTranscript([timer], full.length - 50)!.prefix;
  expect(fitted).toContain('Request wakeup in 2 minutes Prompt:...</tool-use>');
});

test('redacts a data URL before quoting its prompt, without consuming a literal quote or disclosing the payload', () => {
  const prompt = 'data:text/plain,fixture" and continue';
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const sourceFold = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message }]);
  const entry = sourceFold.entries[0];
  const header = 'Request wakeup in 1 second Prompt: ';
  expect(entry.abridged).toBe(true);
  expect(JSON.parse(entry.body!.slice(header.length))).toBe('[data URL omitted from export]" and continue');
  expect(createCarryoverTranscript([message], 0)?.prefix).toContain(JSON.stringify(prompt));
});

test.each([
  ['data:text/plain,PUBLIC)SYNTHETIC_PAYLOAD', '[data URL omitted from export]'],
  ['Review data:text/plain,PUBLIC)SYNTHETIC_PAYLOAD next', 'Review [data URL omitted from export] next'],
  ['Read data:text/plain;name=report%20notes.txt,SYNTHETIC_BODY then continue', 'Read [data URL omitted from export] then continue'],
  ['Attached (see data:text/plain,body). Continue.', 'Attached (see [data URL omitted from export]). Continue.'],
  ['See [one](data:text/plain,fixture)[two](https://example.test).', 'See [one]([data URL omitted from export])[two](https://example.test).'],
  ['See [report](data:text/plain,PUBLIC)SYNTHETIC_PAYLOAD).', 'See [report]([data URL omitted from export]).'],
  ["See [one](data:text/plain,prefix'SYNTHETIC_BODY).", 'See [one]([data URL omitted from export]).'],
  ['[one]( data:text/plain,fixture)[two](https://example.test)', '[one]( [data URL omitted from export])[two](https://example.test)'],
  ['![preview](data:image/png;base64,AA==)after', '![preview]([data URL omitted from export])after'],
  ['[one](data:text/plain,part(inner))after', '[one]([data URL omitted from export])after'],
  ['[review](data:text/plain,part(inner)[tag](value)BODY)', '[review]([data URL omitted from export])'],
  ['[review](<data:text/plain,prefix BODY>)', '[review](<[data URL omitted from export]>)'],
  ['[review](data:text/plain,prefix\u00a0BODY)', '[review]([data URL omitted from export])'],
  ['([one](data:text/plain,x)) and data:text/plain,body)', '([one]([data URL omitted from export])) and [data URL omitted from export]'],
  ['[one](data:text/plain,x),[two](https://x.test)[three](https://y.test)', '[one]([data URL omitted from export]),[two](https://x.test)[three](https://y.test)'],
  ['[one](data:text/plain,x)(note)[two](https://x.test)', '[one]([data URL omitted from export])(note)[two](https://x.test)'],
  ['[one](data:nocomma);[two](https://x.test/a,b)[three](https://y.test)', '[one](data:nocomma);[two](https://x.test/a,b)[three](https://y.test)'],
  ['[ref]: data:text/plain,PUBLIC)PAYLOAD', '[ref]: [data URL omitted from export]'],
  ['[ref]: data:image/svg+xml,<svg>BODY</svg> "Title"', '[ref]: [data URL omitted from export] "Title"'],
  ['[ref]: data:image/png;base64,AA==\u00a0BODY', '[ref]: [data URL omitted from export]'],
  ['Literal [sample\\](data:,x("Keep this"))', 'Literal [sample\\]([data URL omitted from export]"Keep this"))'],
  ['items[0]: data:text/plain,PUBLIC)PAYLOAD', 'items[0]: [data URL omitted from export]'],
  ['Received data:0x12,0x34.', 'Received data:0x12,0x34.'],
  ['Return `data:${mimeType};base64,${base64}` unchanged.', 'Return `data:${mimeType};base64,${base64}` unchanged.'],
])('redacts the complete data URL token in %s', (prompt, redacted) => {
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const entries = [{ kind: 'message', ordinal: 1, category: 'tool-calls', message }] as const;
  const fold = foldHandoffArtifactEntries(entries);
  expect(fold.entries[0].body).toEndWith('Prompt: ' + JSON.stringify(redacted));
  const model = {
    chat: { id: '1795690000000000', title: 'Fixture', agentId: 'antigravity', model: null }, omitted: [], entries,
  } as const;
  expect(renderTranscriptExportXml(model)).toContain(xmlText(JSON.stringify(redacted)));
  expect(renderTranscriptExportMarkdown(model)).toContain(JSON.stringify(redacted));
  expect(createCarryoverTranscript([message], 0)?.prefix).toContain(xmlText(JSON.stringify(prompt)));
});

test('bounds failed data URL destination scans on a long malformed field', () => {
  const start = performance.now();
  for (const fragment of ['\\<data:, ', '[x]:data:,"', '[x](data:,("']) {
    const value = fragment.repeat(20_000) + '(';
    expect(redactDataUrl(value)).not.toContain('data:,');
  }
  expect(performance.now() - start).toBeLessThan(1500);
});

test('redacts the complete destination before fitting a long prompt', () => {
  const prompt = '[file](<data:text/plain,first BODY' + ' secret'.repeat(150) + '>) done';
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const { entries: [entry] } = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message }]);
  expect(entry.body).toEndWith('Prompt: "[file](<[data URL omitted from export]>) done"');
  const option = new ScheduleToolUseMessage('', 'cron', { action: 'cron', expression: prompt, prompt: 'Check' });
  const fold = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message: option }]);
  expect(fold.entries[0].body).toBe('Request cron: [file](<[data URL omitted from export]>) done Prompt: "Check"');
  for (const plan of [new AntigravityEnterPlanModeToolUseMessage('', 'plan', prompt), new AntigravityExitPlanModeToolUseMessage('', 'plan', prompt)]) {
    const { entries: [entry] } = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message: plan }]);
    expect(entry.body).toBe('[file](<[data URL omitted from export]>) done');
    expect(entry.abridged).toBe(true);
    expect(createCarryoverTranscript([plan], 0)?.prefix).toContain('first BODY');
  }
});

test.each(['data:x\n," Then continue.', 'see data:a\t,"b'])('does not reinterpret JSON escapes as URL content', prompt => {
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const { entries: [entry] } = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message }]);
  expect(JSON.parse(entry.body!.slice(entry.prefixBeforeLiteral!.length))).toBe(prompt);
});

test('blank plan transitions do not spend handoff space on an empty text element', () => {
  for (const message of [new AntigravityEnterPlanModeToolUseMessage('', 'plan', ''), new AntigravityExitPlanModeToolUseMessage('', 'plan', ' \n')]) {
    const { entries: [entry] } = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message }]);
    expect(entry.body).toBeNull();
  }
});
