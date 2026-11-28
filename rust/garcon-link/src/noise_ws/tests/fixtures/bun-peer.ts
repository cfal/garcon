import assert from "node:assert/strict";
import {
  connectNoiseWebSocket,
  createNoiseServer,
  type NoiseSocketData,
} from "../../../../../../server/node_modules/@cfal/noise-ws/src/index.ts";

assert.equal(Bun.version, "1.4.3");
const psk = Buffer.alloc(32, 42);
const context = "noise-ws-tests/v1";
const [mode, address] = Bun.argv.slice(2);

if (mode === "serve") {
  const noise = createNoiseServer();
  const server = Bun.serve<NoiseSocketData>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      let opened = false;
      return noise.upgrade(request, server, {
        psk,
        context,
        ...(path === "/oversized" && { limits: { maxMessageBytes: 8 } }),
        onOpen() { opened = true; },
        onMessage(socket, message) { socket.send(message); },
        onClose(_socket, info) {
          console.log(JSON.stringify({
            path, opened, authenticated: info.authenticated, error: info.error?.code ?? null,
          }));
        },
      });
    },
    websocket: noise.websocket,
  });
  console.log(`ws://127.0.0.1:${server.port}`);
  await Bun.stdin.bytes();
  noise.close();
  await server.stop(true);
} else if (mode === "dial") {
  const messages: (string | Uint8Array)[] = [];
  const echoes = Promise.withResolvers<void>();
  const normal = connectNoiseWebSocket(`${address}/normal`, {
    psk, context,
    onMessage(_socket, message) {
      messages.push(message);
      if (messages.length === 2) echoes.resolve();
    },
  });
  await normal.ready;
  const bytes = Buffer.alloc(150_000, 27);
  normal.send("Bun to Rust");
  normal.send(bytes);
  await echoes.promise;
  assert.equal(messages[0], "Bun to Rust");
  assert.deepEqual(Buffer.from(messages[1] as Uint8Array), bytes);
  normal.close();
  for (const path of ["/wrong-key", "/wrong-context"]) {
    const wrong = connectNoiseWebSocket(`${address}${path}`, {
      psk: path === "/wrong-key" ? Buffer.alloc(32, 99) : psk,
      context: path === "/wrong-context" ? `${context}-wrong` : context,
      onMessage() { assert.fail("unauthenticated application message"); },
    });
    await assert.rejects(wrong.ready, { code: "TRANSPORT_CLOSED" });
  }
  const oversized = connectNoiseWebSocket(`${address}/oversized`, {
    psk, context,
    onMessage() { assert.fail("oversized message was delivered"); },
  });
  await oversized.ready;
  oversized.send("more than eight bytes");
  assert.equal((await oversized.closed).error?.code, "TRANSPORT_CLOSED");
} else {
  throw new Error("Expected serve or dial");
}
