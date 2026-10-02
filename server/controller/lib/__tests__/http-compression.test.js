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
    }, { highWaterMark: 0 });

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

describe('HTTP byte ranges', () => {
  const request = (range, headers = {}) => new Request('http://localhost/test', {
    headers: { Range: range, 'Accept-Encoding': 'gzip', ...headers },
  });
  const representation = (body = '0123456789', headers = {}, status = 200) => new Response(body, {
    status, headers: { 'Content-Length': String(Buffer.byteLength(body)), ...headers },
  });

  it.each([401, 404, 500, 206])('preserves status %s and its body', async status => {
    const original = representation('56789', status === 206 ? { 'Content-Range': 'bytes 5-9/10' } : {}, status);
    const response = await compressHttpResponse(request('bytes=5-9'), original);
    expect(response).toBe(original);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('56789');
  });

  it.each([null, '', 'not-a-number', '1e3', '-1'])('ignores unknown or invalid length %s', async length => {
    const original = new Response('full body', { headers: length === null ? {} : { 'Content-Length': length } });
    const response = await compressHttpResponse(request('bytes=0-1'), original);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('full body');
  });

  it('preserves an encoded representation and its encoding', async () => {
    const bytes = Bun.gzipSync('compressed body');
    const original = new Response(bytes, { headers: { 'Content-Length': String(bytes.length), 'Content-Encoding': 'gzip' } });
    const response = await compressHttpResponse(request('bytes=0-2'), original);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ['bytes=5-9', '56789', 'bytes 5-9/10'],
    ['bytes=5-', '56789', 'bytes 5-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-20', '0123456789', 'bytes 0-9/10'],
    ['bytes=7-99', '789', 'bytes 7-9/10'],
  ])('returns exact bytes for %s', async (range, body, contentRange) => {
    const response = await compressHttpResponse(request(range), representation());
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  it.each(['bytes=-', 'bytes=0-1-2', 'bytes=1e0-2', 'bytes=0-1,3-4', 'bytes=5-2', 'bytes=+1-2'])('ignores malformed or unsupported range %s', async range => {
    const response = await compressHttpResponse(request(range), representation());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
  });

  it.each(['bytes=0-', 'bytes=-1'])('rejects %s on an empty representation', async range => {
    const response = await compressHttpResponse(request(range), representation(''));
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */0');
    expect(await response.text()).toBe('');
  });

  it.each(['bytes=10-', 'bytes=-0'])('rejects an unsatisfiable range %s', async range => {
    const response = await compressHttpResponse(request(range), representation());
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });

  it.each(['"old"', 'W/"current"', 'Fri, 02 Oct 2026 00:00:00 GMT'])('declines an unverifiable If-Range %s', async validator => {
    const response = await compressHttpResponse(request('bytes=5-9', { 'If-Range': validator }), representation('0123456789', { ETag: '"current"' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
  });

  it('honors a matching strong If-Range ETag', async () => {
    const response = await compressHttpResponse(request('bytes=5-9', { 'If-Range': '"current"' }), representation('0123456789', { ETag: '"current"' }));
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('56789');
  });

  it('pulls only on demand and forwards consumer cancellation', async () => {
    let pulls = 0;
    let cancellation;
    const source = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(10).fill(pulls)); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 });
    const response = await compressHttpResponse(request('bytes=5-99'), new Response(source, { headers: { 'Content-Length': '1000' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(pulls).toBe(0);
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array(5).fill(1));
    await new Promise(resolve => setImmediate(resolve));
    expect(pulls).toBe(1);
    await reader.cancel('consumer left');
    expect(cancellation).toBe('consumer left');
    expect(source.locked).toBe(false);
  });

  it('releases the source when the requested range finishes', async () => {
    let cancelled = false;
    const source = new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('0123456789')); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await compressHttpResponse(request('bytes=3-5'), new Response(source, { headers: { 'Content-Length': '100' } }));
    expect(await response.text()).toBe('345');
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
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
