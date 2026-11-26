import { createHash, createHmac, randomBytes } from 'node:crypto';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import type { StartedServer } from './environment.js';
import type { HttpStep, RequestAuth, ScenarioStep, WebSocketStep } from './scenario.js';
import type { Json } from './wildcard.js';

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
];

const DEFAULT_QUIET_MS = 400;
const MAX_TEXT_BODY = 64 * 1024;

export type CapturedBody =
  | { kind: 'empty' }
  | { kind: 'json'; value: Json }
  | { kind: 'text'; value: string }
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

// Expands `{{name}}` placeholders in request paths and bodies.
export function expandPlaceholders(text: string, server: StartedServer): string {
  const values: Record<string, string> = {
    username: server.credentials.username,
    password: server.credentials.password,
    projectDir: server.dirs.projectDir,
    workspaceDir: server.dirs.workspaceDir,
    token: server.token,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function requestUrl(server: StartedServer, step: HttpStep | WebSocketStep): string {
  if ('originPath' in step && step.originPath !== undefined) {
    return `${server.origin}${expandPlaceholders(step.originPath, server)}`;
  }
  const path = expandPlaceholders(step.path ?? '/', server);
  return `${server.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function textOrBytes(bytes: Uint8Array, contentType: string): CapturedBody {
  if (bytes.length === 0) return { kind: 'empty' };
  const textual = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg)/.test(contentType);
  if (textual && bytes.length <= MAX_TEXT_BODY) {
    const text = new TextDecoder().decode(bytes);
    if (contentType.includes('json')) {
      try {
        return { kind: 'json', value: JSON.parse(text) as Json };
      } catch {
        return { kind: 'text', value: text };
      }
    }
    return { kind: 'text', value: text };
  }
  return { kind: 'bytes', sha256: createHash('sha256').update(bytes).digest('hex'), length: bytes.length };
}

function decodeBody(bytes: Uint8Array, encoding: string | null): Uint8Array {
  if (bytes.length === 0) return bytes;
  switch (encoding) {
    case 'gzip': return gunzipSync(bytes);
    case 'deflate': return inflateSync(bytes);
    case 'zstd': return zstdDecompressSync(bytes);
    default: return bytes;
  }
}

async function captureHttp(server: StartedServer, step: HttpStep): Promise<CapturedExchange> {
  const auth = step.auth ?? 'token';
  const headers = new Headers();
  for (const [name, value] of Object.entries(step.headers ?? {})) headers.set(name, expandPlaceholders(value, server));
  const token = tokenFor(server, auth);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body: string | undefined;
  if (step.json !== undefined) {
    body = expandPlaceholders(JSON.stringify(step.json), server);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  } else if (step.body !== undefined) {
    body = expandPlaceholders(step.body, server);
  }
  // Compression is requested explicitly unless the step chooses its own
  // Accept-Encoding; an empty value sends none.
  if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'gzip');
  // Redirects are part of the contract, so they are recorded rather than
  // followed. Bodies are decoded here rather than by fetch, so encoders that
  // produce different bytes for the same content still compare equal.
  const response = await fetch(requestUrl(server, step), {
    method: step.method,
    headers,
    body,
    redirect: 'manual',
    decompress: false,
    signal: AbortSignal.timeout(30_000),
  });
  const captured: Record<string, string> = {};
  for (const name of CONTRACT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) captured[name] = value;
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && !response.headers.has('content-encoding')) captured['content-length'] = contentLength;
  const bytes = decodeBody(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-encoding'));
  return {
    request: { method: step.method, path: step.originPath ?? step.path ?? '/', auth },
    status: response.status,
    headers: captured,
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
async function captureRefusal(url: string, protocols: string[]): Promise<CapturedSocket['refusal']> {
  const target = new URL(url);
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: cGFyaXR5LWhhcm5lc3Mta2V5',
    ...(protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []),
    '',
    '',
  ];
  let received = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 5_000);
    void Bun.connect({
      hostname: target.hostname,
      port: Number(target.port),
      socket: {
        open(socket) { socket.write(lines.join('\r\n')); },
        data(socket, chunk) {
          received += new TextDecoder().decode(chunk);
          const headerEnd = received.indexOf('\r\n\r\n');
          const length = /\r\ncontent-length:\s*(\d+)/i.exec(received)?.[1];
          if (headerEnd >= 0 && length !== undefined && received.length >= headerEnd + 4 + Number(length)) {
            clearTimeout(timer);
            socket.end();
            resolve();
          }
        },
        close() { clearTimeout(timer); resolve(); },
        error(_socket, error) { clearTimeout(timer); reject(error); },
      },
    }).catch(reject);
  });
  const [head, ...rest] = received.split('\r\n\r\n');
  const [statusLine, ...headerLines] = head.split('\r\n');
  const contentType = headerLines.find((line) => /^content-type:/i.test(line))?.replace(/^content-type:\s*/i, '') ?? null;
  return { status: Number(statusLine.split(' ')[1] ?? 0), contentType, body: rest.join('\r\n\r\n') };
}

async function captureWebSocket(server: StartedServer, step: WebSocketStep): Promise<CapturedSocket> {
  const auth = step.auth ?? 'token';
  const protocols = step.protocols?.map((protocol) => expandPlaceholders(protocol, server))
    ?? webSocketProtocolsForAuth(tokenFor(server, auth));
  const url = requestUrl(server, step).replace(/^http/, 'ws');
  const socket = new WebSocket(url, protocols);
  const frames: Json[] = [];
  const requestIds = new Set((step.send ?? []).flatMap((message) =>
    message && typeof message === 'object' && !Array.isArray(message) && typeof message.clientRequestId === 'string'
      ? [message.clientRequestId] : []));
  let opened = false;
  let close: CapturedSocket['close'] = null;
  const quietMs = step.quietMs ?? DEFAULT_QUIET_MS;

  await new Promise<void>((resolve) => {
    let quietTimer: Timer | undefined;
    const finish = () => {
      clearTimeout(quietTimer);
      resolve();
    };
    const armQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const deadline = setTimeout(finish, 15_000);
    socket.onopen = () => {
      opened = true;
      for (const message of step.send ?? []) socket.send(expandPlaceholders(JSON.stringify(message), server));
      armQuietTimer();
    };
    socket.onmessage = (event) => {
      const frame = parseFrame(event.data);
      const requestId = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame.clientRequestId : undefined;
      if (typeof requestId !== 'string' || !requestIds.has(requestId)) return;
      frames.push(frame);
      if (step.frames !== undefined && frames.length >= step.frames) {
        clearTimeout(deadline);
        finish();
      } else {
        armQuietTimer();
      }
    };
    socket.onclose = (event) => {
      close = { code: event.code, reason: event.reason };
      clearTimeout(deadline);
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
    close,
    refusal,
  };
}

export function captureStep(server: StartedServer, step: ScenarioStep): Promise<Capture> {
  if (step.http) return captureHttp(server, step.http);
  return captureWebSocket(server, step.ws!);
}
