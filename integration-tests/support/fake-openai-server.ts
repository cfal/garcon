import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';
import { INTEGRATION_OPENAI_API_KEY } from './openai-test-contract.js';

export interface FakeOpenAiContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface FakeOpenAiMessage {
  role: 'user' | 'assistant';
  content: string | FakeOpenAiContentPart[];
}

export interface FakeChatCompletionRequestBody {
  model: string;
  messages: FakeOpenAiMessage[];
  stream: boolean;
  reasoning_effort?: string;
}

export interface RecordedCompletionRequest {
  id: number;
  body: FakeChatCompletionRequestBody;
  rawBody: Record<string, unknown>;
  lastUserText: string;
  receivedAt: number;
  abortedAt: number | null;
}

export interface RequestMatcher {
  lastUserText?: string;
  model?: string;
}

type PlannedResponse =
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'stream-error'; message: string }
  | { kind: 'malformed-then-text'; content: string }
  | { kind: 'empty' }
  | { kind: 'truncated-stream' }
  | { kind: 'hold'; held: HeldCompletionController };

interface ResponsePlan {
  matcher: RequestMatcher;
  response: PlannedResponse;
}

interface RequestWaiter {
  matcher: RequestMatcher;
  afterId: number;
  deferred: Deferred<RecordedCompletionRequest>;
}

export interface HeldCompletion {
  readonly received: Promise<RecordedCompletionRequest>;
  expectAbort(): Promise<RecordedCompletionRequest>;
  releaseEcho(): void;
  releaseText(content: string): boolean;
  releaseStreamError(message: string): boolean;
  releaseTruncatedStream(): boolean;
}

class HeldCompletionController implements HeldCompletion {
  readonly #received = new Deferred<RecordedCompletionRequest>();
  readonly #response = new Deferred<Response>();
  readonly #aborted = new Deferred<RecordedCompletionRequest>();
  #accepted = false;
  #released = false;
  #abortExpected = false;

  constructor() {
    void this.#received.promise.catch(() => undefined);
  }

  get received(): Promise<RecordedCompletionRequest> {
    return withTimeout(
      this.#received.promise,
      10_000,
      () => 'Timed out waiting for a held fake-provider request',
    );
  }

  accept(request: RecordedCompletionRequest): Promise<Response> {
    this.#accepted = true;
    this.#received.resolve(request);
    return this.#response.promise;
  }

  expectAbort(): Promise<RecordedCompletionRequest> {
    this.#abortExpected = true;
    return withTimeout(
      this.#aborted.promise,
      10_000,
      () => 'Timed out waiting for the held fake-provider request to abort',
    );
  }

  releaseEcho(): void {
    void this.#received.promise.then(
      (request) => {
        this.#released = this.#response.resolve(
          sseTextResponse(`echo:${request.lastUserText}`, request),
        ) || this.#released;
      },
      () => undefined,
    );
  }

  releaseText(content: string): boolean {
    const released = this.#response.resolve(sseTextResponse(content));
    this.#released = released || this.#released;
    return released;
  }

  releaseStreamError(message: string): boolean {
    const released = this.#response.resolve(sseErrorResponse(message));
    this.#released = released || this.#released;
    return released;
  }

  releaseTruncatedStream(): boolean {
    const released = this.#response.resolve(truncatedStreamResponse());
    this.#released = released || this.#released;
    return released;
  }

  observeAbort(request: RecordedCompletionRequest): void {
    this.#aborted.resolve(request);
    this.#response.resolve(Response.json(
      { error: { message: 'Fake provider request aborted' } },
      { status: 499 },
    ));
  }

  validationIssue(): string | null {
    if (!this.#accepted) return null;
    if (this.#released) return null;
    if (this.#aborted.settled && this.#abortExpected) return null;
    if (this.#aborted.settled) return 'Held fake-provider request aborted without an explicit expectation';
    return 'Held fake-provider request remained unresolved';
  }

  cancel(reason: unknown): void {
    this.#received.reject(reason);
    this.#response.resolve(Response.json(
      { error: { message: reason instanceof Error ? reason.message : String(reason) } },
      { status: 503 },
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseContent(value: unknown): string | FakeOpenAiContentPart[] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const parts: FakeOpenAiContentPart[] = [];
  for (const rawPart of value) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') return null;
    const part: FakeOpenAiContentPart = { type: rawPart.type };
    if (rawPart.text !== undefined) {
      if (typeof rawPart.text !== 'string') return null;
      part.text = rawPart.text;
    }
    if (rawPart.image_url !== undefined) {
      if (!isRecord(rawPart.image_url) || typeof rawPart.image_url.url !== 'string') return null;
      part.image_url = { url: rawPart.image_url.url };
    }
    parts.push(part);
  }
  return parts;
}

function parseCompletionBody(value: unknown): FakeChatCompletionRequestBody | null {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim()) return null;
  if (value.stream !== true || !Array.isArray(value.messages) || value.messages.length === 0) return null;

  const messages: FakeOpenAiMessage[] = [];
  for (const rawMessage of value.messages) {
    if (!isRecord(rawMessage) || (rawMessage.role !== 'user' && rawMessage.role !== 'assistant')) {
      return null;
    }
    const content = parseContent(rawMessage.content);
    if (content === null) return null;
    messages.push({ role: rawMessage.role, content });
  }

  if (value.reasoning_effort !== undefined && typeof value.reasoning_effort !== 'string') return null;
  return {
    model: value.model,
    messages,
    stream: true,
    ...(typeof value.reasoning_effort === 'string'
      ? { reasoning_effort: value.reasoning_effort }
      : {}),
  };
}

function textFromContent(content: FakeOpenAiMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function lastUserText(messages: FakeOpenAiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return textFromContent(messages[index].content);
  }
  return '';
}

function matches(request: RecordedCompletionRequest, matcher: RequestMatcher): boolean {
  return (matcher.lastUserText === undefined || request.lastUserText === matcher.lastUserText)
    && (matcher.model === undefined || request.body.model === matcher.model);
}

function sseResponse(
  events: Array<Record<string, unknown> | '[DONE]'>,
  request?: RecordedCompletionRequest,
): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const data = event === '[DONE]' ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
    cancel() {
      if (request && request.abortedAt === null) request.abortedAt = Date.now();
    },
  }), {
    status: 200,
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

function deterministicChunks(content: string): string[] {
  if (content.length < 2) return [content];
  const middle = Math.ceil(content.length / 2);
  return [content.slice(0, middle), content.slice(middle)];
}

function sseTextResponse(content: string, request?: RecordedCompletionRequest): Response {
  const events: Array<Record<string, unknown> | '[DONE]'> = deterministicChunks(content).map((chunk) => ({
    choices: [{ delta: { content: chunk } }],
  }));
  events.push('[DONE]');
  return sseResponse(events, request);
}

function sseErrorResponse(message: string): Response {
  return sseResponse([{ error: { message } }, '[DONE]']);
}

function truncatedStreamResponse(request?: RecordedCompletionRequest): Response {
  return sseResponse([{
    choices: [{ delta: { content: 'partial' } }],
  }], request);
}

export class FakeOpenAiServer {
  readonly #server: Bun.Server<undefined>;
  readonly #defaultDelayMs: number;
  readonly #requests = new BoundedLog<RecordedCompletionRequest>(2_000);
  readonly #violations = new BoundedLog<string>(100);
  readonly #plans: ResponsePlan[] = [];
  readonly #waiters: RequestWaiter[] = [];
  readonly #activeHolds = new Set<HeldCompletionController>();
  readonly #holds = new Set<HeldCompletionController>();
  #requestId = 0;
  #stopped = false;

  private constructor(options: { defaultDelayMs?: number }) {
    this.#defaultDelayMs = options.defaultDelayMs ?? 5;
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => this.#handleRequest(request),
    });
  }

  static start(options: { defaultDelayMs?: number } = {}): FakeOpenAiServer {
    return new FakeOpenAiServer(options);
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  holdNext(matcher: RequestMatcher): HeldCompletion {
    const held = new HeldCompletionController();
    this.#holds.add(held);
    this.#plans.push({ matcher, response: { kind: 'hold', held } });
    return held;
  }

  failNextHttp(matcher: RequestMatcher, status: number, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'http-error', status, message } });
  }

  failNextStream(matcher: RequestMatcher, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'stream-error', message } });
  }

  respondEmptyNext(matcher: RequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'empty' } });
  }

  respondMalformedThenTextNext(matcher: RequestMatcher, content: string): void {
    this.#plans.push({ matcher, response: { kind: 'malformed-then-text', content } });
  }

  truncateNextStream(matcher: RequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'truncated-stream' } });
  }

  requests(): readonly RecordedCompletionRequest[] {
    return this.#requests.values();
  }

  protocolViolations(): readonly string[] {
    return this.#violations.values();
  }

  async waitForRequest(
    matcher: RequestMatcher,
    options: { afterId?: number; timeoutMs?: number } = {},
  ): Promise<RecordedCompletionRequest> {
    const existing = this.requests().find((request) =>
      request.id > (options.afterId ?? 0) && matches(request, matcher));
    if (existing) return existing;

    const deferred = new Deferred<RecordedCompletionRequest>();
    const waiter = { matcher, afterId: options.afterId ?? 0, deferred };
    this.#waiters.push(waiter);
    try {
      return await withTimeout(
        deferred.promise,
        options.timeoutMs ?? 10_000,
        () => `Timed out waiting for fake-provider request ${JSON.stringify(matcher)}.\n${this.describeRequests()}`,
      );
    } finally {
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
    }
  }

  assertNoProtocolViolations(): void {
    const violations = this.protocolViolations();
    const unusedPlans = this.#plans.map((plan) => JSON.stringify(plan.matcher));
    const holdIssues = [...this.#holds].flatMap((held) => {
      const issue = held.validationIssue();
      return issue ? [issue] : [];
    });
    if (violations.length > 0 || unusedPlans.length > 0 || holdIssues.length > 0) {
      throw new Error([
        ...(violations.length > 0 ? [`Fake OpenAI protocol violations:\n${violations.join('\n')}`] : []),
        ...(unusedPlans.length > 0 ? [`Unused fake-provider response plans:\n${unusedPlans.join('\n')}`] : []),
        ...(holdIssues.length > 0 ? [`Unsettled fake-provider holds:\n${holdIssues.join('\n')}`] : []),
      ].join('\n'));
    }
  }

  describeRequests(): string {
    return JSON.stringify(this.requests().map((request) => ({
      id: request.id,
      model: request.body.model,
      lastUserText: request.lastUserText,
      messages: request.body.messages,
      abortedAt: request.abortedAt,
    })), null, 2);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const error = new Error('Fake OpenAI server stopped');
    for (const plan of this.#plans) {
      if (plan.response.kind === 'hold') plan.response.held.cancel(error);
    }
    for (const held of this.#activeHolds) held.cancel(error);
    for (const waiter of this.#waiters) waiter.deferred.reject(error);
    this.#plans.length = 0;
    this.#waiters.length = 0;
    this.#server.stop(true);
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== `Bearer ${INTEGRATION_OPENAI_API_KEY}`) {
      return this.#protocolViolation('OpenAI request is missing the configured bearer token');
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({
        object: 'list',
        data: [{
          id: 'integration-echo',
          object: 'model',
          created: 0,
          owned_by: 'garcon-integration',
        }],
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return this.#protocolViolation(`${request.method} ${url.pathname} is not supported`);
    }
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return this.#protocolViolation('Chat completion content type must be application/json');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return this.#protocolViolation('Chat completion body is not valid JSON');
    }
    const body = parseCompletionBody(rawBody);
    if (!body || !isRecord(rawBody)) {
      return this.#protocolViolation(`Invalid chat completion request: ${JSON.stringify(rawBody)}`);
    }

    const recorded: RecordedCompletionRequest = {
      id: ++this.#requestId,
      body,
      rawBody,
      lastUserText: lastUserText(body.messages),
      receivedAt: Date.now(),
      abortedAt: null,
    };
    request.signal.addEventListener('abort', () => {
      if (recorded.abortedAt === null) recorded.abortedAt = Date.now();
    }, { once: true });
    this.#requests.push(recorded);
    this.#resolveRequestWaiters(recorded);

    const planIndex = this.#plans.findIndex((plan) => matches(recorded, plan.matcher));
    const plan = planIndex >= 0 ? this.#plans.splice(planIndex, 1)[0].response : null;
    if (plan?.kind === 'hold') {
      this.#activeHolds.add(plan.held);
      request.signal.addEventListener('abort', () => plan.held.observeAbort(recorded), { once: true });
      try {
        return await plan.held.accept(recorded);
      } finally {
        this.#activeHolds.delete(plan.held);
      }
    }
    if (plan?.kind === 'http-error') {
      return Response.json({ error: { message: plan.message } }, { status: plan.status });
    }
    if (plan?.kind === 'stream-error') return sseErrorResponse(plan.message);
    if (plan?.kind === 'malformed-then-text') {
      const validEvents: Array<Record<string, unknown> | '[DONE]'> = [
        { choices: [{ delta: { content: plan.content } }] },
        '[DONE]',
      ];
      const response = sseResponse(validEvents);
      const validBody = await response.text();
      return new Response(`data: {not-json}\n\n${validBody}`, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    if (plan?.kind === 'empty') return sseResponse(['[DONE]']);
    if (plan?.kind === 'truncated-stream') return truncatedStreamResponse(recorded);

    if (this.#defaultDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#defaultDelayMs));
    }
    return sseTextResponse(`echo:${recorded.lastUserText}`, recorded);
  }

  #resolveRequestWaiters(request: RecordedCompletionRequest): void {
    for (const waiter of [...this.#waiters]) {
      if (request.id > waiter.afterId && matches(request, waiter.matcher)) {
        waiter.deferred.resolve(request);
      }
    }
  }

  #protocolViolation(message: string): Response {
    this.#violations.push(message);
    return Response.json({ error: { message } }, { status: 400 });
  }
}
