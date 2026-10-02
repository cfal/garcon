import { describe, expect, it } from 'bun:test';
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_VIDEO_ATTACHMENT_FILE_BYTES,
  validateCommandAttachments,
} from '../validation.ts';

function dataUrl(mimeType, content) {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

describe('attachment validation', () => {
  it('accepts common browser video formats and canonicalizes MIME aliases', () => {
    for (const [name, type, mimeType] of [
      ['clip.mp4', 'video/mp4', 'video/mp4'],
      ['clip.mov', 'video/quicktime', 'video/quicktime'],
      ['clip.webm', 'video/webm', 'video/webm'],
      ['clip.mkv', 'video/matroska', 'video/x-matroska'],
      ['clip.m4v', 'video/x-m4v', 'video/mp4'],
    ]) {
      expect(validateCommandAttachments([{ name, data: dataUrl(type, 'video') }])[0].mimeType).toBe(mimeType);
    }
  });

  it('applies the 25MB video cap while retaining the 10MB document cap', () => {
    expect(() => validateCommandAttachments([
      { name: 'clip.mp4', data: dataUrl('video/mp4', Buffer.alloc(MAX_VIDEO_ATTACHMENT_FILE_BYTES)) },
    ])).not.toThrow();
    expect(() => validateCommandAttachments([
      { name: 'huge.txt', data: dataUrl('text/plain', Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES + 1)) },
    ])).toThrow('File too large. Maximum file size is 10MB.');
    expect(() => validateCommandAttachments([
      { name: 'huge.mp4', data: dataUrl('video/mp4', Buffer.alloc(MAX_VIDEO_ATTACHMENT_FILE_BYTES + 1)) },
    ])).toThrow('File too large. Maximum file size is 25MB.');
    expect(MAX_VIDEO_ATTACHMENT_FILE_BYTES).toBe(MAX_ATTACHMENT_TOTAL_BYTES);
  });

  it('enforces command attachment count and combined size', () => {
    expect(() => validateCommandAttachments(Array(6).fill({ data: dataUrl('text/plain', 'x') })))
      .toThrow('Maximum 5 files allowed');
    const data = dataUrl('text/plain', Buffer.alloc(9 * 1024 * 1024));
    expect(() => validateCommandAttachments(Array(3).fill({ data })))
      .toThrow('Total upload too large. Maximum combined size is 25MB.');
  });

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

  it('normalizes equivalent video MIME aliases in direct-send payloads', () => {
    const attachments = validateCommandAttachments([{
      data: dataUrl('video/x-m4v', 'video'),
      name: 'clip.m4v',
      mimeType: 'video/mp4',
    }]);
    expect(attachments).toEqual([{
      data: dataUrl('video/mp4', 'video'),
      name: 'clip.m4v',
      mimeType: 'video/mp4',
    }]);
  });

  it('rejects unsupported direct-send attachment MIME types', () => {
    expect(() => validateCommandAttachments([{
      data: dataUrl('application/octet-stream', 'binary'),
      name: 'payload.bin',
      mimeType: 'application/octet-stream',
    }])).toThrow(
      'Invalid file type. Only images, videos, Markdown, text, and PDF files are allowed.',
    );
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
