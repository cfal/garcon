import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { createNoiseServer, type NoiseSocketData } from "../../../../server/node_modules/@cfal/noise-ws/src/index.ts";
import { RpcAdmissionBudgets } from "../../../../server/remote/transport/rpc-admission.ts";
import { ExecutorRpcConnection } from "../../../../server/remote/transport/rpc-connection.ts";
import { RpcReplyJournal } from "../../../../server/remote/transport/rpc-journal.ts";
import { ParkedRpcCalls } from "../../../../server/remote/transport/rpc.ts";
import { WebSocketLink } from "../../../../server/remote/transport/websocket-link.ts";
import { version } from "../../../../package.json";

assert.equal(Bun.version, "1.4.3");
const [role, mode, address] = Bun.argv.slice(2);
assert(role === "controller" || role === "worker");
const executorId = "22222222-2222-4222-8222-222222222222";
const psk = Buffer.alloc(32, 7);
const output = (event: object) => console.log(JSON.stringify(event));
if (mode === "bad-version" || mode === "bad-revision") {
  const acceptor = createNoiseServer();
  const server = Bun.serve<NoiseSocketData>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      return acceptor.upgrade(request, server, {
        psk, context: "garcon-executor/v1",
        onMessage(socket, message) {
          const hello = JSON.parse(String(message));
          socket.send(JSON.stringify({
            ...hello, role, runtimeId: "synthetic-bun-bad-version",
            version: mode === "bad-version" ? "0.0.0+protocol.71" : `${version}+protocol.70`,
          }));
        },
      });
    },
    websocket: acceptor.websocket,
  });
  output({ type: "listening", address: `ws://127.0.0.1:${server.port}/executor` });
  await Bun.stdin.bytes();
  acceptor.close();
  await server.stop(true);
  process.exit(0);
}
const peer = new WebSocketLink({
  role,
  executorId: role === "controller" ? executorId : undefined,
  runtimeId: `synthetic-bun-${role}`,
  secret: psk.toString("base64url"),
  noTls: true,
  redialDelaysMs: [25],
});
const admission = new RpcAdmissionBudgets();
const journal = role === "worker" ? new RpcReplyJournal() : undefined;
const parked = role === "controller"
  ? { primary: new ParkedRpcCalls(), bulk: new ParkedRpcCalls() }
  : undefined;
const hold = Promise.withResolvers<void>();
let held = 0;

peer.onSession((session) => {
  const connection = new ExecutorRpcConnection(peer, session, {
    admission, journal, parked, bulkTiming: { redialDelaysMs: [25] },
  });
  connection.onEndpoint((rpc) => rpc.handle(async (frame) => {
    if ((frame.request as { hold?: boolean } | null)?.hold) {
      output({ type: "held", count: ++held });
      await hold.promise;
    }
    return { peer: role, input: frame.request };
  }));
  connection.onBulkChanged((status) => {
    if (status.phase === "ready") {
      output({ type: "bulk-ready", sessionId: status.sessionId, primarySessionId: session.id });
    }
  });
  void session.ready.then(async () => {
    if (role === "controller") await connection.primary.reconcileParked();
    connection.activate();
    output({ type: "ready", sessionId: session.id, executorId: session.executorId });
  }).catch((error) => {
    if (session.connected) throw error;
  });
});
peer.onError((failure) => console.error(JSON.stringify(failure)));
if (mode === "serve") {
  output({ type: "listening", address: peer.listen(0, "0.0.0.0") });
} else {
  assert.equal(mode, "dial");
  peer.dial(address!);
}
for await (const command of createInterface({ input: process.stdin, terminal: false })) {
  if (command === "release") hold.resolve();
  else assert.fail(`unexpected test command ${command}`);
}
await peer.dispose();
journal?.dispose();
parked?.primary.close();
parked?.bulk.close();
