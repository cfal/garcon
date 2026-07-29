// Scripted stand-in for the model behind the real Claude Code CLI. The CLI speaks the Anthropic
// Messages API to ANTHROPIC_BASE_URL, so pointing that here keeps CLI behavior real -- process
// lifecycle, local tool execution, JSONL transcript persistence -- while the model's choices
// become deterministic test script. Parsing is deliberately lenient: the CLI's request shape is
// its own business, and the scripted turn queue is the correctness mechanism. This is distinct
// from FakeAnthropicServer, whose strict protocol checks belong to the direct Anthropic agent.

export type ClaudeScriptedBlock =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

export type ClaudeScriptedTurn =
  | ClaudeScriptedBlock[]
  | ((
      request: RecordedClaudeModelRequest,
    ) => ClaudeScriptedBlock[] | Promise<ClaudeScriptedBlock[]>);

export type ClaudeScriptedFault =
  | { readonly kind: 'http-error'; readonly status: number; readonly message: string }
  | { readonly kind: 'stream-error'; readonly message: string }
  | { readonly kind: 'truncated-stream' };

export interface HeldClaudeTurn {
  readonly requested: Promise<RecordedClaudeModelRequest>;
  release(): void;
}

export interface RecordedClaudeModelRequest {
  readonly id: number;
  readonly body: Record<string, unknown>;
  readonly lastUserText: string;
  readonly toolResults: ReadonlyArray<{ toolUseId: string; content: string }>;
  readonly receivedAt: number;
}

export function claudeText(text: string): ClaudeScriptedBlock {
  return { kind: 'text', text };
}

export function claudeToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ClaudeScriptedBlock {
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

function lastUserText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) return '';
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    const text = textFromContent(message.content);
    if (text.length > 0) return text;
  }
  return '';
}

function toolResults(
  body: Record<string, unknown>,
): Array<{ toolUseId: string; content: string }> {
  if (!Array.isArray(body.messages)) return [];
  const results: Array<{ toolUseId: string; content: string }> = [];
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      if (typeof block.tool_use_id !== 'string') continue;
      results.push({
        toolUseId: block.tool_use_id,
        content: textFromContent(block.content),
      });
    }
  }
  return results;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function blockEvents(block: ClaudeScriptedBlock, index: number): SseEvent[] {
  if (block.kind === 'text') {
    return [
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    ];
  }
  return [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
  ];
}

function turnEvents(
  blocks: ClaudeScriptedBlock[],
  request: RecordedClaudeModelRequest,
): SseEvent[] {
  const stopReason = blocks.some((block) => block.kind === 'tool_use') ? 'tool_use' : 'end_turn';
  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: `msg_scripted_${request.id}`,
          type: 'message',
          role: 'assistant',
          model: String(request.body.model ?? 'scripted'),
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 42,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    },
    ...blocks.flatMap((block, index) => blockEvents(block, index)),
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 7 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function sseResponse(events: SseEvent[]): Response {
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
  }), {
    status: 200,
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

function errorEvents(message: string): SseEvent[] {
  return [{
    event: 'error',
    data: { type: 'error', error: { type: 'api_error', message } },
  }];
}

export class FakeClaudeModel {
  readonly #server: Bun.Server<undefined>;
  readonly #turns: Array<ClaudeScriptedTurn | ClaudeScriptedFault> = [];
  readonly #requests: RecordedClaudeModelRequest[] = [];
  readonly #issues: string[] = [];
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

  static start(): FakeClaudeModel {
    return new FakeClaudeModel();
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  scriptTurn(turn: ClaudeScriptedTurn): void {
    this.#turns.push(turn);
  }

  // Holds the response before its first SSE event. The CLI enforces request timeouts, so
  // callers release the turn promptly.
  scriptHeldTurn(turn: ClaudeScriptedTurn): HeldClaudeTurn {
    let resolveRequested!: (request: RecordedClaudeModelRequest) => void;
    const requested = new Promise<RecordedClaudeModelRequest>((resolve) => {
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
    this.#turns.push(async (request) => {
      resolveRequested(request);
      await gate;
      return typeof turn === 'function' ? turn(request) : turn;
    });
    return { requested, release };
  }

  scriptFault(fault: ClaudeScriptedFault): void {
    this.#turns.push(fault);
  }

  requests(): readonly RecordedClaudeModelRequest[] {
    return this.#requests.slice();
  }

  // Non-messages traffic the CLI generated, kept for inspection rather than failure: telemetry
  // and auxiliary endpoints are the CLI's business, not the conversation contract.
  otherRequests(): readonly string[] {
    return this.#otherRequests.slice();
  }

  issues(): readonly string[] {
    return this.#issues.slice();
  }

  assertSettled(): void {
    const problems = [
      ...this.#issues,
      ...(this.#turns.length > 0
        ? [`${this.#turns.length} scripted turn(s) were never requested`]
        : []),
    ];
    if (problems.length > 0) {
      throw new Error(`Fake Claude model was not settled:\n${problems.join('\n')}`);
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
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      this.#otherRequests.push(`${request.method} ${url.pathname}`);
      return Response.json({ error: { type: 'not_found_error', message: 'unsupported path' } }, {
        status: 404,
      });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      this.#issues.push('Messages request body was not valid JSON');
      return sseResponse(errorEvents('invalid request body'));
    }
    if (!isRecord(body)) {
      this.#issues.push('Messages request body was not an object');
      return sseResponse(errorEvents('invalid request body'));
    }
    const recorded: RecordedClaudeModelRequest = {
      id: ++this.#requestId,
      body,
      lastUserText: lastUserText(body),
      toolResults: toolResults(body),
      receivedAt: Date.now(),
    };
    this.#requests.push(recorded);
    const turn = this.#turns.shift();
    if (!turn) {
      this.#issues.push(
        `Request ${recorded.id} arrived with no scripted turn (lastUserText: ${JSON.stringify(recorded.lastUserText)})`,
      );
      return sseResponse(errorEvents('no scripted turn available'));
    }
    if (!Array.isArray(turn) && typeof turn !== 'function') {
      if (turn.kind === 'http-error') {
        return Response.json({
          error: { type: 'api_error', message: turn.message },
        }, { status: turn.status });
      }
      if (turn.kind === 'stream-error') {
        return sseResponse(errorEvents(turn.message));
      }
      return sseResponse(turnEvents([], recorded).slice(0, 1));
    }
    const blocks = typeof turn === 'function' ? await turn(recorded) : turn;
    return sseResponse(turnEvents(blocks, recorded));
  }
}
