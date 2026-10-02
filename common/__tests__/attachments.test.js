import { expect, test } from 'bun:test';
import { chatAttachmentMimeType } from '../attachments.js';

test.each([
  ['clip.mov', 'video/quicktime'],
  ['clip.mkv', 'video/x-matroska'],
  ['clip.m4v', 'video/mp4'],
  ['clip.mp4', 'video/mp4'],
  ['clip.WEBM', 'video/webm'],
])('infers video MIME from %s when the browser supplies no specific type', (name, expected) => {
  for (const type of [undefined, null, '', 'application/octet-stream']) {
    expect(chatAttachmentMimeType({ name, type })).toBe(expected);
  }
});
