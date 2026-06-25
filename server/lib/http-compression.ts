// Central HTTP response compression for the Bun server.
//
// Applies streamed gzip/deflate/zstd compression to eligible route responses after
// handlers return and before the response leaves the route wrapper. Brotli is
// intentionally unsupported; see the comment below for the rationale.

import { isHttpCompressionEnabled } from '../config.js';

export type SupportedContentEncoding = 'gzip' | 'deflate' | 'zstd';

// Brotli is intentionally unsupported for request-time HTTP compression.
// On Bun 1.3.14, compressing the current largest app chunk
// web/build/_app/immutable/chunks/rgxz0B2U.js (929406 bytes) with
// CompressionStream produced these median timings:
// gzip: 25.2 ms -> 328635 bytes
// deflate: 25.5 ms -> 328623 bytes
// zstd: 15.6 ms -> 335065 bytes
// brotli: 2083.7 ms -> 258271 bytes
// Brotli's size win does not justify its request-path CPU cost without a
// future compressed-asset cache or build-time precompression path.

// Keeps deflate as a compatibility fallback while preserving the existing
// gzip-first behavior and preferring zstd when modern clients offer both.
const DEFAULT_ENCODING_PREFERENCE: readonly SupportedContentEncoding[] = ['gzip', 'zstd', 'deflate'];
const SUPPORTED_ENCODINGS = new Set<SupportedContentEncoding>(DEFAULT_ENCODING_PREFERENCE);

// Maps HTTP content-encoding tokens to Bun CompressionStream format strings.
const COMPRESSION_STREAM_FORMAT_BY_ENCODING = {
  gzip: 'gzip',
  deflate: 'deflate',
  zstd: 'zstd',
} as const satisfies Record<SupportedContentEncoding, Bun.CompressionFormat>;

// Minimum uncompressed bytes before compression is worth applying when the
// size is known up front. Unknown-size streamed responses skip this check.
const HTTP_COMPRESSION_MIN_BYTES = 1024;

// Exact MIME types that should not be compressed.
const SKIP_MIME_TYPES = new Set([
  'application/gzip',
  'application/octet-stream',
  'application/pdf',
  'application/wasm',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-rar-compressed',
  'application/zip',
  'text/event-stream',
]);

// MIME prefixes that should not be compressed.
const SKIP_MIME_PREFIXES = ['audio/', 'font/', 'image/', 'video/'];

// Exceptions to the skip prefixes that are compressible.
const COMPRESSIBLE_MIME_EXCEPTIONS = new Set(['image/svg+xml']);

interface EncodingPreference {
  encoding: string;
  quality: number;
}

type ByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' };

function parseAcceptEncoding(header: string): EncodingPreference[] {
  const preferences: EncodingPreference[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;

    const [rawEncoding, ...params] = part.split(';').map((value) => value.trim());
    const encoding = rawEncoding?.toLowerCase();
    if (!encoding) continue;

    let quality = 1;
    for (const param of params) {
      const match = /^q\s*=\s*(?<value>[0-9.]+)$/iu.exec(param);
      if (!match?.groups?.value) continue;
      const parsed = Number(match.groups.value);
      quality = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1;
    }

    preferences.push({ encoding, quality });
  }
  return preferences;
}

// Selects a supported content encoding for the request, or null when no
// supported encoding is acceptable. Honors q weights, q=0 rejection, and the
// `*` wildcard. Unsupported encodings (including `br`) are ignored.
export function negotiateContentEncoding(
  acceptEncoding: string | null,
): SupportedContentEncoding | null {
  if (!acceptEncoding) return null;

  const parsed = parseAcceptEncoding(acceptEncoding);
  if (parsed.length === 0) return null;

  const explicit = new Map<string, number>();
  let wildcardQuality: number | null = null;

  for (const entry of parsed) {
    if (entry.encoding === '*') {
      wildcardQuality = entry.quality;
    } else {
      explicit.set(entry.encoding, entry.quality);
    }
  }

  const candidates: Array<{
    encoding: SupportedContentEncoding;
    quality: number;
    rank: number;
  }> = [];

  DEFAULT_ENCODING_PREFERENCE.forEach((encoding, rank) => {
    const quality = explicit.has(encoding) ? explicit.get(encoding) : wildcardQuality;
    if (quality === undefined || quality === null || quality <= 0) return;
    candidates.push({ encoding, quality, rank });
  });

  candidates.sort((left, right) => {
    if (left.quality !== right.quality) return right.quality - left.quality;
    return left.rank - right.rank;
  });

  return candidates[0]?.encoding ?? null;
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }
  if (existing.trim() === '*') return;

  const values = existing.split(',').map((part) => part.trim().toLowerCase());
  if (values.includes(value.toLowerCase())) return;
  headers.set('Vary', `${existing}, ${value}`);
}

// Strong ETags identify the uncompressed representation; mark them weak so
// they cannot be used to verify a transformed compressed body.
function weakenStrongEtag(headers: Headers): void {
  const etag = headers.get('ETag');
  if (!etag || etag.startsWith('W/')) return;
  headers.set('ETag', `W/${etag}`);
}

function isCompressibleContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const mimeType = contentType.split(';')[0]?.trim().toLowerCase();
  if (!mimeType) return true;

  if (COMPRESSIBLE_MIME_EXCEPTIONS.has(mimeType)) return true;
  if (SKIP_MIME_TYPES.has(mimeType)) return false;
  if (SKIP_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return COMPRESSIBLE_MIME_EXCEPTIONS.has(mimeType);
  }
  return true;
}

function shouldSkipHttpCompression(request: Request, response: Response): boolean {
  if (!isHttpCompressionEnabled()) return true;
  if (request.method === 'HEAD') return true;
  if (request.headers.has('Range')) return true;

  const status = response.status;
  if (status === 101 || status === 204 || status === 304) return true;

  if (response.body === null) return true;
  if (response.bodyUsed) return true;
  if (response.headers.has('Content-Encoding')) return true;

  const cacheControl = response.headers.get('Cache-Control');
  if (cacheControl && /(?:^|,\s*)no-transform(?:\s*,|$)/i.test(cacheControl)) return true;

  if (!isCompressibleContentType(response.headers.get('Content-Type'))) return true;

  const contentLengthHeader = response.headers.get('Content-Length');
  if (contentLengthHeader !== null) {
    const length = Number(contentLengthHeader);
    if (Number.isFinite(length) && length < HTTP_COMPRESSION_MIN_BYTES) return true;
  }

  return false;
}

function parseSingleByteRange(header: string | null, totalBytes: number): ByteRange | null {
  if (!header || !Number.isSafeInteger(totalBytes) || totalBytes < 0) return null;
  const match = /^bytes=(?<range>[^,]+)$/iu.exec(header.trim());
  if (!match?.groups?.range) return null;

  const [rawStart, rawEnd] = match.groups.range.split('-', 2);
  if (rawStart === undefined || rawEnd === undefined) return null;
  const startText = rawStart.trim();
  const endText = rawEnd.trim();

  if (!startText && !endText) return { kind: 'invalid' };

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    const start = Math.max(totalBytes - suffixLength, 0);
    return { kind: 'range', start, end: Math.max(totalBytes - 1, 0) };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalBytes
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'range', start, end: Math.min(end, totalBytes - 1) };
}

async function maybeHandleRangeRequest(request: Request, response: Response): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader || response.body === null || response.bodyUsed) return null;

  const contentLength = Number(response.headers.get('Content-Length'));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return null;

  const range = parseSingleByteRange(rangeHeader, contentLength);
  if (!range) return null;

  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');

  if (range.kind === 'invalid') {
    headers.set('Content-Range', `bytes */${contentLength}`);
    headers.delete('Content-Length');
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers,
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = bytes.slice(range.start, range.end + 1);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${contentLength}`);
  headers.set('Content-Length', String(body.byteLength));

  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

// Returns response with Vary: Accept-Encoding appended but body unchanged.
// Used for eligible responses where no supported encoding was negotiated.
function withVaryAcceptEncoding(response: Response): Response {
  const headers = new Headers(response.headers);
  appendVary(headers, 'Accept-Encoding');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function compressResponseBody(
  body: ReadableStream<Uint8Array>,
  encoding: SupportedContentEncoding,
  streamFormat: Bun.CompressionFormat,
): Promise<ReadableStream<Uint8Array> | Uint8Array> {
  const CompressionStreamCtor = globalThis.CompressionStream;
  if (typeof CompressionStreamCtor === 'function') {
    return body.pipeThrough(new CompressionStreamCtor(streamFormat as unknown as CompressionFormat));
  }

  const input = new Uint8Array(await new Response(body).arrayBuffer());
  switch (encoding) {
    case 'gzip':
      return Bun.gzipSync(input);
    case 'deflate':
      return Bun.deflateSync(input);
    case 'zstd':
      return Bun.zstdCompressSync(input);
  }
}

// Applies streamed gzip/deflate/zstd compression to an eligible response based on the
// request Accept-Encoding header. Skips ineligible responses unchanged. Buffers only
// when this runtime lacks Web CompressionStream support.
export async function compressHttpResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  const rangeResponse = await maybeHandleRangeRequest(request, response);
  if (rangeResponse) return rangeResponse;

  if (shouldSkipHttpCompression(request, response)) {
    return response;
  }

  const encoding = negotiateContentEncoding(request.headers.get('Accept-Encoding'));
  if (!encoding) {
    return withVaryAcceptEncoding(response);
  }

  const streamFormat = COMPRESSION_STREAM_FORMAT_BY_ENCODING[encoding];
  const headers = new Headers(response.headers);
  headers.set('Content-Encoding', encoding);
  headers.delete('Content-Length');
  appendVary(headers, 'Accept-Encoding');
  weakenStrongEtag(headers);

  return new Response(
    await compressResponseBody(response.body!, encoding, streamFormat),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

// Exposed for tests that assert the supported set excludes Brotli.
export const SUPPORTED_HTTP_ENCODINGS: readonly SupportedContentEncoding[] = DEFAULT_ENCODING_PREFERENCE;
export { SUPPORTED_ENCODINGS };
