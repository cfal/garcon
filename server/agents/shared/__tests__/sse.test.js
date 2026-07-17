import { describe, expect, it } from 'bun:test';
import { readSseDataEvents } from '../sse.ts';

function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectDataEvents(chunks) {
  const events = [];
  await readSseDataEvents(streamFromChunks(chunks), (data) => {
    events.push(data);
  });
  return events;
}

describe('readSseDataEvents', () => {
  it('accepts data lines with and without the optional space after the colon', async () => {
    const events = await collectDataEvents([
      'event:content_block_delta\n',
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
    ]);

    expect(events).toEqual([
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
    ]);
  });

  it('handles buffered final data lines and CRLF line endings', async () => {
    const events = await collectDataEvents([
      'data:{"first":true}\r\n\r\n',
      'data:{"last":true}',
    ]);

    expect(events).toEqual([
      '{"first":true}',
      '{"last":true}',
    ]);
  });

  it('joins multiple data lines in one event according to the SSE contract', async () => {
    const events = await collectDataEvents([
      'data: {"choices":[\n',
      'data: {"delta":{"content":"Hi"}}]}\n\n',
    ]);

    expect(events).toEqual([
      '{"choices":[\n{"delta":{"content":"Hi"}}]}',
    ]);
  });
});
