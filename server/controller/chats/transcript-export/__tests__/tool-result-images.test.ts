import { expect, test } from 'bun:test';
import { ToolResultMessage } from '@garcon/common/chat-types';
import { renderTranscriptExportMarkdown } from '../markdown.js';
import { renderTranscriptExportXml } from '../xml.js';

test('ordinary exports omit inline image bytes without losing the ordered result', () => {
  const data = 'Zml4dHVyZQ==';
  const content = { items: [
    { type: 'text', text: 'Before image' },
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
    { type: 'image', data },
    { type: 'content', content: { type: 'resource', resource: { uri: 'fixture:preview', mimeType: 'image/png', blob: data } } },
    { type: 'text', text: 'After image' },
  ] };
  const message = new ToolResultMessage('', 'schedule', content, false);
  for (const render of [renderTranscriptExportMarkdown, renderTranscriptExportXml]) {
    const document = render({ chat: { id: '1795690000000000', title: 'Fixture', agentId: 'antigravity', model: null },
      omitted: [], entries: [{ kind: 'message', category: 'tool-results', ordinal: 1, message }] });
    expect(document).not.toContain(data);
    expect(document).toContain('image/png');
    expect(document).toContain('fixture:preview');
    expect(document).toMatch(/Before image.*\[image body omitted from export\].*After image/s);
  }
  expect(content.items[1].content?.data).toBe(data);
});
