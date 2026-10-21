import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';

import {
  appendAttachmentFileReferences,
  attachmentFileName,
  materializeAttachmentFiles,
} from '../attachment-files.ts';

function attachment(name: string | null, mimeType: string, content = 'bytes') {
  return { name, mimeType, data: `data:${mimeType};base64,${Buffer.from(content).toString('base64')}` };
}

describe('attachment files', () => {
  it('keeps the user file name inside the attachment directory', () => {
    expect(attachmentFileName(attachment('budget.xlsx', 'application/octet-stream'), 0)).toBe('1-budget.xlsx');
    expect(attachmentFileName(attachment('../../etc/passwd', 'text/plain'), 1)).toBe('2-passwd.txt');
    expect(attachmentFileName(attachment('C:\\Users\\me\\a:b.csv', 'text/csv'), 2)).toBe('3-a_b.csv');
    expect(attachmentFileName(attachment('.env', 'text/plain'), 3)).toBe('4-env.txt');
  });

  it.each([
    ['report$(touch PWNED).csv', '1-report_touch_PWNED_.csv'],
    ['a`id`b.csv', '1-a_id_b.csv'],
    ['q"uote\x27s.csv', '1-q_uote_s.csv'],
    ['x; rm -rf ~ && y | z.csv', '1-x_rm_-rf_y_z.csv'],
    ['-rf.csv', '1-rf.csv'],
  ])('keeps only shell-inert characters in %j', (name, expected) => {
    expect(attachmentFileName(attachment(name, 'text/csv'), 0)).toBe(expected);
  });

  it('bounds very long stems and extensions', () => {
    const started = performance.now();
    const name = attachmentFileName(attachment('a'.repeat(1_000_000) + '.' + 'b'.repeat(1_000_000), 'application/octet-stream'), 0);
    expect(name).toBe(`1-${'a'.repeat(64)}`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(attachmentFileName(attachment('表格.docx', 'application/octet-stream'), 0)).toBe('1-attachment.docx');
  });

  it('adds the known extension when the name has none', () => {
    expect(attachmentFileName(attachment(null, 'image/png'), 0)).toBe('1-attachment.png');
    expect(attachmentFileName(attachment('notes', 'text/markdown'), 0)).toBe('1-notes.md');
    expect(attachmentFileName(attachment('blob', 'application/x-unknown'), 0)).toBe('1-blob');
  });

  it('writes same-named attachments to distinct files and removes them on cleanup', async () => {
    const { files, cleanup } = await materializeAttachmentFiles('garcon-attachment-test', [
      attachment('data.csv', 'text/csv', 'first'),
      attachment('data.csv', 'text/csv', 'second'),
    ]);
    expect(files).toHaveLength(2);
    expect(path.dirname(files[0]!.path)).toBe(path.dirname(files[1]!.path));
    expect(await fs.readFile(files[0]!.path, 'utf8')).toBe('first');
    expect(await fs.readFile(files[1]!.path, 'utf8')).toBe('second');

    await cleanup();
    expect(await fs.stat(path.dirname(files[0]!.path)).catch(() => null)).toBeNull();
  });

  it('lists the original name as quoted metadata beside the path', () => {
    const file = { attachment: attachment('Q3 $(budget).xlsx', 'text/plain'), path: '/tmp/x/1-Q3_budget_.xlsx' };
    expect(appendAttachmentFileReferences('Read', [file])).toBe(
      'Read\n\nAttached files are available on disk:\n\n- /tmp/x/1-Q3_budget_.xlsx (original name: "Q3 $(budget).xlsx")',
    );
  });
});
