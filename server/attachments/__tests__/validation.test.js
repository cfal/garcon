import { describe, expect, it } from 'bun:test';
import {
  MAX_ATTACHMENT_FILE_BYTES,
  validateCommandAttachments,
} from '../validation.ts';

function dataUrl(mimeType, content) {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

describe('attachment validation', () => {
  it('normalizes browser data URLs that rely on a declared filename-derived MIME type', () => {
    const attachments = validateCommandAttachments([{
      data: `data:;base64,${Buffer.from('# Notes').toString('base64')}`,
      name: 'notes.md',
      mimeType: 'text/markdown',
    }]);

    expect(attachments).toEqual([{
      data: dataUrl('text/markdown', '# Notes'),
      name: 'notes.md',
      mimeType: 'text/markdown',
    }]);
  });

  it('rejects unsupported direct-send attachment MIME types', () => {
    expect(() => validateCommandAttachments([{
      data: dataUrl('application/octet-stream', 'binary'),
      name: 'payload.bin',
      mimeType: 'application/octet-stream',
    }])).toThrow('Invalid file type. Only images, Markdown, text, and PDF files are allowed.');
  });

  it('rejects mismatched direct-send MIME declarations', () => {
    expect(() => validateCommandAttachments([{
      data: dataUrl('text/plain', 'hello'),
      name: 'hello.md',
      mimeType: 'text/markdown',
    }])).toThrow('Attachment MIME type does not match its data URL.');
  });

  it('rejects direct-send attachments over the per-file cap', () => {
    const data = `data:text/plain;base64,${Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES + 1).toString('base64')}`;

    expect(() => validateCommandAttachments([{ data, name: 'huge.txt', mimeType: 'text/plain' }]))
      .toThrow('File too large. Maximum file size is 10MB.');
  });
});
