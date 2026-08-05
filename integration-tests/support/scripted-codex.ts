// Runs the real pinned Codex binary with its model swapped for a script. The topology is the
// live one -- Codex talks to the credential proxy, the proxy forwards upstream -- with the
// upstream pointed at FakeCodexModel instead of OpenAI, so provider behavior stays real while
// every model choice is deterministic and no credential is required.

import { FakeCodexModel } from './fake-codex-model.js';
import {
  startLiveCodexTestEnvironment,
  type CodexTestToolMode,
  type LiveCodexTestEnvironment,
} from './live-codex.js';

export interface ScriptedCodexTestEnvironment extends LiveCodexTestEnvironment {
  readonly model: FakeCodexModel;
}

export async function startScriptedCodexTestEnvironment(options: {
  readonly toolMode?: CodexTestToolMode;
} = {}): Promise<ScriptedCodexTestEnvironment> {
  const model = FakeCodexModel.start();
  let environment: LiveCodexTestEnvironment;
  try {
    environment = await startLiveCodexTestEnvironment({
      upstreamUrl: model.responsesUrl,
      testingKey: `garcon-scripted-codex-${crypto.randomUUID()}`,
      toolMode: options.toolMode,
    });
  } catch (error) {
    model.stop();
    throw error;
  }
  return {
    ...environment,
    model,
    async dispose() {
      try {
        await environment.dispose();
      } finally {
        model.stop();
      }
    },
  };
}
