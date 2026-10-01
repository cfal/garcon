import { open } from 'node:fs/promises';
import { decodeShareSnapshotHeader, type ShareSnapshotHeader } from './share-snapshot-format.js';

export interface ShareMessageRange {
  readonly start: number;
  readonly end: number;
}

export type SelectShareMessageRange = (header: ShareSnapshotHeader) => ShareMessageRange;

// Skipped messages are counted without retaining their bytes. The header and selected
// messages come from one open file, even if a publication replaces its path mid-read.
export async function readShareSnapshotRange(
  filePath: string,
  token: string,
  select: SelectShareMessageRange,
): Promise<{ header: ShareSnapshotHeader; messages: string[] } | null> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const messages: string[] = [];
    const snapshot: { header: ShareSnapshotHeader | null } = { header: null };
    let range: ShareMessageRange | null = null;
    let line = -1;
    let parts: Buffer[] = [];
    const selected = () => line === -1 || (range !== null && line >= range.start && line < range.end);
    const finishLine = (): boolean => {
      if (line === -1) {
        const header = decodeShareSnapshotHeader(token, Buffer.concat(parts).toString('utf8'));
        if (!header) return false;
        snapshot.header = header;
        range = select(header);
      } else if (selected()) {
        messages.push(Buffer.concat(parts).toString('utf8'));
      }
      parts = [];
      line++;
      return true;
    };
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const newline = buffer.indexOf(10, offset);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        if (selected()) parts.push(Buffer.from(buffer.subarray(offset, end)));
        if (end < bytesRead && !finishLine()) return null;
        offset = end + 1;
      }
    }
    if (!finishLine() || !snapshot.header || snapshot.header.messageCount !== line) return null;
    return { header: snapshot.header, messages };
  } finally {
    await file.close();
  }
}
