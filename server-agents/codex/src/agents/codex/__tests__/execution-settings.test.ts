import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AgentHost, AgentSessionConfiguration } from '@garcon/server-agent-interface';
import { createCodexConfig } from '../../../config.js';
import { CodexAppServerRuntime } from '../app-server/runtime.js';
import { CodexExecution } from '../execution.js';

const host = {
  agentId: 'codex',
  scope: { executorId: 'local', instanceId: 'test', integrationId: 'codex' },
  migrations: { async getVersion() { return 0; }, async read() { return undefined; }, async commit() {} },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  storage: { rootDirectory: '/synthetic', async directory() { return '/synthetic'; },
    async claimLegacyWorkspaceDirectory() { return { moved: 0, skipped: 0 }; } },
  environment: { get() { return undefined; } },
  apiProviders: { async resolveCredential() { return null; } },
} satisfies AgentHost;

const runtimes: CodexAppServerRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.shutdown(); });

function configurationFixture() {
  const runtime = new CodexAppServerRuntime();
  runtimes.push(runtime);
  spyOn(runtime, 'sourceEndpointId').mockReturnValue(null);
  const update = spyOn(runtime, 'updateSessionSettings').mockResolvedValue();
  const running = spyOn(runtime, 'isRunning').mockReturnValue(false);
  const execution = new CodexExecution(host, runtime, createPathNativeSessionCodec('codex'),
    createCodexConfig(host.environment), async () => ({ authenticated: false, canReauth: true, label: '', kind: 'none' }));
  const previous = {
    model: 'model-a', permissionMode: 'default', thinkingMode: 'low', endpoint: null,
    settings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'standard' } },
  } satisfies AgentSessionConfiguration;
  const next = { ...previous, permissionModeExplicit: false, settings: { ...previous.settings, values: { speed: 'ultrafast' } } };
  return { execution, previous, next, update, running };
}

describe('Codex speed preferences', () => {
  it('saves a speed-only change without checking run status or updating the native source', async () => {
    const { execution, previous, next, update, running } = configurationFixture();
    await execution.applySessionConfiguration('thread-1', next, previous);
    expect(update).not.toHaveBeenCalled();
    expect(running).not.toHaveBeenCalled();
  });

  it('still applies mixed non-speed changes and propagates their failure', async () => {
    const { execution, previous, next, update } = configurationFixture();
    const mixed = { ...next, model: 'model-b', thinkingMode: 'high', permissionMode: 'manualBypass', permissionModeExplicit: true } as const;
    await execution.applySessionConfiguration('thread-1', mixed, previous);
    expect(update).toHaveBeenCalledWith('thread-1', {
      model: 'model-b', thinkingMode: 'high', permissionMode: 'manualBypass',
    });
    update.mockRejectedValue(new Error('Synthetic settings failure'));
    await expect(execution.applySessionConfiguration('thread-1', mixed, previous)).rejects.toThrow('Synthetic settings failure');
  });
});
