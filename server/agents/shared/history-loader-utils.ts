import { promises as fs } from 'fs';

const PROJECT_PREVIEW_TAIL_BYTES = 256 * 1024;
const PROJECT_PREVIEW_MAX_LINES_PER_FILE = 4000;

export interface JsonlTailLinesResult {
  lines: string[];
  lineEntries: JsonlLineEntry[];
  fullyRead: boolean;
}

export interface JsonlLineEntry {
  line: string;
  byteOffset: number;
  lineNumber?: number;
}

function collectJsonlLineEntries(
  buffer: Buffer,
  byteOffset: number,
  lineNumber?: number,
): JsonlLineEntry[] {
  const entries: JsonlLineEntry[] = [];
  let lineStart = 0;
  let currentLineNumber = lineNumber;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;

    const line = buffer.subarray(lineStart, index).toString('utf8');
    if (line.trim()) {
      entries.push({
        line,
        byteOffset: byteOffset + lineStart,
        ...(currentLineNumber == null ? {} : { lineNumber: currentLineNumber }),
      });
    }

    lineStart = index + 1;
    if (currentLineNumber != null) currentLineNumber += 1;
  }

  if (lineStart < buffer.length) {
    const line = buffer.subarray(lineStart).toString('utf8');
    if (line.trim()) {
      entries.push({
        line,
        byteOffset: byteOffset + lineStart,
        ...(currentLineNumber == null ? {} : { lineNumber: currentLineNumber }),
      });
    }
  }

  return entries;
}

export async function* readJsonlLineEntries(filePath: string): AsyncGenerator<JsonlLineEntry> {
  const fh = await fs.open(filePath, 'r');
  try {
    const readBuffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let lineStartByteOffset = 0;
    let lineNumber = 1;
    let pendingLineBuffers: Buffer[] = [];
    let pendingLineLength = 0;

    while (true) {
      const { bytesRead } = await fh.read(readBuffer, 0, readBuffer.length, position);
      if (bytesRead === 0) break;

      const chunk = readBuffer.subarray(0, bytesRead);
      const chunkStartOffset = position;
      position += bytesRead;
      let segmentStart = 0;

      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;

        const segment = chunk.subarray(segmentStart, index);
        const lineBuffer = pendingLineLength > 0
          ? Buffer.concat([...pendingLineBuffers, segment], pendingLineLength + segment.length)
          : segment;
        const line = lineBuffer.toString('utf8');

        if (line.trim()) {
          yield { line, byteOffset: lineStartByteOffset, lineNumber };
        }

        pendingLineBuffers = [];
        pendingLineLength = 0;
        segmentStart = index + 1;
        lineStartByteOffset = chunkStartOffset + segmentStart;
        lineNumber += 1;
      }

      if (segmentStart < chunk.length) {
        const segment = Buffer.from(chunk.subarray(segmentStart));
        pendingLineBuffers.push(segment);
        pendingLineLength += segment.length;
      }
    }

    if (pendingLineLength > 0) {
      const line = Buffer.concat(pendingLineBuffers, pendingLineLength).toString('utf8');
      if (line.trim()) {
        yield { line, byteOffset: lineStartByteOffset, lineNumber };
      }
    }
  } finally {
    await fh.close();
  }
}

export async function readJsonlTailLines(
  filePath: string,
  maxBytes = PROJECT_PREVIEW_TAIL_BYTES,
  maxLines = PROJECT_PREVIEW_MAX_LINES_PER_FILE,
): Promise<JsonlTailLinesResult> {
  const stats = await fs.stat(filePath);
  const readSize = Math.min(maxBytes, stats.size);
  if (readSize === 0) {
    return { lines: [], lineEntries: [], fullyRead: true };
  }

  const fh = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    const readStartOffset = stats.size - readSize;
    await fh.read(buffer, 0, readSize, readStartOffset);

    let contentBuffer = buffer;
    let contentByteOffset = readStartOffset;
    const fullyRead = readSize === stats.size;

    if (!fullyRead) {
      const firstNewlineIdx = buffer.indexOf(0x0a);
      if (firstNewlineIdx >= 0) {
        contentBuffer = buffer.subarray(firstNewlineIdx + 1);
        contentByteOffset = readStartOffset + firstNewlineIdx + 1;
      } else {
        contentBuffer = Buffer.alloc(0);
        contentByteOffset = stats.size;
      }
    }

    const rawEntries = collectJsonlLineEntries(contentBuffer, contentByteOffset, fullyRead ? 1 : undefined);
    const truncatedByLineLimit = rawEntries.length > maxLines;
    const lineEntries = truncatedByLineLimit
      ? rawEntries.slice(rawEntries.length - maxLines)
      : rawEntries;
    const lines = lineEntries.map((entry) => entry.line);

    return { lines, lineEntries, fullyRead: fullyRead && !truncatedByLineLimit };
  } finally {
    await fh.close();
  }
}
