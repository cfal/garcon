import { describe, expect, it } from 'bun:test';
import {
  appendTextAttachmentContext,
  attachmentDocumentBlock,
  documentAttachments,
  imageAttachments,
  nonImageAttachments,
} from '../attachments.ts';

const markdown = {
  name: 'notes.md',
  mimeType: 'text/markdown',
  data: `data:text/markdown;base64,${Buffer.from('# Title\nbody').toString('base64')}`,
};
const pdf = {
  name: 'report.pdf',
  mimeType: 'application/pdf',
  data: 'data:application/pdf;base64,JVBERi0x',
};
const png = {
  name: 'shot.png',
  mimeType: 'image/png',
  data: 'data:image/png;base64,abc123',
};

describe('attachment partitioning', () => {
  it('separates images, documents, and other non-image attachments', () => {
    const all = [png, pdf, markdown];
    expect(imageAttachments(all)).toEqual([png]);
    expect(documentAttachments(all)).toEqual([pdf]);
    expect(nonImageAttachments(all)).toEqual([pdf, markdown]);
  });

  it('derives the mime type from the data URL when the field is absent', () => {
    const pdfNoMime = { name: 'x.pdf', data: 'data:application/pdf;base64,JVBERi0x' };
    expect(documentAttachments([pdfNoMime])).toEqual([pdfNoMime]);
  });
});

describe('attachmentDocumentBlock', () => {
  it('builds a base64 document block with the file name as title', () => {
    expect(attachmentDocumentBlock(pdf)).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
      title: 'report.pdf',
    });
  });

  it('omits the title when the attachment has no name', () => {
    expect(attachmentDocumentBlock({ data: 'data:application/pdf;base64,JVBERi0x' })).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
    });
  });

  it('returns null when the data URL cannot be parsed', () => {
    expect(attachmentDocumentBlock({ name: 'x.pdf', data: 'not-a-data-url' })).toBeNull();
  });
});

describe('appendTextAttachmentContext', () => {
  it('inlines text and markdown attachments but leaves PDFs for document blocks', () => {
    const result = appendTextAttachmentContext('read this', [markdown, pdf]);
    expect(result).toBe([
      'read this',
      '<attached-file name="notes.md" mime="text/markdown">\n# Title\nbody\n\n</attached-file>',
    ].join('\n\n'));
  });

  it('returns the command unchanged when there are no text attachments', () => {
    expect(appendTextAttachmentContext('hi', [png, pdf])).toBe('hi');
  });
});
