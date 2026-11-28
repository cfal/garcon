import { expect, test } from 'bun:test';
import { parseChatRowJson } from './chat-row-json.ts';

function body(fields: string) {
  return String.raw`{"clientRequestId":"request","clientMessageId":"message",
    "chatId":"1000000000000001","transcriptViewId":"view","presentation":{"style":"notice"},
    "format":"plain","disclosure":"expanded",${fields}}`;
}

test('rejects an unpaired title before any single-line check', () => {
  expect(() => parseChatRowJson(body(String.raw`"title":"\ud800\nsecond","content":"\ufffd"`)))
    .toThrow('title must contain well-formed Unicode');
});

test('rejects unpaired content with a genuinely well-formed replacement-character title', () => {
  expect(() => parseChatRowJson(body(String.raw`"title":"\ufffd","content":"\udc00"`)))
    .toThrow('content must contain well-formed Unicode');
});

test('validates title before content when both are unpaired', () => {
  expect(() => parseChatRowJson(body(String.raw`"title":"\ud800","content":"\udc00"`)))
    .toThrow('title must contain well-formed Unicode');
});

test('accepts genuine replacement characters with an unpaired surrogate in an ignored field', () => {
  expect(parseChatRowJson(body(String.raw`"title":"\ufffd","content":"\ufffd","ignored":"\ud800"`)))
    .toMatchObject({ title: '\ufffd', content: '\ufffd' });
});

test('checks only the last title and content values as JSON.parse does', () => {
  expect(parseChatRowJson(body(String.raw`"title":"\ud800","title":"\ufffd","content":"\udc00","content":"\ufffd"`)))
    .toMatchObject({ title: '\ufffd', content: '\ufffd' });
});
