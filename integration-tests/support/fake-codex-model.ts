// Scripted stand-in for the model behind a real Codex binary. Codex talks the OpenAI Responses
// SSE protocol to whatever base_url its provider config names; pointing that at this server (via
// the credential proxy's --upstream-url) keeps every provider-side behavior real -- process
// lifecycle, sandboxing, rollout persistence, app-server protocol -- while the model's choices
// become deterministic test script. Codex parses only the SSE data JSON and keys on its `type`
// field, tolerates unknown event types, and accepts complete items via response.output_item.done,
// so the emitted stream is the minimal created/item.done*/completed sequence.

export type CodexScriptedItem = Record<string, unknown>;

export type CodexScriptedTurn =
  | CodexScriptedItem[]
  | ((
      request: RecordedCodexModelRequest,
    ) => CodexScriptedItem[] | Promise<CodexScriptedItem[]>);

export type CodexScriptedFault =
  | { readonly kind: 'http-error'; readonly status: number; readonly message: string }
  | { readonly kind: 'stream-error'; readonly message: string }
  | { readonly kind: 'truncated-stream' };

export interface HeldCodexTurn {
  readonly requested: Promise<RecordedCodexModelRequest>;
  release(): void;
}

export interface RecordedCodexModelRequest {
  readonly id: number;
  readonly body: Record<string, unknown>;
  readonly userTexts: readonly string[];
  readonly lastUserText: string;
  readonly functionCallOutputs: ReadonlyArray<{ callId: string; output: string }>;
  readonly receivedAt: number;
}

export function codexAssistantMessage(text: string): CodexScriptedItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

// The pinned Codex exposes the unified exec tool as `exec_command` with a string `cmd`.
export function codexExecCommandCall(
  callId: string,
  cmd: string,
  extraArguments: Record<string, unknown> = {},
): CodexScriptedItem {
  return {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd, ...extraArguments }),
    call_id: callId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return [];
  const texts: string[] = [];
  for (const item of body.input) {
    if (!isRecord(item) || item.type !== 'message' || item.role !== 'user') continue;
    if (typeof item.content === 'string') {
      if (item.content.length > 0) texts.push(item.content);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    const text = item.content
      .filter((part): part is Record<string, unknown> =>
        isRecord(part) && part.type === 'input_text' && typeof part.text === 'string')
      .map((part) => String(part.text))
      .join('\n');
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function functionCallOutputs(
  body: Record<string, unknown>,
): Array<{ callId: string; output: string }> {
  if (!Array.isArray(body.input)) return [];
  return body.input
    .filter((item): item is Record<string, unknown> =>
      isRecord(item) && item.type === 'function_call_output' && typeof item.call_id === 'string')
    .map((item) => ({
      callId: String(item.call_id),
      output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
    }));
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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

function turnEvents(items: CodexScriptedItem[], responseId: string): Array<Record<string, unknown>> {
  // Codex keeps sampling until the model signals it is done: tool outputs queue pending input,
  // and end_turn tells the loop whether the model expects another round.
  const expectsFollowUp = items.some((item) =>
    item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call');
  return [
    { type: 'response.created', response: {} },
    ...items.map((item) => ({ type: 'response.output_item.done', item })),
    {
      type: 'response.completed',
      response: {
        id: responseId,
        end_turn: !expectsFollowUp,
        usage: {
          input_tokens: 42,
          input_tokens_details: null,
          output_tokens: 7,
          output_tokens_details: null,
          total_tokens: 49,
        },
      },
    },
  ];
}

function failedEvents(message: string): Array<Record<string, unknown>> {
  return [
    { type: 'response.created', response: {} },
    { type: 'response.failed', response: { error: { code: 'fake_model_unscripted', message } } },
  ];
}

export class FakeCodexModel {
  readonly #server: Bun.Server<undefined>;
  readonly #turns: Array<CodexScriptedTurn | CodexScriptedFault> = [];
  readonly #requests: RecordedCodexModelRequest[] = [];
  readonly #issues: string[] = [];
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

  static start(): FakeCodexModel {
    return new FakeCodexModel();
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  get responsesUrl(): string {
    return `${this.baseUrl}/v1/responses`;
  }

  scriptTurn(turn: CodexScriptedTurn): void {
    this.#turns.push(turn);
  }

  // Holds the response before its first SSE event. Codex enforces a stream idle timeout, so
  // callers release the turn within tens of seconds.
  scriptHeldTurn(turn: CodexScriptedTurn): HeldCodexTurn {
    let resolveRequested!: (request: RecordedCodexModelRequest) => void;
    const requested = new Promise<RecordedCodexModelRequest>((resolve) => {
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

  scriptFault(fault: CodexScriptedFault): void {
    this.#turns.push(fault);
  }

  requests(): readonly RecordedCodexModelRequest[] {
    return this.#requests.slice();
  }

  markRequests(): number {
    return this.#requests.length;
  }

  requestsSince(index: number): readonly RecordedCodexModelRequest[] {
    return this.#requests.slice(index);
  }

  issues(): readonly string[] {
    return this.#issues.slice();
  }

  reset(): void {
    this.#turns.length = 0;
    this.#issues.length = 0;
    for (const release of [...this.#pendingReleases]) release();
  }

  // Every scripted turn must have been consumed and every request must have been scripted;
  // anything else means the test and the binary disagreed about the conversation shape.
  assertSettled(): void {
    const problems = [
      ...this.#issues,
      ...(this.#turns.length > 0
        ? [`${this.#turns.length} scripted turn(s) were never requested`]
        : []),
    ];
    if (problems.length > 0) {
      throw new Error(`Fake Codex model was not settled:\n${problems.join('\n')}`);
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
    if (request.method !== 'POST' || url.pathname !== '/v1/responses') {
      this.#issues.push(`Unexpected request: ${request.method} ${url.pathname}`);
      return Response.json({ error: { message: 'unsupported path' } }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      this.#issues.push('Responses request body was not valid JSON');
      return sseResponse(failedEvents('invalid request body'));
    }
    if (!isRecord(body)) {
      this.#issues.push('Responses request body was not an object');
      return sseResponse(failedEvents('invalid request body'));
    }
    const recordedUserTexts = userTexts(body);
    const recorded: RecordedCodexModelRequest = {
      id: ++this.#requestId,
      body,
      userTexts: recordedUserTexts,
      lastUserText: recordedUserTexts.at(-1) ?? '',
      functionCallOutputs: functionCallOutputs(body),
      receivedAt: Date.now(),
    };
    this.#requests.push(recorded);
    const turn = this.#turns.shift();
    if (!turn) {
      this.#issues.push(
        `Request ${recorded.id} arrived with no scripted turn (lastUserText: ${JSON.stringify(recorded.lastUserText)})`,
      );
      return sseResponse(failedEvents('no scripted turn available'));
    }
    if (!Array.isArray(turn) && typeof turn !== 'function') {
      if (turn.kind === 'http-error') {
        return Response.json({ error: { message: turn.message } }, { status: turn.status });
      }
      if (turn.kind === 'stream-error') {
        return sseResponse(failedEvents(turn.message));
      }
      return sseResponse([{ type: 'response.created', response: {} }]);
    }
    const items = typeof turn === 'function' ? await turn(recorded) : turn;
    return sseResponse(turnEvents(items, `resp_fake_${recorded.id}`));
  }
}
