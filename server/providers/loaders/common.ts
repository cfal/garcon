import { promises as fs } from 'fs';

const PROJECT_PREVIEW_TAIL_BYTES = 256 * 1024;
const PROJECT_PREVIEW_MAX_LINES_PER_FILE = 4000;

export interface JsonlTailLinesResult {
  lines: string[];
  fullyRead: boolean;
}

export async function readJsonlTailLines(
  filePath: string,
  maxBytes = PROJECT_PREVIEW_TAIL_BYTES,
  maxLines = PROJECT_PREVIEW_MAX_LINES_PER_FILE,
): Promise<JsonlTailLinesResult> {
  const stats = await fs.stat(filePath);
  const readSize = Math.min(maxBytes, stats.size);
  if (readSize === 0) {
    return { lines: [], fullyRead: true };
  }

  const fh = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, stats.size - readSize);

    let content = buffer.toString('utf8');
    const fullyRead = readSize === stats.size;

    if (!fullyRead) {
      const firstNewlineIdx = content.indexOf('\n');
      content = firstNewlineIdx >= 0 ? content.slice(firstNewlineIdx + 1) : '';
    }

    const rawLines = content.split('\n').filter((line) => line.trim());
    const lines = rawLines.length > maxLines ? rawLines.slice(rawLines.length - maxLines) : rawLines;
    return { lines, fullyRead };
  } finally {
    await fh.close();
  }
}
