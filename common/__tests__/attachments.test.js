import { expect, test } from 'bun:test';
import {
  ANY_FILE_ATTACHMENT_MIME_TYPE,
  acceptsFileAttachmentMimeType,
  chatAttachmentMimeType,
  isImageAttachmentMimeType,
} from '../attachments.js';

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

test('prefers a known extension over the browser type and keeps the declared type otherwise', () => {
  expect(chatAttachmentMimeType({ name: 'table.csv', type: 'application/vnd.ms-excel' })).toBe('text/csv');
  expect(chatAttachmentMimeType({ name: 'budget.xlsx', type: '' }))
    .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(chatAttachmentMimeType({ name: 'slides.key', type: 'application/x-iwork-keynote-sffkey' }))
    .toBe('application/x-iwork-keynote-sffkey');
  expect(chatAttachmentMimeType({ name: 'payload', type: '' })).toBe('application/octet-stream');
});

test('treats only natively supported image types as images', () => {
  expect(isImageAttachmentMimeType('image/png')).toBe(true);
  expect(isImageAttachmentMimeType('image/heic')).toBe(false);
});

test('accepts every file type for any-file agents and only listed types otherwise', () => {
  expect(acceptsFileAttachmentMimeType(ANY_FILE_ATTACHMENT_MIME_TYPE, 'application/zip')).toBe(true);
  expect(acceptsFileAttachmentMimeType(['text/csv'], 'TEXT/CSV')).toBe(true);
  expect(acceptsFileAttachmentMimeType(['text/csv'], 'application/zip')).toBe(false);
});
