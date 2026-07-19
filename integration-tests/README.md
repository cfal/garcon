# Integration Tests

This suite validates Garcon across real process and transport boundaries. It starts an isolated Garcon server, drives its HTTP and WebSocket contracts through a typed client, and uses deterministic OpenAI-compatible and Anthropic Messages fake providers. The E2E lane adds the production SPA and Lightpanda.

Integration coverage is required, not optional, when a change can fail only after multiple owners interact. Queueing, transcript stability, reconnect, restart recovery, command idempotency, concurrent chats, provider failures, forks, and deletion all belong here. A focused unit test should still cover the underlying component behavior.

## Choose The Test Layer

| Behavior | Location |
| --- | --- |
| Pure logic, parsers, stores, reducers, adapters, and isolated components | A unit test beside the owning production module |
| Server behavior spanning HTTP, WebSocket, provider IO, persistence, process lifecycle, or multiple server services | `tests/server/` |
| User behavior whose contract includes SPA routing, rendering, dialogs, browser events, or client/server coordination | `tests/e2e/` |

Prefer the lowest layer that can reproduce the failure, but do not mock away the boundary under test. Cross-boundary production regressions generally require both a focused unit test and a regression test in this package. Lightpanda tests complement server integration tests; they do not replace them.

## Structure

```text
integration-tests/
  support/
    integration-fixture.ts   Isolated server, provider, directories, restart, and diagnostics
    garcon-process.ts        Garcon child-process lifecycle
    garcon-client.ts         Typed HTTP and WebSocket test client
    fake-openai-server.ts    Strict OpenAI-compatible provider double and response plans
    fake-anthropic-server.ts Strict Anthropic Messages provider double and response plans
    chat-assertions.ts       Shared transcript assertions
    e2e-fixture.ts           Server fixture plus Lightpanda and production SPA
    spa-driver.ts            Reusable user-level SPA actions and waits
    lightpanda-process.ts    Isolated Lightpanda CDP lifecycle
  tests/
    server/                  Black-box server integration tests
    e2e/                     Lightpanda SPA workflows
  artifacts/                 Failure diagnostics; generated and gitignored
```

Keep scenario policy in the test and reusable mechanics in `support/`. Extend `GarconTestClient` for a new typed API operation instead of scattering raw `fetch` calls. Extend `SpaDriver` when multiple browser tests need the same user action. Add a shared helper only when it has a clear owner and removes real duplication.

## Server Test Pattern

Use `withIntegrationFixture` so every test receives fresh config, workspace, project, home, server, WebSocket client, and both fake-provider states. Direct helpers take an explicit agent configuration; use `fixture.directAgents.openAi` or `fixture.directAgents.anthropic` so protocol selection is visible at each call site.

```ts
test('preserves the invariant', async () => {
  await withIntegrationFixture('descriptive-artifact-name', async (fixture) => {
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'unique-input' });
    const eventCursor = fixture.client.markEvents();

    const accepted = await fixture.client.startDirectChat({
      chatId,
      content: 'unique-input',
      projectPath: fixture.dirs.project,
      agent: fixture.directAgents.openAi,
    });
    await held.received;
    held.releaseEcho();

    await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
      afterIndex: eventCursor,
    });
  });
});
```

Register provider holds or failure plans before sending the command. Mark the WebSocket event cursor before the action that should emit events. Await terminal state by exact chat and turn identity. Assert the externally observable contract across the relevant HTTP response, WebSocket events, provider requests, transcript, queue, and durable state rather than reaching into server internals.

Use `restartGarcon()` for graceful restart behavior and `crashAndRestartGarcon()` for abrupt-loss recovery. Make concurrency deterministic with provider holds and explicit release order, not timing guesses.

## E2E Test Pattern

Use `withE2eFixture` and `SpaDriver`. Open the SPA and wait for its WebSocket before interacting.

```ts
await withE2eFixture('descriptive-e2e-name', async (fixture) => {
  const app = new SpaDriver(fixture.page, fixture.integration);
  await app.open();
  await fixture.waitForSpaWebSocket();

  await app.startOpenAiDirectChat('unique-ui-input');
  await app.waitForText('echo:unique-ui-input');
  fixture.assertNoBrowserErrors();
});
```

Perform the behavior under test through the SPA. The typed client may prepare state or make authoritative server assertions, but it must not bypass the browser action being tested. Wait for a transition that could not already be true before the action, such as a changed chat ID, a correlated provider request, or a new WebSocket event. Do not treat pre-existing transcript text as proof that a click completed.

Lightpanda validates DOM, routing, events, and browser/server coordination. It does not validate pixel layout or screenshots; use an appropriate rendered-browser workflow for visual assertions.

## Determinism And Cleanliness

- Never use arbitrary sleeps. Wait on a correlated event, provider request, route change, DOM predicate, process state, or durable API result.
- Never depend on test order, fixed ports, the developer's Garcon data, external network services, or real provider credentials.
- Use `fixture.newChatId()`, unique message text, and generated request identities. Do not invent invalid or wall-clock-sensitive identifiers.
- Assert exact chat, turn, request, and queue-entry identities when races are possible. Count duplicate-sensitive transcript rows explicitly.
- Keep each test focused on one invariant. Split unrelated workflows instead of building a long scenario that obscures the failing boundary.
- Use the fixture wrappers for teardown. Do not manually kill Garcon or Lightpanda processes.
- Consume every fake-provider response plan and release or explicitly abort every hold. Cleanup intentionally fails on unused plans, protocol violations, leaked holds, or unexpected process exits.
- Assert `fixture.assertNoBrowserErrors()` in successful E2E workflows. Do not swallow console, protocol, cleanup, or shutdown failures.
- Do not commit generated files under `artifacts/`. Successful runs remove their temporary directories automatically.

Set `KEEP_INTEGRATION_ARTIFACTS=1` to retain isolated fixture directories for investigation. Failed server tests write diagnostics under `artifacts/server/`; failed E2E tests write the DOM snapshot, browser errors, Lightpanda logs, server exchanges, WebSocket events, and provider requests under `artifacts/e2e/`.

## Running Tests

From the repository root:

```bash
bun run typecheck
bun run test:integration:server

bun run build
LIGHTPANDA_BIN=/path/to/lightpanda bun run test:integration:e2e

bun run check
bun run test
```

`bun run test:integration` runs the server integration lane but not the Lightpanda lane. The root `bun run test` command runs the server and web unit suites, so run the integration commands explicitly while developing cross-boundary changes. The E2E fixture requires a current production build at `web/build/index.html` and an executable `LIGHTPANDA_BIN`. CI pins and verifies the Lightpanda binary in `.github/workflows/integration-tests.yml`.

Focused runs are useful while iterating:

```bash
cd integration-tests
bun test --max-concurrency=1 --timeout=30000 tests/server/queue-lifecycle.test.ts
bun test --max-concurrency=1 --timeout=60000 tests/e2e/queue-workflow.test.ts
```

Keep the configured single-test concurrency. The suites exercise process lifecycle and ordered race scenarios deliberately.

## Provider Scope

The deterministic lane exercises `direct-openai-compatible` and `direct-anthropic-compatible` through separate protocol fakes. Both providers are present in every fixture and remain alive across Garcon restarts. The Anthropic fake covers the Messages HTTP and SSE contract; it is not a fake Claude Code process or Claude Agent SDK. Together the fakes prove Garcon's multi-agent routing, lifecycle, queue, transcript, persistence, search, and SPA behavior without spending credentials or depending on external availability. They do not prove the native behavior of Claude, Codex, Pi, OpenCode, Factory, Amp, Cursor, or other provider binaries.

Future credential-backed provider suites should be opt-in, isolated from the deterministic required lane, and explicit about cost, rate limits, cleanup, and supported environments. Add them when test API keys are available; do not weaken or replace fake-provider coverage with live-provider tests.

## Change Checklist

- Places the test at the layer that owns the failing boundary.
- Reproduces every relevant production regression before the fix.
- Uses typed clients, structured provider plans, and stable identities.
- Synchronizes on authoritative state rather than elapsed time.
- Covers duplicate, retry, failure, restart, or concurrency behavior when applicable.
- Leaves no process, hold, response plan, artifact, or mutable global state behind.
- Passes the focused lane, integration typecheck, `bun run check`, and `bun run test`.
