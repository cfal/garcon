import { isRecord } from '../../common/json.js';
import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';
import { INTEGRATION_OPENAI_API_KEY } from './openai-test-contract.js';

export interface FakeResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string;
}

export interface FakeResponsesInputMessage {
  role: 'user' | 'assistant';
  content: string | FakeResponsesContentPart[];
}

export interface FakeResponsesRequestBody {
  model: string;
  input: FakeResponsesInputMessage[];
  stream: true;
  store: false;
  reasoning?: { effort: string };
}

export interface RecordedResponsesRequest {
  id: number;
  body: FakeResponsesRequestBody;
  rawBody: Record<string, unknown>;
  lastUserText: string;
  receivedAt: number;
  abortedAt: number | null;
}

export interface ResponsesRequestMatcher {
  lastUserText?: string;
  lastUserTextIncludes?: string;
  model?: string;
}

export interface ResponsesRequestDiagnostic {
  id: number;
  model: string;
  stream: true;
  store: false;
  lastUserText: string;
  inputRoles: Array<'user' | 'assistant'>;
  effort: string | null;
  receivedAt: number;
  abortedAt: number | null;
}

type PlannedResponse =
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'stream-error'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'malformed-then-text'; content: string }
  | { kind: 'thinking-then-text'; content: string }
  | { kind: 'empty' }
  | { kind: 'truncated-stream' }
  | { kind: 'hold'; held: HeldResponsesController };

interface ResponsePlan {
  matcher: ResponsesRequestMatcher;
  response: PlannedResponse;
}

interface RequestWaiter {
  matcher: ResponsesRequestMatcher;
  afterId: number;
  deferred: Deferred<RecordedResponsesRequest>;
}

export interface HeldResponsesRequest {
  readonly received: Promise<RecordedResponsesRequest>;
  expectAbort(): Promise<RecordedResponsesRequest>;
  releaseEcho(): void;
  releaseText(content: string): boolean;
  releaseStreamError(message: string): boolean;
  releaseTruncatedStream(): boolean;
}

class HeldResponsesController implements HeldResponsesRequest {
  readonly #received = new Deferred<RecordedResponsesRequest>();
  readonly #response = new Deferred<Response>();
  readonly #aborted = new Deferred<RecordedResponsesRequest>();
  #accepted = false;
  #released = false;
  #abortExpected = false;

  constructor() {
    void this.#received.promise.catch(() => undefined);
  }

  get received(): Promise<RecordedResponsesRequest> {
    return withTimeout(
      this.#received.promise,
      10_000,
      () => 'Timed out waiting for a held fake Responses request',
    );
  }

  accept(request: RecordedResponsesRequest): Promise<Response> {
    this.#accepted = true;
    this.#received.resolve(request);
    return this.#response.promise;
  }

  expectAbort(): Promise<RecordedResponsesRequest> {
    this.#abortExpected = true;
    return withTimeout(
      this.#aborted.promise,
      10_000,
      () => 'Timed out waiting for the held fake Responses request to abort',
    );
  }

  releaseEcho(): void {
    void this.#received.promise.then(
      (request) => this.#release(responsesTextResponse(
        `echo:${request.lastUserText}`,
        request,
      )),
      () => undefined,
    );
  }

  releaseText(content: string): boolean {
    if (!this.#received.settled) {
      void this.#received.promise.then(
        (request) => this.#release(responsesTextResponse(content, request)),
        () => undefined,
      );
      return true;
    }
    void this.#received.promise.then(
      (request) => this.#release(responsesTextResponse(content, request)),
      () => undefined,
    );
    return !this.#response.settled;
  }

  releaseStreamError(message: string): boolean {
    const released = this.#response.resolve(responsesStreamErrorResponse(message));
    this.#released = released || this.#released;
    return released;
  }

  releaseTruncatedStream(): boolean {
    const released = this.#response.resolve(responsesTruncatedStreamResponse());
    this.#released = released || this.#released;
    return released;
  }

  observeAbort(request: RecordedResponsesRequest): void {
    this.#aborted.resolve(request);
    this.#response.resolve(Response.json(
      { error: { message: 'Fake Responses request aborted' } },
      { status: 499 },
    ));
  }

  validationIssue(): string | null {
    if (!this.#accepted || this.#released) return null;
    if (this.#aborted.settled && this.#abortExpected) return null;
    if (this.#aborted.settled) {
      return 'Held fake Responses request aborted without an explicit expectation';
    }
    return 'Held fake Responses request remained unresolved';
  }

  cancel(reason: unknown): void {
    this.#received.reject(reason);
    this.#response.resolve(Response.json(
      { error: { message: reason instanceof Error ? reason.message : String(reason) } },
      { status: 503 },
    ));
  }

  #release(response: Response): void {
    const released = this.#response.resolve(response);
    this.#released = released || this.#released;
  }
}

function parseContent(value: unknown): FakeResponsesInputMessage['content'] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const content: FakeResponsesContentPart[] = [];
  for (const rawPart of value) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') return null;
    const part: FakeResponsesContentPart = { type: rawPart.type };
    if (rawPart.text !== undefined) {
      if (typeof rawPart.text !== 'string') return null;
      part.text = rawPart.text;
    }
    if (rawPart.image_url !== undefined) {
      if (typeof rawPart.image_url !== 'string') return null;
      part.image_url = rawPart.image_url;
    }
    content.push(part);
  }
  return content;
}

function parseRequestBody(value: unknown): FakeResponsesRequestBody | null {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim()) return null;
  if (value.stream !== true || value.store !== false || !Array.isArray(value.input) || !value.input.length) {
    return null;
  }

  const input: FakeResponsesInputMessage[] = [];
  for (const rawMessage of value.input) {
    if (!isRecord(rawMessage) || (rawMessage.role !== 'user' && rawMessage.role !== 'assistant')) {
      return null;
    }
    const content = parseContent(rawMessage.content);
    if (content === null) return null;
    input.push({ role: rawMessage.role, content });
  }

  let reasoning: { effort: string } | undefined;
  if (value.reasoning !== undefined) {
    if (!isRecord(value.reasoning) || typeof value.reasoning.effort !== 'string') return null;
    reasoning = { effort: value.reasoning.effort };
  }
  return {
    model: value.model,
    input,
    stream: true,
    store: false,
    ...(reasoning ? { reasoning } : {}),
  };
}

function textFromContent(content: FakeResponsesInputMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function lastUserText(input: FakeResponsesInputMessage[]): string {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index].role === 'user') return textFromContent(input[index].content);
  }
  return '';
}

function matches(request: RecordedResponsesRequest, matcher: ResponsesRequestMatcher): boolean {
  return (matcher.lastUserText === undefined || request.lastUserText === matcher.lastUserText)
    && (matcher.lastUserTextIncludes === undefined
      || request.lastUserText.includes(matcher.lastUserTextIncludes))
    && (matcher.model === undefined || request.body.model === matcher.model);
}

function deterministicChunks(content: string): string[] {
  if (content.length < 2) return [content];
  const middle = Math.ceil(content.length / 2);
  return [content.slice(0, middle), content.slice(middle)];
}

function responsesSseResponse(
  events: Array<Record<string, unknown>>,
  request?: RecordedResponsesRequest,
): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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

function responseEnvelope(
  request: RecordedResponsesRequest,
  status: string,
): Record<string, unknown> {
  return {
    id: `resp_fake_${request.id}`,
    object: 'response',
    model: request.body.model,
    status,
  };
}

function responsesTextEvents(
  content: string,
  request: RecordedResponsesRequest,
  includeReasoning = true,
): Array<Record<string, unknown>> {
  return [
    { type: 'response.created', response: responseEnvelope(request, 'in_progress') },
    ...(includeReasoning ? [{
      type: 'response.reasoning_summary_text.delta',
      delta: 'hidden fake reasoning',
    }] : []),
    ...deterministicChunks(content).map((delta) => ({
      type: 'response.output_text.delta',
      delta,
    })),
    { type: 'response.output_text.done', text: content },
    { type: 'response.completed', response: responseEnvelope(request, 'completed') },
  ];
}

function responsesTextResponse(
  content: string,
  request: RecordedResponsesRequest,
  includeReasoning = true,
): Response {
  return responsesSseResponse(responsesTextEvents(content, request, includeReasoning), request);
}

function responsesStreamErrorResponse(message: string): Response {
  return responsesSseResponse([{ type: 'error', error: { message } }]);
}

function responsesFailedResponse(message: string, request: RecordedResponsesRequest): Response {
  return responsesSseResponse([
    { type: 'response.output_text.delta', delta: 'partial' },
    {
      type: 'response.failed',
      response: { ...responseEnvelope(request, 'failed'), error: { message } },
    },
  ], request);
}

function responsesIncompleteResponse(reason: string, request: RecordedResponsesRequest): Response {
  return responsesSseResponse([
    { type: 'response.output_text.delta', delta: 'partial' },
    {
      type: 'response.incomplete',
      response: {
        ...responseEnvelope(request, 'incomplete'),
        incomplete_details: { reason },
      },
    },
  ], request);
}

function responsesEmptyResponse(request: RecordedResponsesRequest): Response {
  return responsesSseResponse([
    { type: 'response.created', response: responseEnvelope(request, 'in_progress') },
    { type: 'response.completed', response: responseEnvelope(request, 'completed') },
  ], request);
}

function responsesTruncatedStreamResponse(request?: RecordedResponsesRequest): Response {
  return responsesSseResponse([
    { type: 'response.output_text.delta', delta: 'partial' },
  ], request);
}

export class FakeOpenAiResponsesServer {
  readonly #server: Bun.Server<undefined>;
  readonly #defaultDelayMs: number;
  readonly #requests = new BoundedLog<RecordedResponsesRequest>(2_000);
  readonly #violations = new BoundedLog<string>(100);
  readonly #plans: ResponsePlan[] = [];
  readonly #waiters: RequestWaiter[] = [];
  readonly #activeHolds = new Set<HeldResponsesController>();
  readonly #holds = new Set<HeldResponsesController>();
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

  static start(options: { defaultDelayMs?: number } = {}): FakeOpenAiResponsesServer {
    return new FakeOpenAiResponsesServer(options);
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  holdNext(matcher: ResponsesRequestMatcher): HeldResponsesRequest {
    const held = new HeldResponsesController();
    this.#holds.add(held);
    this.#plans.push({ matcher, response: { kind: 'hold', held } });
    return held;
  }

  failNextHttp(matcher: ResponsesRequestMatcher, status: number, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'http-error', status, message } });
  }

  failNextStream(matcher: ResponsesRequestMatcher, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'stream-error', message } });
  }

  failNextResponse(matcher: ResponsesRequestMatcher, message: string): void {
    this.#plans.push({ matcher, response: { kind: 'failed', message } });
  }

  incompleteNextResponse(matcher: ResponsesRequestMatcher, reason: string): void {
    this.#plans.push({ matcher, response: { kind: 'incomplete', reason } });
  }

  respondEmptyNext(matcher: ResponsesRequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'empty' } });
  }

  respondMalformedThenTextNext(matcher: ResponsesRequestMatcher, content: string): void {
    this.#plans.push({ matcher, response: { kind: 'malformed-then-text', content } });
  }

  respondThinkingThenTextNext(matcher: ResponsesRequestMatcher, content: string): void {
    this.#plans.push({ matcher, response: { kind: 'thinking-then-text', content } });
  }

  truncateNextStream(matcher: ResponsesRequestMatcher): void {
    this.#plans.push({ matcher, response: { kind: 'truncated-stream' } });
  }

  requests(): readonly RecordedResponsesRequest[] {
    return this.#requests.values();
  }

  diagnosticRequests(): readonly ResponsesRequestDiagnostic[] {
    return this.requests().map((request) => ({
      id: request.id,
      model: request.body.model,
      stream: true,
      store: false,
      lastUserText: request.lastUserText,
      inputRoles: request.body.input.map((message) => message.role),
      effort: request.body.reasoning?.effort ?? null,
      receivedAt: request.receivedAt,
      abortedAt: request.abortedAt,
    }));
  }

  protocolViolations(): readonly string[] {
    return this.#violations.values();
  }

  async waitForRequest(
    matcher: ResponsesRequestMatcher,
    options: { afterId?: number; timeoutMs?: number } = {},
  ): Promise<RecordedResponsesRequest> {
    const existing = this.requests().find((request) =>
      request.id > (options.afterId ?? 0) && matches(request, matcher));
    if (existing) return existing;

    const deferred = new Deferred<RecordedResponsesRequest>();
    const waiter = { matcher, afterId: options.afterId ?? 0, deferred };
    this.#waiters.push(waiter);
    try {
      return await withTimeout(
        deferred.promise,
        options.timeoutMs ?? 10_000,
        () => `Timed out waiting for fake Responses request ${JSON.stringify(matcher)}.\n${this.describeRequests()}`,
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
    if (!violations.length && !unusedPlans.length && !holdIssues.length) return;
    throw new Error([
      ...(violations.length ? [`Fake Responses protocol violations:\n${violations.join('\n')}`] : []),
      ...(unusedPlans.length ? [`Unused fake Responses response plans:\n${unusedPlans.join('\n')}`] : []),
      ...(holdIssues.length ? [`Unsettled fake Responses holds:\n${holdIssues.join('\n')}`] : []),
    ].join('\n'));
  }

  describeRequests(): string {
    return JSON.stringify(this.diagnosticRequests(), null, 2);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const error = new Error('Fake Responses server stopped');
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
      return this.#protocolViolation('Responses request is missing the configured bearer token');
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({
        object: 'list',
        data: [{
          id: 'integration-responses-echo',
          object: 'model',
          created: 0,
          owned_by: 'garcon-integration',
        }],
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/responses') {
      return this.#protocolViolation(`${request.method} ${url.pathname} is not supported`);
    }
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return this.#protocolViolation('Responses content type must be application/json');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return this.#protocolViolation('Responses body is not valid JSON');
    }
    const body = parseRequestBody(rawBody);
    if (!body || !isRecord(rawBody)) {
      return this.#protocolViolation(`Invalid Responses request: ${JSON.stringify(rawBody)}`);
    }

    const recorded: RecordedResponsesRequest = {
      id: ++this.#requestId,
      body,
      rawBody,
      lastUserText: lastUserText(body.input),
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
    if (plan?.kind === 'stream-error') return responsesStreamErrorResponse(plan.message);
    if (plan?.kind === 'failed') return responsesFailedResponse(plan.message, recorded);
    if (plan?.kind === 'incomplete') return responsesIncompleteResponse(plan.reason, recorded);
    if (plan?.kind === 'thinking-then-text') {
      return responsesTextResponse(plan.content, recorded, true);
    }
    if (plan?.kind === 'malformed-then-text') {
      const valid = await responsesTextResponse(plan.content, recorded).text();
      return new Response(`data: {not-json}\n\n${valid}`, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    if (plan?.kind === 'empty') return responsesEmptyResponse(recorded);
    if (plan?.kind === 'truncated-stream') return responsesTruncatedStreamResponse(recorded);

    if (this.#defaultDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#defaultDelayMs));
    }
    return responsesTextResponse(`echo:${recorded.lastUserText}`, recorded);
  }

  #resolveRequestWaiters(request: RecordedResponsesRequest): void {
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
