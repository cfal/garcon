import { runSingleQuery as runSingleQueryCursor } from '../../providers/cursor-cli.js';
import { getCursorModels } from '../../providers/cursor-models.js';
import { CursorRequestIdentityStore } from '../../providers/cursor-request-identities.js';
import { createHarnessCapabilities } from '../capabilities.js';
import { AcpHarnessRuntime } from '../shared/acp-harness-runtime.js';
import type { Harness } from '../types.js';
import { createCursorAcpPolicy } from './cursor-acp-policy.js';
import { CursorAcpEventConverter } from './cursor-acp-event-converter.js';
import { cursorAuthDriver } from './cursor-auth-driver.js';
import { CursorReplayHealth } from './cursor-replay-health.js';
import { createCursorTranscriptSource } from './cursor-transcript-source.js';

export interface CreateCursorHarnessArgs {
  workspaceDir: string;
}

export function createCursorHarness(args: CreateCursorHarnessArgs): Harness {
  const requestIdentities = new CursorRequestIdentityStore(args.workspaceDir);
  const replayHealth = new CursorReplayHealth();
  const runtime = new AcpHarnessRuntime(createCursorAcpPolicy(), {
    converter: new CursorAcpEventConverter(),
  });
  const transcript = createCursorTranscriptSource(requestIdentities);

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
