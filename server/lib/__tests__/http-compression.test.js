import { describe, expect, it } from 'bun:test';
import {
  compressHttpResponse,
  negotiateContentEncoding,
  SUPPORTED_ENCODINGS,
  SUPPORTED_HTTP_ENCODINGS,
} from '../http-compression.ts';

async function compressedBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

async function decompress(encoding, bytes) {
  if (encoding === 'gzip') return Bun.gunzipSync(bytes);
  if (encoding === 'deflate') {
    if (typeof DecompressionStream !== 'function') return Bun.inflateSync(bytes);
    // Uses Web decompression when available to match CompressionStream('deflate') output.
    return new Uint8Array(
      await new Response(
        new Response(bytes).body.pipeThrough(new DecompressionStream('deflate')),
      ).arrayBuffer(),
    );
  }
  return Bun.zstdDecompressSync(bytes);
}

describe('negotiateContentEncoding', () => {
  it('returns null for a missing header', () => {
    expect(negotiateContentEncoding(null)).toBeNull();
  });

  it('returns null for an empty header', () => {
    expect(negotiateContentEncoding('')).toBeNull();
  });

  it('picks gzip when supported encodings have equal weight', () => {
    expect(negotiateContentEncoding('gzip, deflate, zstd')).toBe('gzip');
  });

  it('picks zstd when the client gives zstd higher quality', () => {
    expect(negotiateContentEncoding('gzip;q=0.5, zstd;q=1')).toBe('zstd');
  });

  it('picks zstd over deflate when their weights are equal', () => {
    expect(negotiateContentEncoding('deflate, zstd')).toBe('zstd');
  });

  it('picks deflate when the client gives deflate higher quality', () => {
    expect(negotiateContentEncoding('gzip;q=0.5, deflate;q=1, zstd;q=0.75')).toBe('deflate');
  });

  it('does not support brotli', () => {
    expect(negotiateContentEncoding('br')).toBeNull();
    expect(negotiateContentEncoding('br, deflate')).toBe('deflate');
  });

  it('supports wildcard without selecting brotli', () => {
    expect(negotiateContentEncoding('*')).toBe('gzip');
  });

  it('honors q=0 rejection', () => {
    expect(negotiateContentEncoding('gzip;q=0, zstd')).toBe('zstd');
    expect(negotiateContentEncoding('gzip;q=0, deflate;q=0, zstd;q=0')).toBeNull();
  });

  it('clamps malformed q to 1', () => {
    expect(negotiateContentEncoding('gzip;q=foo, zstd')).toBe('gzip');
  });

  it('matches encoding names case-insensitively', () => {
    expect(negotiateContentEncoding('GZIP')).toBe('gzip');
    expect(negotiateContentEncoding('DEFLATE')).toBe('deflate');
    expect(negotiateContentEncoding('ZSTD')).toBe('zstd');
  });

  it('exposes a supported set that excludes brotli', () => {
    expect(SUPPORTED_ENCODINGS.has('gzip')).toBe(true);
    expect(SUPPORTED_ENCODINGS.has('deflate')).toBe(true);
    expect(SUPPORTED_ENCODINGS.has('zstd')).toBe(true);
    expect(SUPPORTED_ENCODINGS.has('br')).toBe(false);
    expect(SUPPORTED_HTTP_ENCODINGS).toEqual(['gzip', 'zstd', 'deflate']);
  });

});

describe('compressHttpResponse round trips', () => {
  it('falls back when CompressionStream is unavailable', async () => {
    const original = globalThis.CompressionStream;
    globalThis.CompressionStream = undefined;
    try {
      const body = 'fallback '.repeat(1000);
      const response = await compressHttpResponse(
        new Request('http://localhost/test', { headers: { 'Accept-Encoding': 'gzip' } }),
        new Response(body, {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(body.length),
          },
        }),
      );

      expect(response.headers.get('Content-Encoding')).toBe('gzip');
      const decoded = await decompress('gzip', await compressedBytes(response));
      expect(new TextDecoder().decode(decoded)).toBe(body);
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it('streams gzip responses', async () => {
    const body = 'hello '.repeat(1000);
    const request = new Request('http://localhost/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const response = await compressHttpResponse(
      request,
      new Response(body, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(body.length),
        },
      }),
    );

    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');

    const decoded = await decompress('gzip', await compressedBytes(response));
    expect(new TextDecoder().decode(decoded)).toBe(body);
  });

  it('streams zstd responses', async () => {
    const body = 'hello '.repeat(1000);
    const request = new Request('http://localhost/test', {
      headers: { 'Accept-Encoding': 'zstd' },
    });
    const response = await compressHttpResponse(
      request,
      new Response(body, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(body.length),
        },
      }),
    );

    expect(response.headers.get('Content-Encoding')).toBe('zstd');
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');

    const decoded = await decompress('zstd', await compressedBytes(response));
    expect(new TextDecoder().decode(decoded)).toBe(body);
  });

  it('streams deflate responses', async () => {
    const body = 'hello '.repeat(1000);
    const request = new Request('http://localhost/test', {
      headers: { 'Accept-Encoding': 'deflate' },
    });
    const response = await compressHttpResponse(
      request,
      new Response(body, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(body.length),
        },
      }),
    );

    expect(response.headers.get('Content-Encoding')).toBe('deflate');
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');

    const decoded = await decompress('deflate', await compressedBytes(response));
    expect(new TextDecoder().decode(decoded)).toBe(body);
  });
});

describe('compressHttpResponse skip rules', () => {
  function makeResponse(overrides) {
    return new Response('hello '.repeat(1000), {
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '6000' },
      ...overrides,
    });
  }

  function makeRequest(overrides) {
    return new Request('http://localhost/test', {
      headers: { 'Accept-Encoding': 'gzip', ...overrides },
    });
  }

  it('skips HEAD requests', async () => {
    const response = await compressHttpResponse(
      new Request('http://localhost/test', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } }),
      makeResponse(),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('serves Range requests before compression', async () => {
    const response = await compressHttpResponse(
      makeRequest({ Range: 'bytes=0-99' }),
      makeResponse(),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Content-Range')).toBe('bytes 0-99/6000');
    expect(response.headers.get('Content-Length')).toBe('100');
  });

  it('slices Range responses without reading past the requested span', async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('hello world'));
          return;
        }
        controller.enqueue(new TextEncoder().encode(' unread'));
        controller.close();
      },
      cancel() {},
    });

    const response = await compressHttpResponse(
      makeRequest({ Range: 'bytes=0-4' }),
      new Response(stream, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '18',
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('hello');
    expect(pulls).toBe(1);
  });

  it('skips 204 responses', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ status: 204 }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('skips 304 responses', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ status: 304 }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('skips responses that already have Content-Encoding', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'identity' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('identity');
  });

  it('skips responses with Cache-Control: no-transform', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-transform' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('skips text/event-stream', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '6000' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('skips image/png', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'image/png', 'Content-Length': '6000' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('compresses image/svg+xml despite the image/ prefix', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': '6000' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
  });

  it('skips known Content-Length below threshold', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/plain', 'Content-Length': '100' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('streams unknown-length responses instead of buffering', async () => {
    const body = 'hello '.repeat(1000);
    const response = await compressHttpResponse(
      makeRequest(),
      new Response(body, { headers: { 'Content-Type': 'text/plain' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    const decoded = await decompress('gzip', await compressedBytes(response));
    expect(new TextDecoder().decode(decoded)).toBe(body);
  });

  it('skips responses with no body', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      new Response(null, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  it('weakens strong ETag to weak', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/plain', 'Content-Length': '6000', 'ETag': '"abc123"' } }),
    );
    expect(response.headers.get('ETag')).toBe('W/"abc123"');
  });

  it('leaves weak ETags unchanged', async () => {
    const response = await compressHttpResponse(
      makeRequest(),
      makeResponse({ headers: { 'Content-Type': 'text/plain', 'Content-Length': '6000', 'ETag': 'W/"abc123"' } }),
    );
    expect(response.headers.get('ETag')).toBe('W/"abc123"');
  });
});

describe('compressHttpResponse unsupported encoding', () => {
  it('adds Vary: Accept-Encoding without setting Content-Encoding for br-only', async () => {
    const body = 'hello '.repeat(1000);
    const response = await compressHttpResponse(
      new Request('http://localhost/test', { headers: { 'Accept-Encoding': 'br' } }),
      new Response(body, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe(body);
  });

  it('appends to an existing Vary header without duplicating', async () => {
    const body = 'hello '.repeat(1000);
    const response = await compressHttpResponse(
      new Request('http://localhost/test', { headers: { 'Accept-Encoding': 'br' } }),
      new Response(body, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(body.length),
          'Vary': 'Cookie',
        },
      }),
    );
    expect(response.headers.get('Vary')).toBe('Cookie, Accept-Encoding');
  });

  it('does not append Vary when Accept-Encoding already present', async () => {
    const body = 'hello '.repeat(1000);
    const response = await compressHttpResponse(
      new Request('http://localhost/test', { headers: { 'Accept-Encoding': 'br' } }),
      new Response(body, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(body.length),
          'Vary': 'Accept-Encoding',
        },
      }),
    );
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
  });
});
