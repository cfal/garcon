import { CodexAppServerClient } from '../../../../server-agents/codex/src/agents/codex/app-server/client.ts';
import { CodexAppServerRuntime } from '../../../../server-agents/codex/src/agents/codex/app-server/runtime.ts';

const [command, path, trace, mode = 'utility-overload'] = process.argv.slice(2);
const runtime = new CodexAppServerRuntime({
  createClient: () => new CodexAppServerClient({
    resolveCli: async () => ({ command, source: 'path' }),
    env: {
      SYNTHETIC_CODEX_TRACE: trace,
      SYNTHETIC_CODEX_MODE: mode,
      SYNTHETIC_CODEX_NATIVE_PATH: path,
    },
  }),
});
try {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resolved = await Promise.race([
    runtime.resolveNativePath({ projectPath: '/fixture', agentSessionId: 'thread' }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic utility probe timed out')), 3_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const expected = mode === 'utility-server-requests' ? null : path;
  if (resolved !== expected) throw new Error('Unexpected synthetic native path');
} finally {
  await runtime.shutdown();
}
