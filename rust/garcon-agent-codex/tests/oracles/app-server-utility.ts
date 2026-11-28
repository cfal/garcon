import { CodexAppServerClient } from '../../../../server-agents/codex/src/agents/codex/app-server/client.ts';
import { CodexAppServerRuntime } from '../../../../server-agents/codex/src/agents/codex/app-server/runtime.ts';

const [command, path, trace] = process.argv.slice(2);
const runtime = new CodexAppServerRuntime({
  createClient: () => new CodexAppServerClient({
    resolveCli: async () => ({ command, source: 'path' }),
    env: {
      SYNTHETIC_CODEX_TRACE: trace,
      SYNTHETIC_CODEX_MODE: 'utility-overload',
      SYNTHETIC_CODEX_NATIVE_PATH: path,
    },
  }),
});
try {
  const resolved = await runtime.resolveNativePath({ projectPath: '/fixture', agentSessionId: 'thread' });
  if (resolved !== path) throw new Error('Synthetic native path was not discovered');
} finally {
  await runtime.shutdown();
}
