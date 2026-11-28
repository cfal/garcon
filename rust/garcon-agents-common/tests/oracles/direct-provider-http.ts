import { mkdir } from "node:fs/promises";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import path from "node:path";
import { DirectSessionStore } from "../../../../server-agents/common/src/direct/session-store.ts";
import { runAnthropicCompatibleSingleQuery } from "../../../../server-agents/common/src/direct/anthropic-compatible-chat-runtime.ts";
import { runOpenAiCompatibleSingleQuery } from "../../../../server-agents/common/src/direct/openai-compatible-chat-runtime.ts";
import { runOpenAiResponsesSingleQuery } from "../../../../server-agents/common/src/direct/openai-compatible-responses-runtime.ts";

const [mode, encoding, workspace, certificate, key] = Bun.argv.slice(2);
const crossOrigin = mode.startsWith("cross-") || mode.startsWith("chain-");
const chain = mode.startsWith("chain-");
const sameOrigin = mode.startsWith("same-");
const kind = mode.replace(/^(cross|chain|same)-/, "");
const openAiChunk = (content: string) => ({ choices: [{ delta: { content } }] });
const events = kind === "messages" ? [
  { type: "content_block_delta", delta: { type: "text_delta", text: "<think>reasoning</think>answer" } },
  { type: "message_stop" },
] : kind === "responses" ? [
  { type: "response.output_text.delta", delta: "<think>reasoning</think>answer" },
  { type: "response.completed", response: { id: "synthetic-id" } },
] : [openAiChunk("<think>reasoning</think>"), openAiChunk("answer"), "[DONE]"];
const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const body = encoding === "gzip" ? gzipSync(text)
  : encoding === "br" ? brotliCompressSync(text)
  : encoding === "deflate" ? deflateSync(text)
  : encoding === "zstd" ? Buffer.from(Bun.zstdCompressSync(text))
  : Buffer.from(text);
const encodingHeader = encoding === "identity" ? "" : `Content-Encoding: ${encoding}\r\n`;

interface Capture {
  requestLine: string;
  fields: Array<[string, string]>;
  body: string;
}
const captures: Capture[] = [];
let publishCaptures = false;
let sameOriginHops = 0;
const listener = Bun.listen<{ buffer: Buffer }>({
  hostname: "127.0.0.1", port: 0, data: { buffer: Buffer.alloc(0) },
  // Bun.listen takes a wire-encoded ALPN list.
  ...(certificate && key ? { tls: { cert: Bun.file(certificate), key: Bun.file(key), ALPNProtocols: "\x02h2\x08http/1.1" } } : {}),
  socket: {
    open(socket) { socket.data = { buffer: Buffer.alloc(0) }; },
    data(socket, chunk) {
      const bytes = Buffer.concat([socket.data.buffer, chunk]);
      socket.data.buffer = bytes;
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [requestLine, ...lines] = bytes.subarray(0, end).toString("latin1").split("\r\n");
      const fields = lines.map((line): [string, string] => {
        const delimiter = line.indexOf(":");
        const value = line.slice(delimiter + 1).replace(/^ /, "");
        return [line.slice(0, delimiter).toLowerCase(), value];
      }).sort(([a], [b]) => a.localeCompare(b));
      const length = Number(fields.find(([name]) => name === "content-length")?.[1] ?? 0);
      if (bytes.length < end + 4 + length) return;
      if (sameOrigin && !requestLine.startsWith("POST /redirect-target ")) {
        sameOriginHops++;
        socket.end("HTTP/1.1 307 Temporary Redirect\r\nLocation: /redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const capture = { requestLine, fields, body: bytes.subarray(end + 4, end + 4 + length).toString("base64") };
      captures.push(capture);
      if (publishCaptures) console.log(JSON.stringify(capture));
      const response = `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n${encodingHeader}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
      socket.end(Buffer.concat([Buffer.from(response), body]));
    },
  },
});
const redirect = crossOrigin ? Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (chain && url.pathname !== "/same-origin-hop") return Response.redirect(new URL("/same-origin-hop", url), 307);
    if (chain) sameOriginHops++;
    return Response.redirect(`http://127.0.0.1:${listener.port}/redirect-target?query=synthetic-secret`, 307);
  },
}) : null;

try {
  const baseUrl = `${certificate ? "https" : "http"}://127.0.0.1:${redirect?.port ?? listener.port}/v1`;
  const storage = {
    rootDirectory: workspace,
    async directory(namespace: string) {
      const directory = path.join(workspace, namespace);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    async claimLegacyWorkspaceDirectory() { throw new Error("Unexpected legacy claim"); },
  };
  const config = {
    runtimeLabel: "Synthetic provider", defaultModel: "fixture",
    endpointId: "fixture", endpointFingerprint: "a".repeat(64),
    sessions: new DirectSessionStore({ host: { agentId: "fixture", storage } }),
    getApiKey: () => "synthetic-token", getBaseUrl: () => baseUrl,
  };
  const query = kind === "messages" ? runAnthropicCompatibleSingleQuery
    : kind === "responses" ? runOpenAiResponsesSingleQuery : runOpenAiCompatibleSingleQuery;
  const answer = await query(config, "hello", { thinkingMode: "low", timeoutMs: 3000 });
  console.log(JSON.stringify({ baseUrl, answer, capture: captures[0], targetOrigin: `http://127.0.0.1:${listener.port}` }));
  publishCaptures = true;
  for await (const _ of Bun.stdin.stream()) { /* The test owns the listener lifetime. */ }
  console.log(JSON.stringify({ captureCount: captures.length, sameOriginHops }));
} finally {
  redirect?.stop(true);
  listener.stop(true);
}
