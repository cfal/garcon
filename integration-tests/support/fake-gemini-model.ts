// Scripted stand-in for the Gemini Developer API behind the real Antigravity CLI.
// agy sends its agent turns to `GOOGLE_GEMINI_BASE_URL` as
// `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` when it authenticates
// with `gemini-api-key`, so CLI behavior stays real while every model choice is
// deterministic. Requests without tool declarations are the CLI's auxiliary
// traffic (conversation titles, web-search grounding); they receive a canned
// reply and stay outside the script.

export type GeminiPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thought'; readonly text: string }
  | {
      readonly kind: 'function-call';
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    };

export const FAKE_GEMINI_API_KEY = 'garcon-test-key';

export interface RecordedGeminiRequest {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly userTexts: readonly string[];
  readonly lastUserText: string;
  readonly functionResponses: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly response: Record<string, unknown>;
  }>;
}

export type GeminiTurn =
  | GeminiPart[]
  | ((request: RecordedGeminiRequest) => GeminiPart[] | Promise<GeminiPart[]>);

export interface GeminiFault {
  readonly kind: 'http-error';
  readonly status: number;
  readonly message: string;
  readonly reason: string;
}

// Streams its frames this far apart instead of all at once. agy relays
// updates that arrive together as one batch, so only a paced stream shows how
// it relays output a real model streams over time.
export interface PacedGeminiTurn {
  readonly kind: 'paced';
  readonly parts: readonly GeminiPart[];
  readonly frameIntervalMs: number;
}

export interface HeldGeminiTurn {
  readonly requested: Promise<RecordedGeminiRequest>;
  release(): void;
}

export function geminiText(text: string): GeminiPart {
  return { kind: 'text', text };
}

export function geminiThought(text: string): GeminiPart {
  return { kind: 'thought', text };
}

export function geminiFunctionCall(id: string, name: string, args: Record<string, unknown>): GeminiPart {
  return { kind: 'function-call', id, name, args };
}

const STREAM_PATH = /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/;
const AUXILIARY_REPLY = 'Scripted Title';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentParts(body: Record<string, unknown>): Array<{ role: string; part: Record<string, unknown> }> {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return contents.filter(isRecord).flatMap((content) => (
    Array.isArray(content.parts) ? content.parts : []
  ).filter(isRecord).map((part) => ({ role: String(content.role ?? ''), part })));
}

function recordRequest(id: number, model: string, body: Record<string, unknown>, signal: AbortSignal): RecordedGeminiRequest {
  const parts = contentParts(body);
  const userTexts = parts
    .filter(({ role, part }) => role === 'user' && typeof part.text === 'string')
    .map(({ part }) => String(part.text));
  const functionResponses = parts.flatMap(({ part }) => {
    const response = part.functionResponse;
    if (!isRecord(response)) return [];
    return [{
      id: String(response.id ?? ''),
      name: String(response.name ?? ''),
      response: isRecord(response.response) ? response.response : {},
    }];
  });
  return { id, model, body, signal, userTexts, lastUserText: userTexts.at(-1) ?? '', functionResponses };
}

function wirePart(part: GeminiPart): Record<string, unknown> {
  if (part.kind === 'text') return { text: part.text };
  if (part.kind === 'thought') return { text: part.text, thought: true };
  return { functionCall: { id: part.id, name: part.name, args: part.args } };
}

function sseResponse(parts: readonly GeminiPart[], frameIntervalMs = 0): Response {
  const usageMetadata = { promptTokenCount: 42, candidatesTokenCount: 7, totalTokenCount: 49 };
  const frames = parts.map((part, index) => ({
    candidates: [{
      content: { role: 'model', parts: [wirePart(part)] },
      ...(index === parts.length - 1 ? { finishReason: 'STOP' } : {}),
    }],
    ...(index === parts.length - 1 ? { usageMetadata } : {}),
  }));
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, frame] of frames.entries()) {
        if (index > 0 && frameIntervalMs > 0) await Bun.sleep(frameIntervalMs);
        if (cancelled) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\r\n\r\n`));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

export class FakeGeminiModel {
  readonly #server: Bun.Server<undefined>;
  readonly #turns: Array<GeminiTurn | GeminiFault | PacedGeminiTurn> = [];
  readonly #requests: RecordedGeminiRequest[] = [];
  readonly #violations: string[] = [];
  readonly #auxiliaryRequests: string[] = [];
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

  static start(): FakeGeminiModel {
    return new FakeGeminiModel();
  }

  get baseUrl(): string {
    return `http://${this.#server.hostname}:${this.#server.port}`;
  }

  scriptTurn(turn: GeminiTurn): void {
    this.#turns.push(turn);
  }

  scriptPacedTurn(parts: readonly GeminiPart[], frameIntervalMs: number): void {
    this.#turns.push({ kind: 'paced', parts, frameIntervalMs });
  }

  // Holds the response before its first frame until the test releases it.
  scriptHeldTurn(turn: GeminiTurn): HeldGeminiTurn {
    const requested = Promise.withResolvers<RecordedGeminiRequest>();
    const gate = Promise.withResolvers<void>();
    const release = () => {
      if (!this.#pendingReleases.delete(release)) return;
      gate.resolve();
    };
    this.#pendingReleases.add(release);
    this.#turns.push(async (request) => {
      requested.resolve(request);
      await gate.promise;
      return typeof turn === 'function' ? turn(request) : turn;
    });
    return { requested: requested.promise, release };
  }

  scriptFault(fault: GeminiFault): void {
    this.#turns.push(fault);
  }

  requests(): readonly RecordedGeminiRequest[] {
    return this.#requests.slice();
  }

  markRequests(): number {
    return this.#requests.length;
  }

  requestsSince(index: number): readonly RecordedGeminiRequest[] {
    return this.#requests.slice(index);
  }

  // Drops unrequested turns and releases held ones, for drivers shared across fixtures.
  reset(): void {
    this.#turns.length = 0;
    for (const release of [...this.#pendingReleases]) release();
  }

  auxiliaryRequests(): readonly string[] {
    return this.#auxiliaryRequests.slice();
  }

  assertSettled(): void {
    const problems = [
      ...this.#violations,
      ...(this.#turns.length > 0 ? [`${this.#turns.length} scripted turn(s) were never requested`] : []),
      ...(this.#pendingReleases.size > 0 ? [`${this.#pendingReleases.size} held turn(s) were never released`] : []),
    ];
    if (problems.length > 0) throw new Error(`Fake Gemini model was not settled:\n${problems.join('\n')}`);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const release of [...this.#pendingReleases]) release();
    this.#server.stop(true);
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('x-goog-api-key') !== FAKE_GEMINI_API_KEY) {
      this.#violations.push(`Request to ${url.pathname} did not use the fixture API key`);
      return Response.json({ error: { code: 403, message: 'expected fixture key', status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    const path = url.pathname.match(STREAM_PATH);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    if (!isRecord(body)) {
      this.#violations.push(`${request.method} ${url.pathname} carried no JSON object body`);
      return Response.json({ error: { code: 400, message: 'invalid body', status: 'INVALID_ARGUMENT' } }, { status: 400 });
    }
    if (!path || !Array.isArray(body.tools)) {
      this.#auxiliaryRequests.push(`${request.method} ${url.pathname}`);
      return path ? sseResponse([geminiText(AUXILIARY_REPLY)]) : Response.json({
        candidates: [{ content: { role: 'model', parts: [{ text: AUXILIARY_REPLY }] }, finishReason: 'STOP' }],
      });
    }
    const recorded = recordRequest(++this.#requestId, path[1]!, body, request.signal);
    this.#requests.push(recorded);
    const turn = this.#turns.shift();
    if (!turn) {
      this.#violations.push(
        `Request ${recorded.id} arrived with no scripted turn (lastUserText: ${JSON.stringify(recorded.lastUserText.slice(0, 200))})`,
      );
      return Response.json({ error: { code: 500, message: 'no scripted turn', status: 'INTERNAL' } }, { status: 500 });
    }
    if (Array.isArray(turn) || typeof turn === 'function') {
      return sseResponse(await (typeof turn === 'function' ? turn(recorded) : turn));
    }
    if (turn.kind === 'paced') return sseResponse(turn.parts, turn.frameIntervalMs);
    return Response.json({
      error: {
        code: turn.status,
        message: turn.message,
        status: turn.reason,
      },
    }, { status: turn.status });
  }
}
