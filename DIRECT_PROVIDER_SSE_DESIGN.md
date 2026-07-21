# Direct Provider SSE Unification

Status: Implemented

Baseline: `67d22ea7` (`Preserve single-query execution controls`)

Date: 2026-07-20

## Problem Statement

Garcon has three direct provider runtimes:

- OpenAI-compatible Chat Completions
- OpenAI-compatible Responses
- Anthropic-compatible Messages

All interactive chat-session requests ask their upstream provider for Server-Sent Events (SSE), but only the Chat Completions runtime also uses SSE for one-shot generation. Anthropic Messages and OpenAI Responses still use buffered JSON for `runSingleQuery`. One-shot generation backs chat titles, commit messages, and generation-model tests, so those paths do not receive the latency and timeout behavior of the corresponding session path.

The streaming implementations have also diverged. Anthropic validates its terminal event, Chat Completions validates `[DONE]`, and Responses accepts an arbitrary end-of-file as success. The Responses implementation can also return partial text after a provider failure because it only throws a stream error when no text was accumulated.

The change should make every direct generation request ask for SSE and make one-shot and session requests share the same protocol-specific response reader.

## Goals

- Send `stream: true` for every direct generation request, including one-shot and session requests.
- Share one response reader between the one-shot and session paths of each protocol.
- Preserve visible text while safely ignoring reasoning events.
- Require the protocol's successful terminal event before accepting streamed output.
- Reject provider errors and incomplete streams even when partial text was received.
- Preserve the caller abort signal, timeout, model, and thinking effort introduced by baseline commit `67d22ea7`.
- Retain buffered JSON compatibility when a provider ignores `stream: true` and returns a successful JSON response.
- Cover each protocol with unit tests and each shipped direct agent with black-box server integration tests.

## Non-Goals

- Streaming partial assistant text from the Garcon server to the web client.
- Persisting partial assistant text before a provider response completes.
- Adding or discovering endpoint reasoning capabilities.
- Changing `thinkingMode` semantics or adding a reasoning on/off policy.
- Retrying a thinking-only completion with different reasoning settings.
- Treating hidden reasoning as visible assistant output.
- Changing model discovery, provider authentication, endpoint storage, or provider templates.
- Adding streaming tool-call execution to direct runtimes.

## Scope Boundary

This design concerns upstream provider transport. `DirectChatRuntimeBase` currently awaits a complete string from `streamSession`, persists it, and emits one final `AssistantMessage`. That behavior remains unchanged. A future client-token-streaming project would require new typed events, partial transcript state, reconnect behavior, and frontend rendering changes.

## Current System

### Routing

`server-agents/common/src/direct/router.ts` creates one endpoint-scoped runtime family for each direct agent:

- `createDirectOpenAiChatRuntime` uses `runOpenAiCompatibleSingleQuery` and `OpenAiCompatibleChatRuntime`.
- `createDirectOpenAiResponsesRuntime` uses `runOpenAiResponsesSingleQuery` and `OpenAiCompatibleResponsesRuntime`.
- `createDirectAnthropicRuntime` uses `runAnthropicCompatibleSingleQuery` and `AnthropicCompatibleChatRuntime`.

The three integration packages under `server-agents/direct-*/src/index.ts` pass the normalized one-shot options to these common runtimes. The baseline commit makes `thinkingMode`, `timeoutMs`, and `signal` available there.

### Transport Matrix

| Protocol | One-shot request | Session request | Successful terminal validation |
| --- | --- | --- | --- |
| Chat Completions | SSE with JSON fallback | SSE | `[DONE]` |
| Responses | Buffered JSON | SSE | Missing |
| Anthropic Messages | Buffered JSON | SSE | `message_stop` |

### Shared SSE Framing

`server-agents/common/src/shared/sse.ts` owns `readSseDataEvents`. It correctly:

- reads split UTF-8 chunks with `TextDecoder`;
- normalizes CRLF line endings;
- joins multiple `data:` lines in one event;
- ignores non-data fields such as `event:` and comments;
- emits the final unterminated buffered event;
- cancels the body reader during cleanup.

It should remain a transport-framing utility. Protocol event schemas should stay in their direct runtime modules.

### Chat Completions

`server-agents/common/src/direct/openai-compatible-chat-runtime.ts` already sends `stream: true` for both use cases. `readOpenAiCompatibleTextStream` accumulates `choices[0].delta.content`, surfaces streamed error objects, and requires `[DONE]`.

`readOpenAiCompatibleSingleQueryResponse` also accepts a buffered JSON response based on `Content-Type`, but the session path calls `readOpenAiCompatibleTextStream` directly. The response-selection helper should be renamed and shared by both paths.

### Anthropic Messages

`server-agents/common/src/direct/anthropic-compatible-chat-runtime.ts` sends `stream: true` only from `streamSession`. `runAnthropicCompatibleSingleQuery` omits the field and reads `response.json()`.

The session parser accumulates `content_block_delta` events whose delta type is `text_delta`, ignores thinking and signature deltas, surfaces `error` events, and requires `message_stop`. The one-shot path should use that same parser.

### OpenAI Responses

`server-agents/common/src/direct/openai-compatible-responses-runtime.ts` sends `stream: true` only from `streamSession`. `runOpenAiResponsesSingleQuery` reads buffered JSON with `extractResponsesOutputText`.

`applyResponsesStreamEvent` recognizes visible `response.output_text.delta`, `error`, `response.failed`, and `response.incomplete`. The surrounding session reader has two correctness gaps:

- it does not record or require `response.completed`;
- it throws a stream error only when accumulated text is empty.

The current test helper closes the stream after output deltas without a terminal event, so the unit tests encode the incomplete behavior.

### Consumers

One-shot generation is used by:

- `server/chats/title-generator.ts` for automatic and manual chat titles;
- `server/git/commit-message.ts` for commit message generation;
- `server/settings/generation-model-test.ts` for explicit generation-model tests.

No consumer needs incremental deltas. Each needs a final visible string or a precise failure.

## External Research

Alibaba Cloud Model Studio documents both relevant streaming interfaces for `qwen3.7-plus`:

- [OpenAI-compatible Responses API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses) uses `stream: true`, emits `response.output_text.delta`, and terminates with `response.completed`.
- [Anthropic-compatible Messages API](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages) uses `stream: true`, emits typed content-block deltas, and terminates with `message_stop`.
- [Alibaba Cloud streaming overview](https://www.alibabacloud.com/help/en/model-studio/stream) identifies SSE as the streaming transport and notes that some Qwen models require streaming.

The Responses documentation also states that only explicitly documented OpenAI fields are processed. This supports keeping protocol event parsing explicit rather than assuming every OpenAI-compatible field or event is universal.

## Live Provider Verification

The design was verified on 2026-07-20 against the configured Alibaba Cloud Global Frankfurt workspace using the locally stored API key and `qwen3.7-plus`. The key was read in process and was not printed or copied into the repository.

### Raw OpenAI Responses SSE

Request shape:

```json
{
  "model": "qwen3.7-plus",
  "input": [
    { "role": "user", "content": "Reply with exactly ALIBABA_SSE_OK." }
  ],
  "stream": true,
  "store": false
}
```

Observed result:

- HTTP status: 200
- Content type: `text/event-stream; charset=utf-8`
- First event: 2647 ms
- Completed: 5557 ms
- Reasoning summary deltas: 32
- Visible output deltas: 4
- Terminal event: `response.completed`
- Visible output: `ALIBABA_SSE_OK`

### Raw Anthropic Messages SSE

Request shape:

```json
{
  "model": "qwen3.7-plus",
  "max_tokens": 128,
  "messages": [
    { "role": "user", "content": "Reply with exactly ALIBABA_SSE_OK." }
  ],
  "stream": true
}
```

Observed result:

- HTTP status: 200
- Content type: `text/event-stream; charset=utf-8`
- First event: 3522 ms
- Completed: 7204 ms
- Content blocks: thinking followed by text
- Terminal event: `message_stop`
- Visible output: `ALIBABA_SSE_OK`

### Existing Session Runtime Verification

The repository's current `AnthropicCompatibleChatRuntime` and `OpenAiCompatibleResponsesRuntime` were instantiated directly with the same endpoint and key. Each created an ephemeral session, consumed its upstream SSE stream, persisted one temporary JSONL transcript, and emitted `SESSION_SSE_OK`.

| Runtime | Result | Completion time |
| --- | --- | --- |
| Anthropic Messages | `SESSION_SSE_OK` | 5093 ms |
| OpenAI Responses | `SESSION_SSE_OK` | 5422 ms |

This confirms that Alibaba's actual reasoning and visible-output event sequences are compatible with the current session parsers. The missing work is one-shot transport unification and stricter Responses terminal handling.

## Proposed Design

### Protocol-Specific Readers

Each direct protocol module will own one successful-response reader used by both one-shot and session requests:

```ts
async function readAnthropicCompatibleResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string>;

async function readOpenAiCompatibleResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string>;

async function readOpenAiResponsesResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string>;
```

The callers remain responsible for checking `response.ok` and including the provider's HTTP error body in the thrown error. The readers handle successful response bodies only.

### Response Media Type

All generation requests will include `stream: true`. A successful provider can nevertheless return buffered JSON. The reader will select parsing by media type:

```ts
function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();

  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}
```

This helper should live in `server-agents/common/src/direct/response-media-type.ts` because it is shared only by direct protocol adapters. It should not expand `shared/sse.ts` beyond SSE framing.

JSON fallback is response compatibility, not request fallback. Garcon will not make a second billable request merely because a provider ignored `stream: true`.

### Anthropic Reader

The Anthropic reader will preserve the existing event semantics and add buffered JSON selection:

```ts
interface AnthropicStreamState {
  text: string;
  errorMessage: string | null;
  sawMessageStop: boolean;
}

async function readAnthropicCompatibleResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  if (isJsonResponse(response)) {
    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (data.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  if (!response.body) {
    throw new Error(`${runtimeLabel} response did not include a stream body.`);
  }

  const state: AnthropicStreamState = {
    text: '',
    errorMessage: null,
    sawMessageStop: false,
  };
  await readSseDataEvents(response.body, (data) => consumeAnthropicEvent(state, data));

  if (state.errorMessage) {
    throw new Error(`${runtimeLabel} stream error: ${state.errorMessage}`);
  }
  if (!state.sawMessageStop) {
    throw new Error(`${runtimeLabel} stream ended before message_stop.`);
  }
  return state.text;
}
```

`thinking_delta` and `signature_delta` remain ignored. A stream containing thinking followed by text succeeds. A thinking-only stream produces an empty visible result after a valid `message_stop`; existing callers retain responsibility for empty-output policy.

Both request paths will use it:

```ts
body: JSON.stringify({
  model,
  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  messages: [{ role: 'user', content: prompt }],
  stream: true,
  ...(reasoningEffort ? { output_config: { effort: reasoningEffort } } : {}),
}),

return (await readAnthropicCompatibleResponse(response, config.runtimeLabel)).trim();
```

`streamSession` will replace its inline reader with the same function.

### Chat Completions Reader

Chat Completions already has the required transport. Rename the one-shot-specific selector and use it from both paths:

```ts
async function readOpenAiCompatibleResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  if (!isJsonResponse(response)) {
    return readOpenAiCompatibleTextStream(response, runtimeLabel);
  }

  const parsed = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  if (parsed.error?.message) {
    throw new Error(`${runtimeLabel} response error: ${parsed.error.message}`);
  }
  return appendDeltaText('', parsed.choices?.[0]?.message?.content);
}
```

The SSE parser continues to ignore provider-specific reasoning fields because it appends only `delta.content`. It must continue reading until `[DONE]`, so reasoning events before visible content do not end the request early.

### Responses State Machine

Responses needs an explicit terminal state rather than a string plus optional error:

```ts
interface ResponsesStreamState {
  text: string;
  errorMessage: string | null;
  terminal: 'completed' | 'failed' | 'incomplete' | null;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: unknown;
  error?: { message?: unknown };
  response?: {
    error?: { message?: unknown };
    incomplete_details?: { reason?: unknown };
    status_details?: { error?: { message?: unknown } };
  };
}

function responsesFailureMessage(event: ResponsesStreamEvent): string {
  const directMessage = event.response?.error?.message;
  if (typeof directMessage === 'string') return directMessage;

  const compatibleMessage = event.response?.status_details?.error?.message;
  if (typeof compatibleMessage === 'string') return compatibleMessage;

  const incompleteReason = event.response?.incomplete_details?.reason;
  if (typeof incompleteReason === 'string') return incompleteReason;

  return `Responses stream ended with ${event.type ?? 'an unknown failure'}.`;
}

function consumeResponsesStreamEvent(
  state: ResponsesStreamState,
  event: unknown,
): void {
  if (!event || typeof event !== 'object') return;
  const parsed = event as ResponsesStreamEvent;

  if (parsed.type === 'response.output_text.delta') {
    if (typeof parsed.delta === 'string') state.text += parsed.delta;
    return;
  }
  if (parsed.type === 'response.completed') {
    state.terminal = 'completed';
    return;
  }
  if (parsed.type === 'error') {
    state.errorMessage = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : 'Responses stream returned an error.';
    return;
  }
  if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
    state.terminal = parsed.type === 'response.failed' ? 'failed' : 'incomplete';
    state.errorMessage = responsesFailureMessage(parsed);
  }
}
```

The reader will reject any error regardless of accumulated text and require `response.completed`:

```ts
async function readOpenAiResponsesResponse(
  response: Response,
  runtimeLabel: string,
): Promise<string> {
  if (isJsonResponse(response)) {
    const data = await response.json() as {
      status?: unknown;
      error?: { message?: unknown };
      incomplete_details?: { reason?: unknown };
    };
    if (data.status === 'failed' || data.status === 'incomplete') {
      const detail = typeof data.error?.message === 'string'
        ? data.error.message
        : typeof data.incomplete_details?.reason === 'string'
          ? data.incomplete_details.reason
          : `Responses API returned status ${data.status}.`;
      throw new Error(`${runtimeLabel} response error: ${detail}`);
    }
    return extractResponsesOutputText(data);
  }
  if (!response.body) {
    throw new Error(`${runtimeLabel} response did not include a stream body.`);
  }

  const state: ResponsesStreamState = {
    text: '',
    errorMessage: null,
    terminal: null,
  };
  await readSseDataEvents(response.body, (data) => {
    try {
      consumeResponsesStreamEvent(state, JSON.parse(data));
    } catch {
      // Skips malformed chunks from partially-compatible providers.
    }
  });

  if (state.errorMessage) {
    throw new Error(`${runtimeLabel} stream error: ${state.errorMessage}`);
  }
  if (state.terminal !== 'completed') {
    throw new Error(`${runtimeLabel} stream ended before response.completed.`);
  }
  return state.text;
}
```

The one-shot request will add `stream: true` and both paths will call this reader.

Reasoning summary and reasoning text events are intentionally ignored. Alibaba Cloud's verified event sequence contains many `response.reasoning_summary_text.delta` events before visible output, followed by `response.completed`; the state machine continues across them without storing their content.

### Abort and Timeout Behavior

No public contract changes are required. The baseline already forwards `signal` and `timeoutMs` into every server-agent one-shot request.

Direct one-shots continue to combine:

- the caller signal;
- the direct runtime's bounded local timeout.

Session requests continue to use their session abort controller and five-minute stream timeout. `readSseDataEvents` rejects when the aborted fetch body rejects and cancels its reader in `finally`.

The refactor must not catch abort exceptions as malformed SSE data. Only JSON parsing inside an individual SSE callback should be caught.

## Alternatives Considered

### Keep Buffered JSON for One-Shots

Rejected. It preserves the current latency inconsistency, cannot support models that require streaming, and keeps two response parsers per protocol.

### Create One Universal Provider Event Parser

Rejected. Anthropic Messages, Chat Completions, and Responses have different visible-content events, error events, and terminal conditions. A universal parser would hide protocol assumptions and make compatibility failures harder to diagnose. Only SSE framing and response media-type detection should be shared.

### Reject Every JSON Response After Requesting SSE

Rejected. Compatible providers sometimes ignore `stream: true` while returning a valid buffered response. Parsing that response is safe and does not add another request. Strict rejection would reduce compatibility without improving the upstream request path.

### Retry Without Streaming

Rejected. An ambiguous failure may occur after the provider has accepted and billed the first request. Automatic retry could duplicate cost and output. A clear HTTP rejection of `stream: true` should be surfaced rather than retried in this change.

### Emit Partial Text to the Client

Deferred. It changes the WebSocket contract, transcript lifecycle, reconnect semantics, and frontend state. This design intentionally returns one final string to existing callers.

## Failure Modes and Edge Cases

### HTTP Error Before SSE

Existing callers read the response body and throw a protocol-labeled error with the HTTP status. This remains unchanged.

### Provider Error After Partial Text

All readers reject. Partial text is not persisted, returned to one-shot consumers, or emitted as an assistant message.

### Truncated Stream

- Anthropic rejects missing `message_stop`.
- Chat Completions rejects missing `[DONE]`.
- Responses rejects missing `response.completed`.

### Empty Successful Stream

The reader returns an empty string only after a valid success terminal event. Existing one-shot consumers and `DirectChatRuntimeBase` then apply their current empty-output behavior.

### Thinking Before Visible Text

The reader ignores reasoning content and continues until visible text or the terminal event. Tests must cover reasoning events before text for Anthropic and Responses.

### Thinking-Only Completion

The reader returns an empty visible string after the valid terminal event. Consuming hidden thinking is explicitly forbidden. A typed thinking-only diagnostic is deferred with the reasoning-policy work.

### Malformed SSE Event

A malformed JSON data event is skipped. A later valid visible event and valid terminal event can still complete the request. A stream made only of malformed data fails terminal validation.

### JSON Response Despite `stream: true`

The protocol's buffered JSON parser handles it. Tests cover this fallback for all three readers.

### Missing or Incorrect Content Type

A non-JSON response is treated as SSE. If it does not contain valid SSE data and the required terminal event, it fails as truncated. This avoids guessing from body prefixes.

## Security and Privacy

- API keys remain inside endpoint configuration and request headers.
- Tests and logs must never include credential values.
- Hidden reasoning text must not be logged, persisted, returned as a title, or emitted to the client.
- Provider HTTP error bodies retain existing behavior; this change should not add request bodies or headers to error messages.
- Live-provider verification remains a manual developer check and must not run in CI.

## Performance

- Every direct generation request begins consuming response bytes as soon as the provider emits them.
- One-shot APIs still resolve only after the terminal event because consumers require a complete string.
- Memory remains proportional to visible output length. Reasoning deltas are discarded rather than accumulated.
- SSE framing adds negligible overhead relative to model generation.
- No request retry is introduced.
- Alibaba Cloud documents identical token billing for streaming and buffered output.

## Compatibility and Migration

There is no persisted-data, API, WebSocket, or settings migration.

The server and server-agent packages ship together. Internal helper names can change without a compatibility layer. Buffered JSON responses remain supported, so the behavior is compatible with endpoints that ignore streaming.

## Observability

Existing protocol-labeled errors remain the primary signal. The implementation should produce distinct messages for:

- HTTP rejection;
- streamed provider error;
- missing response body;
- missing protocol terminal event;
- valid terminal event with empty visible output at the caller boundary.

No raw SSE data or reasoning content should be added to logs. Integration-test diagnostics should record request protocol, `stream: true`, model, message roles, and sanitized response-plan state only.

## Execution Plan

### 1. Add Direct Response Media-Type Detection

Files:

- Add `server-agents/common/src/direct/response-media-type.ts`.
- Add `server-agents/common/src/direct/__tests__/response-media-type.test.js`.

Implementation:

```ts
export function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}
```

Tests:

```ts
expect(isJsonResponse(Response.json({}))).toBe(true);
expect(isJsonResponse(new Response('', {
  headers: { 'content-type': 'application/problem+json; charset=utf-8' },
}))).toBe(true);
expect(isJsonResponse(new Response('', {
  headers: { 'content-type': 'text/event-stream; charset=utf-8' },
}))).toBe(false);
expect(isJsonResponse(new Response(''))).toBe(false);
```

Ordering: complete before refactoring the three readers.

Rollback: inline the media-type check in each protocol module.

### 2. Unify Anthropic One-Shot and Session Reading

Files:

- Modify `server-agents/common/src/direct/anthropic-compatible-chat-runtime.ts`.
- Modify `server-agents/common/src/direct/__tests__/anthropic-compatible-chat-runtime.test.js`.

Implementation:

- Extract `readAnthropicCompatibleResponse` from the existing session parser.
- Keep `consumeAnthropicEvent` protocol-specific.
- Add `stream: true` to `runAnthropicCompatibleSingleQuery`.
- Replace its direct `response.json()` call with the shared reader.
- Replace the inline session parsing block with the shared reader.

Required test cases:

- One-shot request includes `stream: true` and preserves model, `max_tokens`, effort, timeout signal, and messages.
- One-shot aggregates multiple text deltas.
- Thinking and signature deltas before text are ignored.
- A valid thinking-only stream returns empty visible text.
- An `error` event rejects after partial text.
- EOF before `message_stop` rejects.
- Malformed data followed by text and `message_stop` succeeds.
- Buffered JSON fallback still extracts only text blocks.
- Session start and resume continue to use `stream: true` and the shared reader.

Representative one-shot assertion:

```ts
expect(requestBody).toEqual({
  model: 'acme-opus',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Generate a commit message' }],
  stream: true,
  output_config: { effort: 'max' },
});
expect(result).toBe('commit message');
```

### 3. Share the Chat Completions Reader Across Use Cases

Files:

- Modify `server-agents/common/src/direct/openai-compatible-chat-runtime.ts`.
- Modify `server-agents/common/src/direct/__tests__/openai-compatible-chat-runtime.test.js`.

Implementation:

- Rename `readOpenAiCompatibleSingleQueryResponse` to `readOpenAiCompatibleResponse`.
- Use it from `runOpenAiCompatibleSingleQuery` and `streamSession`.
- Use the shared `isJsonResponse` helper.
- Keep the `[DONE]` requirement and partial-error rejection.

Required test cases:

- Existing one-shot and session requests still include `stream: true`.
- Both paths aggregate text deltas and require `[DONE]`.
- Both paths reject an error after partial output.
- Both paths accept a buffered JSON response when the provider ignores streaming.
- Reasoning-only deltas before visible content do not end the stream.

This is primarily a consistency refactor; no request shape changes are expected.

### 4. Implement a Strict Responses Stream State Machine

Files:

- Modify `server-agents/common/src/direct/openai-compatible-responses-runtime.ts`.
- Modify `server-agents/common/src/direct/__tests__/openai-compatible-responses-runtime.test.js`.

Implementation:

- Replace `applyResponsesStreamEvent(accumulated, event)` with state mutation through `consumeResponsesStreamEvent`.
- Track `response.completed`, `response.failed`, and `response.incomplete` explicitly.
- Reject errors even after visible text was accumulated.
- Require `response.completed` before returning SSE output.
- Preserve `extractResponsesOutputText` for JSON fallback.
- Add `stream: true` to `runOpenAiResponsesSingleQuery`.
- Use `readOpenAiResponsesResponse` from both paths.

Required test cases:

- One-shot request contains `stream: true`, `store: false`, model, input, and reasoning effort.
- One-shot and session aggregate `response.output_text.delta` events.
- Reasoning summary and reasoning text events are ignored.
- `response.completed` is required.
- `response.failed` rejects before and after partial output.
- `response.incomplete` rejects with the available reason.
- Raw `error` rejects before and after partial output.
- Malformed event followed by valid output and completion succeeds.
- Buffered JSON fallback extracts `output_text` or output content items.
- Abort during body reading rejects and does not emit or persist assistant text.

The Responses test helper must emit realistic terminal events:

```ts
function streamResponse(events, { complete = true } = {}) {
  const completeEvents = complete
    ? [...events, { type: 'response.completed', response: { status: 'completed' } }]
    : events;
  return sseResponse(completeEvents);
}
```

### 5. Add a Fake Responses Provider

Files:

- Add `integration-tests/support/fake-openai-responses-server.ts`.
- Modify `integration-tests/support/garcon-client.ts`.
- Modify `integration-tests/support/integration-fixture.ts`.
- Update nearby support-contract tests.

Rationale: `FakeOpenAiServer` currently validates only `/v1/chat/completions`. Responses has a distinct request and event contract, so a separate fake keeps protocol parsing focused and prevents a single support class from becoming multi-responsibility.

Minimum fake request contract:

```ts
export interface FakeResponsesRequestBody {
  model: string;
  input: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }>;
  stream: true;
  store: false;
  reasoning?: { effort?: string };
}
```

Successful fake response:

```ts
function responsesTextStream(text: string): Response {
  return sseResponse([
    { type: 'response.created', response: { status: 'in_progress' } },
    ...deterministicChunks(text).map((delta) => ({
      type: 'response.output_text.delta',
      delta,
    })),
    { type: 'response.output_text.done', text },
    { type: 'response.completed', response: { status: 'completed' } },
  ]);
}
```

The fake must support HTTP errors, stream errors, incomplete responses, empty completed responses, truncated streams, held responses, and abort observation using the same deterministic planning concepts as the existing fakes.

`GarconTestClient` will add `createOpenAiResponsesProvider`, configured with:

```ts
capabilities: { chatCompletions: false, responses: true }
```

`DirectTestAgents` and `IntegrationFixture` will add an `openAiResponses` entry using `DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID`. Diagnostics will include its sanitized requests and protocol violations.

### 6. Add Black-Box One-Shot and Session Coverage

Files:

- Modify `integration-tests/tests/server/chat-lifecycle.test.ts` or add `integration-tests/tests/server/openai-responses-chat-lifecycle.test.ts`.
- Modify `integration-tests/tests/server/anthropic-chat-lifecycle.test.ts`.
- Extend provider-failure integration coverage for Responses one-shots and sessions.

Anthropic integration cases:

- Existing start, resume, persistence, and rehydration requests remain streaming.
- Title generation configured with the Anthropic direct agent produces a second request whose body has `stream: true`.
- A title stream containing thinking events before text produces the visible title only.
- A truncated title stream does not update the chat title.

Responses integration cases:

- Start, resume, persistence, and rehydration preserve context and use `stream: true` plus `store: false`.
- Title generation uses the Responses direct agent and a distinct streaming request.
- Provider `response.failed`, `response.incomplete`, empty completed, and truncated streams do not fabricate assistant turns or titles.
- Abort reaches the fake provider and leaves no partial assistant transcript row.

Representative title assertion:

```ts
const titleRequest = fixture.fakeProviders.openAiResponses.requests()
  .find((request) => request.lastUserText.includes('### Task:'));
expect(titleRequest?.body).toMatchObject({
  stream: true,
  store: false,
  model: fixture.directAgents.openAiResponses.provider.model,
});
```

### 7. Run Validation and Manual Provider Smoke Tests

Repository validation:

```sh
bun run typecheck
bun run check
bun run test
bun run test:integration:server
timeout 30s bun run start --port 0
```

The startup smoke test must use a fresh workspace/config directory or otherwise avoid the active workspace lease. It must not stop the user's active server.

Manual live-provider validation uses credentials supplied outside the repository. Run both protocols with `qwen3.7-plus`, a deterministic prompt, and `stream: true`. Record only:

- status and content type;
- first-event and completion timing;
- event type counts;
- visible text;
- successful terminal presence.

Never print or persist the API key, request headers, raw thinking deltas, or workspace-specific endpoint identifier.

Expected assertions:

```text
Anthropic: HTTP 200, text/event-stream, visible text, message_stop
Responses: HTTP 200, text/event-stream, visible text, response.completed
```

## Test Coverage Matrix

| Behavior | Chat Completions | Responses | Anthropic |
| --- | --- | --- | --- |
| One-shot sends `stream: true` | Existing/update | Add | Add |
| Session sends `stream: true` | Existing | Existing/update | Existing/update |
| Multi-delta visible text | Existing | Add/update | Existing/add one-shot |
| Reasoning before visible text | Add | Add | Add |
| Buffered JSON fallback | Existing/expand session | Add | Add |
| Provider error before text | Existing | Add | Existing/add one-shot |
| Provider error after partial text | Existing | Add | Existing/add one-shot |
| Required success terminal | Existing `[DONE]` | Add `response.completed` | Existing `message_stop` |
| Truncated stream | Existing | Add | Existing/add one-shot |
| Malformed then valid event | Existing integration | Add | Add |
| Caller abort during one-shot | Shared/direct tests | Add | Add |
| Session abort | Existing integration | Add integration | Existing integration |
| Black-box title generation | Existing | Add | Add |
| Black-box session lifecycle | Existing | Add | Existing |

## Rollout

The change ships atomically with the server-agent packages. No feature flag is required because:

- all affected providers already support `stream: true` in their documented protocols;
- Chat Completions already uses SSE for both paths;
- Anthropic and Responses sessions already use SSE in production;
- JSON fallback remains available for successful buffered responses.

Monitor protocol-labeled provider failures after deployment, especially missing terminal events from partially compatible Responses endpoints. Such failures are preferable to accepting and persisting truncated output.

## Rollback

Rollback is a code revert only. There is no stored-data migration.

If a provider regression requires an emergency rollback:

- revert `stream: true` and the shared reader call in the affected one-shot function;
- retain the stricter Responses session terminal validation unless evidence shows the provider sends a different documented success terminal;
- retain test fixture additions because they improve protocol coverage without affecting production.

Do not add silent non-stream retries as an emergency workaround. They can duplicate billable requests.

## Acceptance Criteria

- Every POST that generates model text in the three direct runtimes includes `stream: true`.
- One-shot and session requests use the same response reader within each protocol.
- Chat Completions accepts only `[DONE]`-terminated SSE success.
- Anthropic accepts only `message_stop`-terminated SSE success.
- Responses accepts only `response.completed`-terminated SSE success.
- Provider errors reject even after partial text.
- Reasoning events are ignored without terminating parsing or entering visible output.
- Buffered JSON returned to a streaming request remains supported.
- Caller abort and timeout behavior remains covered and functional.
- Direct Chat Completions, Responses, and Anthropic each have black-box lifecycle and one-shot generation coverage.
- The full validation commands pass.
- A live `qwen3.7-plus` smoke test succeeds over Alibaba Cloud Global Anthropic Messages and OpenAI Responses SSE without exposing credentials.

## Resolved Decisions

- The scope is upstream provider SSE, not downstream UI token streaming.
- Every generation request asks for SSE.
- Successful buffered JSON is accepted without a retry.
- Protocol readers remain separate; only SSE framing and media-type detection are shared.
- Hidden reasoning is ignored and never promoted to visible output.
- Reasoning capability configuration and thinking-only retry policy are deferred.
- Responses terminal validation is corrected as part of the transport unification.
- A separate fake Responses server is preferred over adding another protocol to the Chat Completions fake.

## Deferred Risks

- Some compatible endpoints may omit the documented terminal event despite producing complete text. The stricter behavior will reject those responses. The endpoint-specific compatibility policy, if needed, should be designed separately rather than inferred from partial output.
- Direct sessions still deliver one final assistant message to the frontend rather than live token deltas.
- Thinking-only completions still become empty visible output; this design deliberately does not choose a reasoning fallback policy.
- Live provider tests are manual and depend on externally managed credentials, so CI confidence comes from strict fake-provider contract coverage.

## Implementation Validation

Implemented on 2026-07-20. The repository typecheck, check, unit suite, all 15 server integration files, and isolated random-port startup passed.

Post-change live verification used the repository's actual one-shot runtime functions with `qwen3.7-plus`, explicit `high` effort, a 120-second timeout, and a caller abort signal:

| Protocol | Request | Response | Visible result |
| --- | --- | --- | --- |
| Anthropic Messages | `stream: true`, effort and signal present | HTTP 200, `text/event-stream` | `ANTHROPIC_POST_CHANGE_OK` |
| OpenAI Responses | `stream: true`, effort and signal present | HTTP 200, `text/event-stream` | `RESPONSES_POST_CHANGE_OK` |

The live check read credentials only in process and did not print or persist keys, endpoints, headers, or hidden reasoning.

Independent adversarial reviews were run against baseline commit `67d22ea7`, the complete implementation diff, this design, every changed and untracked file, and nearby callers/runtimes:

- Claude Opus at `max`, session `23e8a952-cd7f-4c9b-8d12-9ca8b54514f7`.
- Pi `moonshotai/kimi-k3` at `xhigh`, session `adversarial-pi-kimi-k3-20260720-1`.

Neither reviewer found a substantive correctness defect. Their validated low-severity test and diagnostics findings were resolved by adding Anthropic one-shot abort and session JSON-fallback coverage, Responses pre-output failure and title-route failure coverage, and non-duplicative Responses error wording.

The final full validation pass also caught baseline architecture-budget regressions in the Claude and OpenCode runtime files. Their one-shot process and request-control logic now live in focused sibling modules; the existing file-size ceilings were preserved rather than raised. Typecheck, static checks, 2,761 unit tests, 60 server integration tests across 15 files, and an isolated random-port startup all pass after these fixes.

Both reviewers then resumed their original sessions against the complete post-fix worktree. Claude Opus at `max` and Pi `moonshotai/kimi-k3` at `xhigh` found no validated actionable findings and confirmed that the test additions and helper extractions preserve behavior.
