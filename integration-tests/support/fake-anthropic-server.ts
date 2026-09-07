import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';
import { isRecord } from '../../common/json.js';
import {
  INTEGRATION_ANTHROPIC_API_KEY,
  INTEGRATION_ANTHROPIC_VERSION,
} from './anthropic-test-contract.js';

export interface FakeAnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface FakeAnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface FakeAnthropicDocumentBlock {
  type: 'document';
  source: Record<string, unknown>;
  title?: string;
}

export type FakeAnthropicContentBlock =
  | FakeAnthropicTextBlock
  | FakeAnthropicImageBlock
  | FakeAnthropicDocumentBlock;

export interface FakeAnthropicMessage {
  role: 'user' | 'assistant';
  content: string | FakeAnthropicContentBlock[];
}

export interface FakeAnthropicMessageRequestBody {
  model: string;
  max_tokens: number;
  messages: FakeAnthropicMessage[];
  stream: boolean;
  output_config?: { effort: string };
}

export interface RecordedAnthropicRequest {
  id: number;
  body: FakeAnthropicMessageRequestBody;
  rawBody: Record<string, unknown>;
  lastUserText: string;
  receivedAt: number;
  abortedAt: number | null;
}

export interface AnthropicRequestMatcher {
  lastUserText?: string;
  model?: string;
  stream?: boolean;
}

export interface AnthropicRequestDiagnostic {
  id: number;
  model: string;
  stream: boolean;
  lastUserText: string;
  messageRoles: Array<'user' | 'assistant'>;
  effort: string | null;
  receivedAt: number;
  abortedAt: number | null;
}

type PlannedResponse =
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'stream-error'; message: string }
  | { kind: 'malformed-then-text'; content: string }
  | { kind: 'thinking-then-text'; content: string }
  | { kind: 'empty' }
  | { kind: 'truncated-stream' }
  | { kind: 'hold'; held: HeldAnthropicMessageController };

interface ResponsePlan {
  matcher: AnthropicRequestMatcher;
  response: PlannedResponse;
}

interface RequestWaiter {
  matcher: AnthropicRequestMatcher;
  afterId: number;
  deferred: Deferred<RecordedAnthropicRequest>;
}

interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface HeldAnthropicMessage {
  readonly received: Promise<RecordedAnthropicRequest>;
  expectAbort(): Promise<RecordedAnthropicRequest>;
  releaseEcho(): void;
  releaseText(content: string): boolean;
  releaseStreamError(message: string): boolean;
  releaseTruncatedStream(): boolean;
}

class HeldAnthropicMessageController implements HeldAnthropicMessage {
  readonly #received = new Deferred<RecordedAnthropicRequest>();
  readonly #response = new Deferred<Response>();
  readonly #aborted = new Deferred<RecordedAnthropicRequest>();
  #accepted = false;
  #released = false;
  #abortExpected = false;

  constructor() {
    void this.#received.promise.catch(() => undefined);
  }

  get received(): Promise<RecordedAnthropicRequest> {
    return withTimeout(
      this.#received.promise,
      10_000,
      () => 'Timed out waiting for a held fake Anthropic request',
    );
  }

  accept(request: RecordedAnthropicRequest): Promise<Response> {
    this.#accepted = true;
    this.#received.resolve(request);
    return this.#response.promise;
  }

  expectAbort(): Promise<RecordedAnthropicRequest> {
    this.#abortExpected = true;
    return withTimeout(
      this.#aborted.promise,
      10_000,
      () => 'Timed out waiting for the held fake Anthropic request to abort',
    );
  }

  releaseEcho(): void {
    void this.#received.promise.then(
      (request) => {
        const released = this.#response.resolve(anthropicTextResponse(
          `echo:${request.lastUserText}`,
          request,
        ));
        this.#released = released || this.#released;
      },
      () => undefined,
    );
  }

  releaseText(content: string): boolean {
    if (!this.#received.settled) {
      void this.#received.promise.then(
        (request) => {
          const released = this.#response.resolve(anthropicTextResponse(content, request));
          this.#released = released || this.#released;
        },
        () => undefined,
      );
      return true;
    }
    return this.#releaseForReceived((request) => anthropicTextResponse(content, request));
  }

  releaseStreamError(message: string): boolean {
    return this.#releaseForReceived((request) => anthropicStreamErrorResponse(message, request));
  }

  releaseTruncatedStream(): boolean {
    return this.#releaseForReceived((request) => anthropicTruncatedStreamResponse(request));
  }

  observeAbort(request: RecordedAnthropicRequest): void {
    this.#aborted.resolve(request);
    this.#response.resolve(anthropicErrorResponse('Fake Anthropic request aborted', 499));
  }

  validationIssue(): string | null {
    if (!this.#accepted) return null;
    if (this.#released) return null;
    if (this.#aborted.settled && this.#abortExpected) return null;
    if (this.#aborted.settled) {
      return 'Held fake Anthropic request aborted without an explicit expectation';
    }
    return 'Held fake Anthropic request remained unresolved';
  }

  cancel(reason: unknown): void {
    this.#received.reject(reason);
    this.#response.resolve(anthropicErrorResponse(
      reason instanceof Error ? reason.message : String(reason),
      503,
    ));
  }

  #releaseForReceived(factory: (request: RecordedAnthropicRequest) => Response): boolean {
    if (!this.#received.settled) return false;
    void this.#received.promise.then(
      (request) => {
        const released = this.#response.resolve(factory(request));
        this.#released = released || this.#released;
      },
      () => undefined,
    );
    if (this.#response.settled) return false;
    this.#released = true;
    return true;
  }
}

function parseContentBlock(value: unknown): FakeAnthropicContentBlock | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text };
  }
  if (value.type === 'image' && isRecord(value.source)) {
    const source = value.source;
    if (
      source.type !== 'base64'
      || typeof source.media_type !== 'string'
      || typeof source.data !== 'string'
    ) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: source.media_type, data: source.data },
    };
  }
  if (value.type === 'document' && isRecord(value.source)) {
    if (value.title !== undefined && typeof value.title !== 'string') return null;
    return {
      type: 'document',
      source: value.source,
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
    };
  }
  return null;
}

function parseMessageContent(value: unknown): FakeAnthropicMessage['content'] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const blocks: FakeAnthropicContentBlock[] = [];
  for (const rawBlock of value) {
    const block = parseContentBlock(rawBlock);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
}

function parseMessageBody(value: unknown): FakeAnthropicMessageRequestBody | null {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim()) return null;
  if (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0) return null;
  if (!Array.isArray(value.messages) || value.messages.length === 0) return null;
  if (value.stream !== undefined && typeof value.stream !== 'boolean') return null;

  const messages: FakeAnthropicMessage[] = [];
  for (const rawMessage of value.messages) {
    if (!isRecord(rawMessage) || (rawMessage.role !== 'user' && rawMessage.role !== 'assistant')) {
      return null;
    }
    const content = parseMessageContent(rawMessage.content);
    if (content === null) return null;
    messages.push({ role: rawMessage.role, content });
  }

  let outputConfig: { effort: string } | undefined;
  if (value.output_config !== undefined) {
    if (!isRecord(value.output_config) || typeof value.output_config.effort !== 'string') return null;
    outputConfig = { effort: value.output_config.effort };
  }
  return {
    model: value.model,
    max_tokens: value.max_tokens as number,
    messages,
    stream: value.stream ?? false,
    ...(outputConfig ? { output_config: outputConfig } : {}),
  };
}

function textFromContent(content: FakeAnthropicMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is FakeAnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function lastUserText(messages: FakeAnthropicMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') return textFromContent(message.content);
  }
  return '';
}

function matches(
  request: RecordedAnthropicRequest,
  matcher: AnthropicRequestMatcher,
): boolean {
  return (matcher.lastUserText === undefined || request.lastUserText === matcher.lastUserText)
    && (matcher.model === undefined || request.body.model === matcher.model)
    && (matcher.stream === undefined || request.body.stream === matcher.stream);
}

function deterministicChunks(content: string): string[] {
  if (content.length < 2) return [content];
  const middle = Math.ceil(content.length / 2);
  return [content.slice(0, middle), content.slice(middle)];
}

function baseMessage(request: RecordedAnthropicRequest): Record<string, unknown> {
  return {
    id: `msg_fake_${request.id}`,
    type: 'message',
    role: 'assistant',
    model: request.body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  };
}

function textStreamEvents(
  content: string,
  request: RecordedAnthropicRequest,
): AnthropicSseEvent[] {
  return [
    {
      event: 'message_start',
      data: { type: 'message_start', message: baseMessage(request) },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    ...deterministicChunks(content).map((text) => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    })),
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function thinkingThenTextStreamEvents(
  content: string,
  request: RecordedAnthropicRequest,
): AnthropicSseEvent[] {
  return [
    {
      event: 'message_start',
      data: { type: 'message_start', message: baseMessage(request) },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hidden fake reasoning' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'fake-signature' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
    },
    ...deterministicChunks(content).map((text) => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text },
      },
    })),
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function anthropicSseResponse(
  events: AnthropicSseEvent[],
  request?: RecordedAnthropicRequest,
): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        ));
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

function anthropicJsonMessageResponse(
  content: string,
  request: RecordedAnthropicRequest,
): Response {
  return Response.json({
    ...baseMessage(request),
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function anthropicTextResponse(
  content: string,
  request: RecordedAnthropicRequest,
): Response {
  return request.body.stream
    ? anthropicSseResponse(textStreamEvents(content, request), request)
    : anthropicJsonMessageResponse(content, request);
}

function anthropicStreamErrorResponse(
  message: string,
  request?: RecordedAnthropicRequest,
): Response {
  return anthropicSseResponse([{
    event: 'error',
    data: { type: 'error', error: { type: 'api_error', message } },
  }], request);
}

function anthropicTruncatedStreamResponse(request: RecordedAnthropicRequest): Response {
  return anthropicSseResponse(textStreamEvents('partial', request).filter(
    (event) => event.event !== 'message_delta' && event.event !== 'message_stop',
  ), request);
}

function anthropicEmptyStreamResponse(request: RecordedAnthropicRequest): Response {
  return anthropicSseResponse([
    { event: 'message_start', data: { type: 'message_start', message: baseMessage(request) } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ], request);
}

function anthropicErrorResponse(message: string, status: number): Response {
  return Response.json({
    type: 'error',
    error: { type: 'invalid_request_error', message },
  }, { status });
}

export class FakeAnthropicServer {
  readonly #server: Bun.Server<undefined>;
  readonly #defaultDelayMs: number;
  readonly #requests = new BoundedLog<RecordedAnthropicRequest>(2_000);
  readonly #violations = new BoundedLog<string>(100);
  readonly #plans: ResponsePlan[] = [];
  readonly #waiters: RequestWaiter[] = [];
  readonly #activeHolds = new Set<HeldAnthropicMessageController>();
  readonly #holds = new Set<HeldAnthropicMessageController>();
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

  static start(options: { defaultDelayMs?: number } = {}): FakeAnthropicServer {
    return new FakeAnthropicServer(options);
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  holdNext(matcher: AnthropicRequestMatcher): HeldAnthropicMessage {
    const held = new HeldAnthropicMessageController();
    this.#holds.add(held);
    this.#plans.push({ matcher, response: { kind: 'hold', held } });
    return held;
  }

  failNextHttp(matcher: AnthropicRequestMatcher, status: number, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'http-error', status, message } });
  }

  failNextStream(matcher: AnthropicRequestMatcher, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'stream-error', message } });
  }

  respondEmptyNext(matcher: AnthropicRequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'empty' } });
  }

  respondMalformedThenTextNext(matcher: AnthropicRequestMatcher, content: string): void {
    this.#plans.push({ matcher, response: { kind: 'malformed-then-text', content } });
  }

  respondThinkingThenTextNext(matcher: AnthropicRequestMatcher, content: string): void {
    this.#plans.push({ matcher, response: { kind: 'thinking-then-text', content } });
  }

  truncateNextStream(matcher: AnthropicRequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'truncated-stream' } });
  }

  requests(): readonly RecordedAnthropicRequest[] {
    return this.#requests.values();
  }

  diagnosticRequests(): readonly AnthropicRequestDiagnostic[] {
    return this.requests().map((request) => ({
      id: request.id,
      model: request.body.model,
      stream: request.body.stream,
      lastUserText: request.lastUserText,
      messageRoles: request.body.messages.map((message) => message.role),
      effort: request.body.output_config?.effort ?? null,
      receivedAt: request.receivedAt,
      abortedAt: request.abortedAt,
    }));
  }

  protocolViolations(): readonly string[] {
    return this.#violations.values();
  }

  async waitForRequest(
    matcher: AnthropicRequestMatcher,
    options: { afterId?: number; timeoutMs?: number } = {},
  ): Promise<RecordedAnthropicRequest> {
    const existing = this.requests().find((request) =>
      request.id > (options.afterId ?? 0) && matches(request, matcher));
    if (existing) return existing;

    const deferred = new Deferred<RecordedAnthropicRequest>();
    const waiter = { matcher, afterId: options.afterId ?? 0, deferred };
    this.#waiters.push(waiter);
    try {
      return await withTimeout(
        deferred.promise,
        options.timeoutMs ?? 10_000,
        () => `Timed out waiting for fake Anthropic request ${JSON.stringify(matcher)}.\n${this.describeRequests()}`,
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
        ...(violations.length > 0
          ? [`Fake Anthropic protocol violations:\n${violations.join('\n')}`]
          : []),
        ...(unusedPlans.length > 0
          ? [`Unused fake Anthropic response plans:\n${unusedPlans.join('\n')}`]
          : []),
        ...(holdIssues.length > 0
          ? [`Unsettled fake Anthropic holds:\n${holdIssues.join('\n')}`]
          : []),
      ].join('\n'));
    }
  }

  describeRequests(): string {
    return JSON.stringify(this.diagnosticRequests(), null, 2);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const error = new Error('Fake Anthropic server stopped');
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
    if (request.headers.get('x-api-key') !== INTEGRATION_ANTHROPIC_API_KEY) {
      return this.#protocolViolation('Anthropic request is missing the configured x-api-key');
    }
    if (request.headers.get('anthropic-version') !== INTEGRATION_ANTHROPIC_VERSION) {
      return this.#protocolViolation(
        `Anthropic request must use version ${INTEGRATION_ANTHROPIC_VERSION}`,
      );
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      if (!validModelsQuery(url)) {
        return this.#protocolViolation(`Invalid Anthropic models query: ${url.search}`);
      }
      return Response.json({
        data: [{
          type: 'model',
          id: 'integration-anthropic-echo',
          display_name: 'Integration Anthropic Echo',
          created_at: '2026-01-01T00:00:00Z',
        }],
        has_more: false,
        first_id: 'integration-anthropic-echo',
        last_id: 'integration-anthropic-echo',
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      return this.#protocolViolation(`${request.method} ${url.pathname} is not supported`);
    }
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return this.#protocolViolation('Anthropic Messages content type must be application/json');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return this.#protocolViolation('Anthropic Messages body is not valid JSON');
    }
    const body = parseMessageBody(rawBody);
    if (!body || !isRecord(rawBody)) {
      return this.#protocolViolation(`Invalid Anthropic Messages request: ${JSON.stringify(rawBody)}`);
    }

    const recorded: RecordedAnthropicRequest = {
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
      return anthropicErrorResponse(plan.message, plan.status);
    }
    if (plan?.kind === 'stream-error') return anthropicStreamErrorResponse(plan.message, recorded);
    if (plan?.kind === 'thinking-then-text') {
      return anthropicSseResponse(thinkingThenTextStreamEvents(plan.content, recorded), recorded);
    }
    if (plan?.kind === 'malformed-then-text') {
      if (!recorded.body.stream) return anthropicJsonMessageResponse(plan.content, recorded);
      const valid = await anthropicSseResponse(textStreamEvents(plan.content, recorded)).text();
      return new Response(`event: content_block_delta\ndata: {not-json}\n\n${valid}`, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    if (plan?.kind === 'empty') {
      return recorded.body.stream
        ? anthropicEmptyStreamResponse(recorded)
        : anthropicJsonMessageResponse('', recorded);
    }
    if (plan?.kind === 'truncated-stream') return anthropicTruncatedStreamResponse(recorded);

    if (this.#defaultDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#defaultDelayMs));
    }
    return anthropicTextResponse(`echo:${recorded.lastUserText}`, recorded);
  }

  #resolveRequestWaiters(request: RecordedAnthropicRequest): void {
    for (const waiter of [...this.#waiters]) {
      if (request.id > waiter.afterId && matches(request, waiter.matcher)) {
        waiter.deferred.resolve(request);
      }
    }
  }

  #protocolViolation(message: string): Response {
    this.#violations.push(message);
    return anthropicErrorResponse(message, 400);
  }
}

function validModelsQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (key !== 'limit' && key !== 'after_id') return false;
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) <= 0)) return false;
  const afterId = url.searchParams.get('after_id');
  return afterId === null || afterId.length > 0;
}
