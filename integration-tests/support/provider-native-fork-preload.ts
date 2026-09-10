import { existsSync, writeFileSync } from 'node:fs';
import ClaudeIntegration from '../../server-agents/claude/src/index.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';

const diagnosticsPath = process.env.GARCON_TEST_NATIVE_FORK_DIAGNOSTICS ?? '';
if (!diagnosticsPath) throw new Error('Native fork fixture requires a diagnostics path');
const invalid = process.env.GARCON_TEST_NATIVE_FORK_INVALID;
if (invalid !== 'session-shape' && invalid !== 'hidden-artifact' && invalid !== 'non-record-artifact') {
  throw new Error('Native fork fixture requires an invalid outcome mode');
}
const diagnostics = { forks: 0, discards: 0, discardedPath: '', existedBeforeDiscard: false };

class InvalidNativeForkIntegration extends ClaudeIntegration {
  constructor(host: AgentHost) {
    super(host);
    const fork = this.forking.fork.bind(this.forking);
    const discard = this.forking.discard.bind(this.forking);
    this.forking.fork = async (request) => {
      const result = await fork(request);
      if (result.kind === 'materialized') {
        diagnostics.forks += 1;
        writeFileSync(diagnosticsPath, JSON.stringify(diagnostics));
        if (diagnostics.forks === 1) {
          if (invalid === 'hidden-artifact') {
            return Object.defineProperty({ kind: 'unmaterialized' as const }, 'session', { value: result.session });
          }
          if (invalid === 'non-record-artifact') return Object.assign([], result);
          Object.assign(result.session, { nativeSeedReceipt: undefined });
        }
      }
      return result;
    };
    this.forking.discard = async (session, signal) => {
      const path = session.nativeSession?.value.path;
      if (typeof path !== 'string') throw new Error('Fixture native fork has no artifact path');
      diagnostics.discards += 1;
      diagnostics.discardedPath = path;
      diagnostics.existedBeforeDiscard = existsSync(path);
      await discard(session, signal);
      writeFileSync(diagnosticsPath, JSON.stringify(diagnostics));
    };
  }
}

const index = defaultAgentIntegrations.indexOf(ClaudeIntegration);
if (index < 0) throw new Error('Missing Claude integration in native fork fixture');
defaultAgentIntegrations[index] = InvalidNativeForkIntegration;
