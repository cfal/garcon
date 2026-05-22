import { runSingleQuery as runSingleQueryCursor } from '../../cursor-cli.js';
import { getCursorModels } from '../../cursor-models.js';
import { CursorRequestIdentityStore } from '../../cursor-request-identities.js';
import { AcpRuntime } from '../../acp/runtime.js';
import { createHarnessCapabilities } from '../../harness-plugin-bridge.js';
import type { HarnessPlugin } from '../../harness-plugin.js';
import { createCursorAcpPolicy } from './cursor-acp-policy.js';
import { cursorAuthDriver } from './cursor-auth-driver.js';
import { CursorAcpEventConverter } from './cursor-acp-event-converter.js';
import { CursorReplayHealth } from './cursor-replay-health.js';
import { createCursorTranscriptSource } from './cursor-transcript-source.js';

interface CreateCursorHarnessPluginArgs {
  requestIdentities: CursorRequestIdentityStore;
}

export function createCursorHarnessPlugin(args: CreateCursorHarnessPluginArgs): HarnessPlugin {
  const replayHealth = new CursorReplayHealth();
  const runtime = new AcpRuntime(createCursorAcpPolicy(), {
    converter: new CursorAcpEventConverter(),
  });
  // Keeps transcript durability on SQLite until ACP replay reliability improves.
  const transcript = createCursorTranscriptSource(args.requestIdentities);

  return {
    id: 'cursor',
    label: 'Cursor',
    runtime,
    transcript: {
      async loadMessages(session, context) {
        const messages = await transcript.loadMessages(session, context);
        replayHealth.record({
          loadedAt: new Date().toISOString(),
          replayUpdates: 0,
          success: true,
        });
        return messages;
      },
      getPreview: transcript.getPreview,
    },
    auth: cursorAuthDriver,
    capabilities: createHarnessCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: getCursorModels,
    }),
    runSingleQuery(prompt, options) {
      return runSingleQueryCursor(prompt, options);
    },
  };
}
