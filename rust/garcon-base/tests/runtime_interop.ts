import { readFile } from "node:fs/promises";
import { parseCliRuntimeDescriptor } from "../../../common/server-runtime.ts";
import { publishRuntimeDescriptor, removeServerRuntime } from "../../../server/common/server-runtime.ts";

const [action, path, instance] = process.argv.slice(2);
if (!path) throw new Error("expected a fixture path");

if (action === "read") {
  const descriptor = parseCliRuntimeDescriptor(JSON.parse(await readFile(path, "utf8")));
  console.log(JSON.stringify(descriptor));
} else if (action === "write") {
  await publishRuntimeDescriptor(path, {
    schemaVersion: 1,
    instanceId: "bun-executor-fixture",
    startedAt: "1970-01-01T00:00:00.000Z",
    kind: "executor-cli",
    pid: 2468,
    baseUrl: "http://127.0.0.1:4321",
    localCapability: "garcon_local_" + "x".repeat(43),
  });
} else if (action === "remove" && instance) {
  console.log(JSON.stringify(await removeServerRuntime(path, instance)));
} else {
  throw new Error("unsupported fixture action");
}
