import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { terminalBody, terminalLine } from '../terminal-output.js';
import { formatTextTable } from '../text-table.js';
import { formatTranscriptMessage } from '../transcript-message-format.js';
import { buildChatCatalogResult, formatChatCatalogResult } from '../chat-catalog.js';
import { createCliOutput } from '../output.js';
import { runRename } from '../chat-metadata.js';
import { chat, chatList, CHAT_ID, TS } from './chat-research-fixtures.js';

const unsafe = 'Synthetic\x1b[2J\x1b]52;c;YWJj\x07\u009b\u202e\u2066';

test('escapes terminal controls while preserving multiline body whitespace', () => {
  expect(terminalLine(unsafe)).not.toMatch(/[\x1b\x07\u009b\u202e\u2066]/u);
  expect(terminalLine('a\nb\tc')).toBe('a\\u000ab\\u0009c');
  expect(terminalBody('a\nb\tc')).toBe('a\nb\tc');
  expect(formatTextTable(['TITLE'], [[unsafe]])).toContain(terminalLine(unsafe));
  expect(formatTranscriptMessage({ ordinal: 1, message: new AssistantMessage(TS, unsafe) }))
    .toContain(terminalBody(unsafe));
});

test('chat lists and rename receipts escape human output but preserve JSON', async () => {
  const result = buildChatCatalogResult({ filter: '', offset: 0, limit: 20 }, chatList([chat({ title: unsafe })]));
  expect(formatChatCatalogResult(result, false)).toContain(terminalLine(unsafe));
  expect(JSON.parse(formatChatCatalogResult(result, true)).chats[0].title).toBe(unsafe);
  let stdout = '';
  const output = createCliOutput({ write(chunk) { stdout += chunk; } });
  const client = { async updateChatTitle() { return { success: true as const, chatId: CHAT_ID, title: unsafe, changed: true }; },
    async setChatPinned() { throw new Error('unused'); }, async setChatArchived() { throw new Error('unused'); },
    async setChatTags() { throw new Error('unused'); } };
  await runRename({ kind: 'rename', chatId: CHAT_ID, title: unsafe, json: false, configDir: '/config', runtime: 'controller' }, client, output);
  expect(stdout).toContain(terminalLine(unsafe));
});

test.each([false, true])('TTY=%s final output respects machine-output contracts', (isTTY) => {
  const chunks: string[] = [];
  const diagnostics: string[] = [];
  const output = createCliOutput({ isTTY, write(chunk) { chunks.push(chunk); } }, { write(chunk) { diagnostics.push(chunk); } });
  output.completed(unsafe);
  output.document(unsafe);
  output.result(JSON.stringify({ title: unsafe }));
  output.diagnostic(unsafe);
  expect(chunks[0]).toBe(`${isTTY ? terminalBody(unsafe) : unsafe}\n`);
  expect(chunks[1]).toBe(unsafe);
  expect(JSON.parse(chunks[2]!).title).toBe(unsafe);
  expect(diagnostics[0]).toBe(`${terminalBody(unsafe)}\n`);
});
