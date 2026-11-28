import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitServiceError } from "../../../../common/git-error.ts";
import { GitRpcServer } from "../../../../server/remote/server/git-rpc-server.ts";
import type { GitRpcRequest } from "../../../../server/remote/transport/git-protocol.ts";
import { ExecutionRuntime } from "../../../../server/runtime/execution-runtime.ts";

export async function rejectedGitRpc(method: string, request: unknown) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "garcon-git-rpc-case-"));
  const runtime = new ExecutionRuntime({
    id: "local", integrations: [], workspaceDir, projectBasePath: workspaceDir,
    resolveCredential: async () => { throw new Error("Unexpected credential resolution"); },
  });
  try {
    await new GitRpcServer(runtime).handle({ method, request } as GitRpcRequest, new AbortController().signal);
    throw new Error("Invalid input reached a Git operation");
  } catch (error) {
    if (!(error instanceof GitServiceError)) throw error;
    return { name: error.name, code: error.code, message: error.message, status: error.status };
  } finally {
    await runtime.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
