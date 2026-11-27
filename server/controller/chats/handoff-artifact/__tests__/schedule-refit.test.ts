import { expect, test } from 'bun:test';
import { ScheduleToolUseMessage, UserMessage } from '../../../../../common/chat-types.js';
import { createCarryoverTranscript } from '../../../../../common/transcript-seed.js';
import { renderTranscriptExportXml } from '../../transcript-export/xml.js';
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
])('redacts the complete data URL token in %s', (prompt, redacted) => {
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const entries = [{ kind: 'message', ordinal: 1, category: 'tool-calls', message }] as const;
  const fold = foldHandoffArtifactEntries(entries);
  expect(fold.entries[0].body).toEndWith('Prompt: ' + JSON.stringify(redacted));
  expect(renderTranscriptExportXml({
    chat: { id: '1795690000000000', title: 'Fixture', agentId: 'antigravity', model: null }, omitted: [], entries,
  })).toContain(JSON.stringify(redacted));
  expect(createCarryoverTranscript([message], 0)?.prefix).toContain(prompt);
});

test.each(['data:x\n," Then continue.', 'see data:a\t,"b'])('does not reinterpret JSON escapes as URL content', prompt => {
  const message = new ScheduleToolUseMessage('', 'timer', { action: 'wakeup', delaySeconds: 1, prompt });
  const { entries: [entry] } = foldHandoffArtifactEntries([{ kind: 'message', ordinal: 1, category: 'tool-calls', message }]);
  expect(JSON.parse(entry.body!.slice(entry.prefixBeforeLiteral!.length))).toBe(prompt);
});
