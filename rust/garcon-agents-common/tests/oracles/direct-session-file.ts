import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DirectSessionStore } from "../../../../server-agents/common/src/direct/session-store.ts";

const [workspace, command, sessionId] = Bun.argv.slice(2);
const agentId = "synthetic-provider";
const storage = {
  rootDirectory: workspace,
  async directory(namespace: string) {
    const directory = path.join(workspace, namespace);
    await mkdir(directory, { recursive: true });
    return directory;
  },
  async claimLegacyWorkspaceDirectory() {
    throw new Error("Unexpected legacy claim in the session oracle");
  },
};
const store = new DirectSessionStore({ host: { agentId, storage }, now: () => "2026-01-02T03:04:05.678Z" });

if (command === "write") {
  await store.create({ sessionId, runId: "run-1", content: "first", attachments: [] });
} else if (command !== "read") {
  throw new Error(`Unexpected session oracle command: ${command}`);
}
const snapshot = await store.load(sessionId);
console.log(JSON.stringify({
  header: snapshot.header,
  records: snapshot.records,
  bytes: await readFile(snapshot.path, "utf8"),
}));
