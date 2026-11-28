import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contractHeaders, decodeBody, textOrBytes, type CapturedBody } from './capture.js';
import { normalizeBody, normalizeValue, type Normalization } from './normalize.js';
import { currentTraceTest, type TraceTest } from './trace-context.js';
import { traceGroup } from './trace-unstable.js';
import type { Json } from './wildcard.js';

export { installTraceTestContext } from './trace-context.js';

export interface TraceRecord {
  test: string;
  order: number;
  stream: 'http' | 'replies' | 'broadcasts';
  group?: string;
  value: Json;
}

function write(directory: string, test: TraceTest, record: Omit<TraceRecord, 'test'>): void {
  const file = join(directory, `${test.suite}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ test: test.name, ...record })}\n`, { mode: 0o600 });
}

const FIXTURE_PATH = /(?:\/[^/\s"'\\?&=#]+)*\/garcon-[\w-]+-[a-zA-Z0-9]{6}\b/g;
const LOOPBACK = /\b(https?|wss?):\/\/(?:127\.0\.0\.1|localhost):(\d+)\b/g;
const CHAT_ID = /\b\d{16}\b/g;
const FIXTURE_PROVIDER = /\bintegration_fake_[a-z0-9_]+_[0-9a-f]{6}\b/g;
const REPLY_TYPES = new Set([
  'chat-subscribed', 'chat-reload-progress', 'chat-reloaded', 'client-request-error', 'reconnect-state', 'ws-pong',
]);

function dynamicValue(test: TraceTest, kind: string, id: string): string {
  const key = `${kind}:${id}`;
  const known = test.ids.get(key);
  if (known) return known;
  const placeholder = `{{${kind}${[...test.ids.keys()].filter((entry) => entry.startsWith(`${kind}:`)).length + 1}}}`;
  test.ids.set(key, placeholder);
  return placeholder;
}

function traceNormalization(test: TraceTest, value: Json, origin: string, token: string | null): Normalization {
  const text = JSON.stringify(value);
  const carried = new Map<string, string>([[origin, '{{origin}}']]);
  if (token) carried.set(token, '{{token}}');
  for (const [path] of text.matchAll(FIXTURE_PATH)) {
    const name = dynamicValue(test, 'fixture', path);
    carried.set(path, name);
    carried.set(encodeURIComponent(path), name);
  }
  for (const [url, protocol, port] of text.matchAll(LOOPBACK)) {
    if (url !== origin) carried.set(url, `${protocol}://{{loopback}}:${dynamicValue(test, 'port', port)}`);
  }
  for (const [id] of text.matchAll(CHAT_ID)) {
    if (Math.abs(Number(id) / 1000 - Date.now()) < 3_600_000) carried.set(id, dynamicValue(test, 'chatId', id));
  }
  for (const [id] of text.matchAll(FIXTURE_PROVIDER)) carried.set(id, dynamicValue(test, 'providerId', id));
  const now = new Date();
  const localDay = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
  const days = [...new Set([now.toISOString().slice(0, 10), localDay])].map((day) => [day, '{{today}}'] as const);
  return { carried: [...carried].sort(([left], [right]) => right.length - left.length), days };
}

function sanitize(body: CapturedBody, redact: (value: Json) => Json): CapturedBody {
  return body.kind === 'json' ? { ...body, value: redact(body.value) } : body;
}

export class ClientTrace {
  readonly #requestTests = new Map<string, TraceTest>();
  #socketTest: TraceTest | undefined;

  constructor(
    private readonly directory: string,
    private readonly origin: string,
    private readonly token: string | null,
    private readonly redact: (value: Json) => Json,
  ) {}

  async http(url: URL, init: RequestInit, headers: Headers, send: (init: RequestInit) => Promise<Response>): Promise<Response> {
    const test = currentTraceTest();
    if (!test) return send(init);
    const order = test.next++;
    let bodyToRead = init.body;
    if (init.body instanceof ReadableStream) {
      const [bodyToSend, copy] = init.body.tee();
      init = { ...init, body: bodyToSend };
      bodyToRead = copy;
    }
    const sent = bodyToRead == null ? null : new Response(bodyToRead);
    const result = await send(init);
    const copy = result.clone();
    const capture = Promise.all([sent?.bytes(), copy.bytes()]).then(([sentBytes, receivedBytes]) => {
      const requestBody = sanitize(textOrBytes(sentBytes ?? new Uint8Array(), headers.get('content-type') ?? sent?.headers.get('content-type') ?? ''), this.redact);
      const decoded = 'decompress' in init && init.decompress === false
        ? decodeBody(receivedBytes, result.headers.get('content-encoding'))
        : receivedBytes;
      const body = sanitize(textOrBytes(decoded, result.headers.get('content-type') ?? ''), this.redact);
      const payload = {
        request: { method: init.method ?? 'GET', path: url.pathname + url.search },
        status: result.status,
        headers: contractHeaders(result.headers),
      };
      const extra = traceNormalization(test, { ...payload, requestBody, body, query: [...url.searchParams.values()] }, this.origin, this.token);
      write(this.directory, test, {
        order,
        stream: 'http',
        value: { ...normalizeValue(payload, extra) as Record<string, Json>, requestBody: normalizeBody(requestBody, extra), body: normalizeBody(body, extra) },
      });
    });
    test.pending.push(capture);
    void capture.catch(() => undefined);
    return result;
  }

  reconnect(): void {
    this.#requestTests.clear();
    this.#socketTest = currentTraceTest();
  }

  send(message: unknown): void {
    const test = currentTraceTest();
    const id = (message as { clientRequestId?: unknown }).clientRequestId;
    if (test && typeof id === 'string') this.#requestTests.set(id, test);
  }

  receive(message: Record<string, unknown>): void {
    const id = message.clientRequestId;
    const replyTest = typeof id === 'string' ? this.#requestTests.get(id) : undefined;
    const test = replyTest ?? currentTraceTest() ?? this.#socketTest;
    if (!test) return;
    if (!replyTest && typeof id === 'string' && typeof message.type === 'string' && REPLY_TYPES.has(message.type)) return;
    const order = test.next++;
    const raw = this.redact(message as Json);
    const extra = traceNormalization(test, raw, this.origin, this.token);
    const value = normalizeValue(raw, extra);
    const normalizedChat = typeof message.chatId === 'string' ? normalizeValue(message.chatId, extra) as string : null;
    write(this.directory, test, replyTest
      ? { order, stream: 'replies', value }
      : { order, stream: 'broadcasts', group: traceGroup(normalizedChat, String(message.type)), value });
  }
}
