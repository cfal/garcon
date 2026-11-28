import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import type { StartedServer } from './environment.js';
import { expandJson, expandPlaceholders, type Placeholders } from './placeholders.js';
import type { HttpStep, RequestAuth, ScenarioStep, WebSocketStep } from './scenario.js';
import { isObject, type Json } from './wildcard.js';

// Response headers that are part of the contract. Per-response headers such as
// Date are left out. Content-Length is compared only for uncompressed bodies,
// since compressed lengths depend on the encoder and the decoded body is
// compared instead.
const CONTRACT_HEADERS = [
  'accept-ranges',
  'access-control-allow-origin',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-range',
  'content-security-policy',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'sec-websocket-protocol',
  'set-cookie',
  'vary',
  'www-authenticate',
  'x-content-type-options',
  'x-frame-options',
  'x-garcon-executor-instance',
];

const DEFAULT_QUIET_MS = 400;
const MAX_TEXT_BODY = 64 * 1024;

export type CapturedBody =
  | { kind: 'empty' }
  | { kind: 'json'; value: Json }
  | { kind: 'text'; value: string }
  // Too large to record whole. It is normalized like any other text and then
  // kept as a digest.
  | { kind: 'large-text'; value: string }
  | { kind: 'bytes'; sha256: string; length: number };

export interface CapturedExchange {
  request: { method: string; path: string; auth: RequestAuth };
  status: number;
  headers: Record<string, string>;
  body: CapturedBody;
}

export interface CapturedSocket {
  request: { path: string; auth: RequestAuth; protocols: string[] };
  opened: boolean;
  protocol: string;
  frames: Json[];
  // How the server closed a connection it had accepted. Null for a refused
  // upgrade: the client makes up a close code and reason for one, so they are
  // not the server's behavior.
  close: { code: number; reason: string } | null;
  // The HTTP response to a refused upgrade, which WebSocket clients hide.
  refusal: { status: number; contentType: string | null; body: string } | null;
}

export type Capture = CapturedExchange | CapturedSocket;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

// A well-formed HS256 token signed with an unrelated secret. A port must
// reject it exactly as the original does.
function forgedToken(username: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ userId: 1, username, iat: now, exp: now + 3600 }));
  const signature = createHmac('sha256', randomBytes(32)).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function tokenFor(server: StartedServer, auth: RequestAuth): string | null {
  if (auth === 'none') return null;
  if (auth === 'forged') return forgedToken(server.credentials.username);
  return server.token;
}

function requestUrl(server: StartedServer, step: HttpStep | WebSocketStep, placeholders: Placeholders): string {
  if ('originPath' in step && step.originPath !== undefined) {
    return `${server.origin}${expandPlaceholders(step.originPath, placeholders.values)}`;
  }
  const path = expandPlaceholders(step.path ?? '/', placeholders.values);
  return `${server.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

const TEXTUAL = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg)/;

function digest(bytes: Uint8Array): CapturedBody {
  return { kind: 'bytes', sha256: createHash('sha256').update(bytes).digest('hex'), length: bytes.length };
}

export function textOrBytes(bytes: Uint8Array, contentType: string): CapturedBody {
  if (bytes.length === 0) return { kind: 'empty' };
  if (!TEXTUAL.test(contentType)) return digest(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return digest(bytes);
  }
  if (bytes.length > MAX_TEXT_BODY) return { kind: 'large-text', value: text };
  if (contentType.includes('json')) {
    try {
      return { kind: 'json', value: JSON.parse(text) as Json };
    } catch { /* Malformed JSON is recorded as text. */ }
  }
  return { kind: 'text', value: text };
}

export function contractHeaders(headers: Headers): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const name of CONTRACT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  const length = headers.get('content-length');
  if (length !== null && !headers.has('content-encoding')) captured['content-length'] = length;
  return captured;
}

export function decodeBody(bytes: Uint8Array, encoding: string | null): Uint8Array {
  if (bytes.length === 0) return bytes;
  switch (encoding) {
    case 'gzip': return gunzipSync(bytes);
    case 'deflate': return inflateSync(bytes);
    case 'zstd': return zstdDecompressSync(bytes);
    default: return bytes;
  }
}

async function captureHttp(server: StartedServer, step: HttpStep, placeholders: Placeholders): Promise<CapturedExchange> {
  const auth = step.auth ?? 'token';
  const headers = new Headers();
  for (const [name, value] of Object.entries(step.headers ?? {})) headers.set(name, expandPlaceholders(value, placeholders.values));
  const token = tokenFor(server, auth);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body: string | undefined;
  if (step.json !== undefined) {
    body = expandPlaceholders(JSON.stringify(expandJson(step.json, placeholders)), placeholders.values);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  } else if (step.body !== undefined) {
    body = expandPlaceholders(step.body, placeholders.values);
  }
  // Compression is requested explicitly unless the step chooses its own
  // Accept-Encoding; an empty value sends none.
  if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'gzip');
  // Redirects are part of the contract, so they are recorded rather than
  // followed. Bodies are decoded here rather than by fetch, so encoders that
  // produce different bytes for the same content still compare equal.
  const response = await fetch(requestUrl(server, step, placeholders), {
    method: step.method,
    headers,
    body,
    redirect: 'manual',
    decompress: false,
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = decodeBody(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-encoding'));
  return {
    request: { method: step.method, path: step.originPath ?? step.path ?? '/', auth },
    status: response.status,
    headers: contractHeaders(response.headers),
    body: textOrBytes(bytes, response.headers.get('content-type') ?? ''),
  };
}

function parseFrame(data: unknown): Json {
  if (typeof data !== 'string') return { binaryLength: (data as ArrayBuffer).byteLength ?? 0 };
  try {
    return JSON.parse(data) as Json;
  } catch {
    return data;
  }
}

// Repeats a refused upgrade as a raw HTTP/1.1 request to record the status and
// body the WebSocket client does not expose. A refused upgrade has no side
// effects, so sending it twice is safe.
function captureRefusal(url: string, protocols: string[]): Promise<CapturedSocket['refusal']> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url.replace(/^ws/, 'http'), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'cGFyaXR5LWhhcm5lc3Mta2V5',
        ...(protocols.length > 0 ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
      },
      timeout: 5_000,
    });
    outgoing.on('response', async (response) => {
      let body = '';
      response.setEncoding('utf8');
      for await (const chunk of response) body += chunk;
      resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? null, body });
    });
    // An upgrade that succeeds on the second attempt is recorded as such.
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 101, contentType: null, body: '' });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('The refused upgrade did not complete')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function captureWebSocket(server: StartedServer, step: WebSocketStep, placeholders: Placeholders): Promise<CapturedSocket> {
  const auth = step.auth ?? 'token';
  const protocols = step.protocols?.map((protocol) => expandPlaceholders(protocol, placeholders.values))
    ?? webSocketProtocolsForAuth(tokenFor(server, auth));
  const url = requestUrl(server, step, placeholders).replace(/^http/, 'ws');
  const socket = new WebSocket(url, protocols);
  const frames: Json[] = [];
  const requestIds = new Set((step.send ?? []).flatMap((message) =>
    isObject(message) && typeof message.clientRequestId === 'string' ? [message.clientRequestId] : []));
  let opened = false;
  let close: CapturedSocket['close'] = null;
  const quietMs = step.quietMs ?? DEFAULT_QUIET_MS;

  await new Promise<void>((resolve) => {
    let quietTimer: Timer | undefined;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      resolve();
    };
    const armQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const deadline = setTimeout(finish, 15_000);
    socket.onopen = () => {
      opened = true;
      for (const message of step.send ?? []) {
        socket.send(expandPlaceholders(JSON.stringify(expandJson(message, placeholders)), placeholders.values));
      }
      armQuietTimer();
    };
    socket.onmessage = (event) => {
      const frame = parseFrame(event.data);
      const requestId = isObject(frame) ? frame.clientRequestId : undefined;
      if (typeof requestId !== 'string' || !requestIds.has(requestId)) return;
      frames.push(frame);
      if (step.frames !== undefined && frames.length >= step.frames) {
        finish();
      } else {
        armQuietTimer();
      }
    };
    socket.onclose = (event) => {
      close = { code: event.code, reason: event.reason };
      finish();
    };
  });
  const protocol = socket.protocol;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
  const refusal = opened ? null : await captureRefusal(url, protocols);
  return {
    request: { path: step.path, auth, protocols: step.protocols ?? ['(default)'] },
    opened,
    protocol,
    frames: step.frames !== undefined ? frames.slice(0, step.frames) : frames,
    close: opened ? close : null,
    refusal,
  };
}

export function captureStep(server: StartedServer, step: ScenarioStep, placeholders: Placeholders): Promise<Capture> {
  if (step.http) return captureHttp(server, step.http, placeholders);
  return captureWebSocket(server, step.ws!, placeholders);
}
