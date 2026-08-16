import { promises as fs } from 'fs';

export interface JsonlLineEntry {
  line: string;
  byteOffset: number;
  lineNumber?: number;
}

export interface JsonlLineReadOptions {
  completeLinesOnly?: boolean;
  includeEmptyLines?: boolean;
  maxLineBytes?: number;
  signal?: AbortSignal;
}

export async function* readJsonlLineEntries(
  filePath: string,
  options: JsonlLineReadOptions = {},
): AsyncGenerator<JsonlLineEntry> {
  const fh = await fs.open(filePath, 'r');
  try {
    const readBuffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let lineStartByteOffset = 0;
    let lineNumber = 1;
    let pendingLineBuffers: Buffer[] = [];
    let pendingLineLength = 0;

    const assertLineLength = (length: number): void => {
      if (options.maxLineBytes !== undefined && length > options.maxLineBytes) {
        throw new Error(`JSONL record exceeds ${options.maxLineBytes} bytes`);
      }
    };

    while (true) {
      if (options.signal?.aborted) {
        throw new DOMException('Transcript search load cancelled', 'AbortError');
      }
      const { bytesRead } = await fh.read(readBuffer, 0, readBuffer.length, position);
      if (bytesRead === 0) break;

      const chunk = readBuffer.subarray(0, bytesRead);
      const chunkStartOffset = position;
      position += bytesRead;
      let segmentStart = 0;

      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;

        const segment = chunk.subarray(segmentStart, index);
        assertLineLength(pendingLineLength + segment.length);
        const lineBuffer = pendingLineLength > 0
          ? Buffer.concat([...pendingLineBuffers, segment], pendingLineLength + segment.length)
          : segment;
        const line = lineBuffer.toString('utf8');

        if (line.trim() || options.includeEmptyLines) {
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
        assertLineLength(pendingLineLength + segment.length);
        pendingLineBuffers.push(segment);
        pendingLineLength += segment.length;
      }
    }

    if (pendingLineLength > 0 && options.completeLinesOnly !== true) {
      const line = Buffer.concat(pendingLineBuffers, pendingLineLength).toString('utf8');
      if (line.trim() || options.includeEmptyLines) {
        yield { line, byteOffset: lineStartByteOffset, lineNumber };
      }
    }
  } finally {
    await fh.close();
  }
}
