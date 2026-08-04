// Scripted stand-in for the model behind a real chat-completions CLI (Pi today, opencode
// later). The CLI speaks the OpenAI Chat Completions API, so pointing it here keeps CLI
// behavior real -- process lifecycle, local tool execution, session persistence -- while the
// model's choices become a deterministic test script. This is the Chat Completions sibling of
// FakeClaudeModel/FakeCodexModel; FakeOpenAiServer remains the plan-based strict double for
// the direct-* Garcon agents.

export type ChatCompletionsBlock =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

export type ChatCompletionsTurn =
  | ChatCompletionsBlock[]
  | ((
      request: RecordedChatCompletionsRequest,
    ) => ChatCompletionsBlock[] | Promise<ChatCompletionsBlock[]>);

export type ChatCompletionsFault =
  | { readonly kind: 'http-error'; readonly status: number; readonly message: string }
  | { readonly kind: 'stream-error'; readonly message: string };

export interface HeldChatCompletionsTurn {
  readonly requested: Promise<RecordedChatCompletionsRequest>;
  release(): void;
}

export interface RecordedChatCompletionsRequest {
  readonly id: number;
  readonly body: Record<string, unknown>;
  readonly userTexts: readonly string[];
  readonly lastUserText: string;
  readonly toolResults: ReadonlyArray<{ toolCallId: string; content: string }>;
  readonly receivedAt: number;
}

export function chatCompletionsText(text: string): ChatCompletionsBlock {
  return { kind: 'text', text };
}

export function chatCompletionsToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ChatCompletionsBlock {
  return { kind: 'tool_use', id, name, input };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function userTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return [];
  const texts: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== 'user') continue;
    const text = textFromContent(message.content);
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function toolResults(
  body: Record<string, unknown>,
): Array<{ toolCallId: string; content: string }> {
  if (!Array.isArray(body.messages)) return [];
  const results: Array<{ toolCallId: string; content: string }> = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== 'tool') continue;
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    results.push({ toolCallId, content: textFromContent(message.content) });
  }
  return results;
}

// Validates the conversation contract Pi owes the model; deliberately lenient about extra
// fields -- the CLI's request shape is its own business (same posture as FakeClaudeModel).
function validateRequest(body: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(body)) return ['Chat completions request body was not an object'];
  if (!Array.isArray(body.messages)) {
    issues.push('Chat completions request omitted the messages array');
  } else {
    for (const message of body.messages) {
      if (!isRecord(message)) {
        issues.push('Chat completions message was not an object');
        continue;
      }
      if (typeof message.role !== 'string') issues.push('Chat completions message lacked a role');
      if (message.role === 'tool' && typeof message.tool_call_id !== 'string') {
        issues.push('Chat completions tool message lacked tool_call_id');
      }
    }
  }
  if (body.stream !== true) issues.push('Chat completions request did not ask for streaming');
  return issues;
}

interface Chunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: Array<Record<string, unknown>>;
  readonly usage?: Record<string, unknown>;
}

function chunk(model: string, requestId: number, choice: Record<string, unknown>): Chunk {
  return {
    id: `chatcmpl_scripted_${requestId}`,
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [choice],
  };
}

function turnChunks(
  blocks: ChatCompletionsBlock[],
  request: RecordedChatCompletionsRequest,
): Chunk[] {
  const model = String(request.body.model ?? 'scripted');
  const chunks: Chunk[] = [chunk(model, request.id, {
    index: 0,
    delta: { role: 'assistant', content: '' },
    finish_reason: null,
  })];
  let toolIndex = 0;
  for (const block of blocks) {
    if (block.kind === 'text') {
      chunks.push(chunk(model, request.id, {
        index: 0,
        delta: { content: block.text },
        finish_reason: null,
      }));
      continue;
    }
    chunks.push(chunk(model, request.id, {
      index: 0,
      delta: {
        tool_calls: [{
          index: toolIndex,
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: '' },
        }],
      },
      finish_reason: null,
    }));
    chunks.push(chunk(model, request.id, {
      index: 0,
      delta: {
        tool_calls: [{ index: toolIndex, function: { arguments: JSON.stringify(block.input) } }],
      },
      finish_reason: null,
    }));
    toolIndex += 1;
  }
  const finishReason = blocks.some((block) => block.kind === 'tool_use') ? 'tool_calls' : 'stop';
  chunks.push(chunk(model, request.id, { index: 0, delta: {}, finish_reason: finishReason }));
  chunks.push({
    ...chunk(model, request.id, { index: 0, delta: {}, finish_reason: finishReason }),
    choices: [],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  });
  return chunks;
}

function sseResponse(chunks: Chunk[], options: { truncated?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const emitted = options.truncated ? chunks.slice(0, 1) : chunks;
      for (const payload of emitted) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      if (!options.truncated) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

export class FakeChatCompletionsModel {
  readonly #server: Bun.Server<undefined>;
  readonly #turns: Array<ChatCompletionsTurn | ChatCompletionsFault> = [];
  readonly #requests: RecordedChatCompletionsRequest[] = [];
  readonly #violations: string[] = [];
  readonly #otherRequests: string[] = [];
  readonly #pendingReleases = new Set<() => void>();
  #requestId = 0;
  #stopped = false;

  private constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: (request) => this.#handleRequest(request),
    });
  }

  static start(): FakeChatCompletionsModel {
    return new FakeChatCompletionsModel();
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  scriptTurn(turn: ChatCompletionsTurn): void {
    this.#turns.push(turn);
  }

  scriptHeldTurn(turn: ChatCompletionsTurn): HeldChatCompletionsTurn {
    let resolveRequested!: (request: RecordedChatCompletionsRequest) => void;
    const requested = new Promise<RecordedChatCompletionsRequest>((resolve) => {
      resolveRequested = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#pendingReleases.delete(release);
      releaseGate();
    };
    this.#pendingReleases.add(release);
    // Holds the response before its first SSE chunk. The CLI enforces request timeouts, so
    // callers release the turn promptly.
    this.#turns.push(async (request) => {
      resolveRequested(request);
      await gate;
      return typeof turn === 'function' ? turn(request) : turn;
    });
    return { requested, release };
  }

  scriptFault(fault: ChatCompletionsFault): void {
    this.#turns.push(fault);
  }

  requests(): readonly RecordedChatCompletionsRequest[] {
    return this.#requests.slice();
  }

  markRequests(): number {
    return this.#requests.length;
  }

  requestsSince(index: number): readonly RecordedChatCompletionsRequest[] {
    return this.#requests.slice(index);
  }

  protocolViolations(): readonly string[] {
    return this.#violations.slice();
  }

  // For tests that provoke violations on purpose (e.g. scripted exhaustion).
  clearProtocolViolations(): void {
    this.#violations.length = 0;
  }

  // Non-completions traffic the CLI generated, kept for inspection rather than failure:
  // catalog or auxiliary endpoints are the CLI's business, not the conversation contract.
  otherRequests(): readonly string[] {
    return this.#otherRequests.slice();
  }

  reset(): void {
    this.#turns.length = 0;
    for (const release of [...this.#pendingReleases]) release();
  }

  assertSettled(): void {
    const problems = [
      ...this.#violations,
      ...(this.#turns.length > 0
        ? [`${this.#turns.length} scripted turn(s) were never requested`]
        : []),
      ...(this.#pendingReleases.size > 0
        ? [`${this.#pendingReleases.size} held turn(s) were never released`]
        : []),
    ];
    if (problems.length > 0) {
      throw new Error(`Fake chat completions model was not settled:\n${problems.join('\n')}`);
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const release of [...this.#pendingReleases]) release();
    this.#server.stop(true);
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      this.#otherRequests.push(`${request.method} ${url.pathname}`);
      return Response.json({
        error: { message: 'unsupported path', type: 'invalid_request_error' },
      }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      this.#violations.push('Chat completions request body was not valid JSON');
      return Response.json({
        error: { message: 'invalid request body', type: 'invalid_request_error' },
      }, { status: 400 });
    }
    this.#violations.push(...validateRequest(body));
    if (!isRecord(body)) {
      return Response.json({
        error: { message: 'invalid request body', type: 'invalid_request_error' },
      }, { status: 400 });
    }
    const record = body;
    const recordedUserTexts = userTexts(record);
    const recorded: RecordedChatCompletionsRequest = {
      id: ++this.#requestId,
      body: record,
      userTexts: recordedUserTexts,
      lastUserText: recordedUserTexts.at(-1) ?? '',
      toolResults: toolResults(record),
      receivedAt: Date.now(),
    };
    this.#requests.push(recorded);
    const turn = this.#turns.shift();
    if (!turn) {
      // Exhaustion is a protocol violation: Pi retries transient 5xx, so the scripted
      // sequence must account for retry traffic; cleanup fails on unexpected requests.
      this.#violations.push(
        `Request ${recorded.id} arrived with no scripted turn (lastUserText: ${JSON.stringify(recorded.lastUserText)})`,
      );
      return Response.json({
        error: { message: 'no scripted turn available', type: 'server_error' },
      }, { status: 500 });
    }
    if (!Array.isArray(turn) && typeof turn !== 'function') {
      if (turn.kind === 'http-error') {
        return Response.json({
          error: { message: turn.message, type: 'server_error' },
        }, { status: turn.status });
      }
      return sseResponse(turnChunks([], recorded), { truncated: true });
    }
    const blocks = await (typeof turn === 'function' ? turn(recorded) : turn);
    return sseResponse(turnChunks(blocks, recorded));
  }
}
