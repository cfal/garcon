import { join } from 'node:path';
import { AgentIntegrationError } from '../../../../server-agents/interface/src/errors.ts';
import {
  inspectCodexHistoryProfile,
  inspectCodexSessionIdentity,
  inspectCodexSessionModelProvider,
} from '../../../../server-agents/codex/src/agents/codex/history-profile.ts';
import { resolveCodexNativePath } from '../../../../server-agents/codex/src/agents/codex/native-path.ts';

const root = process.argv[2]!;
const signal = new AbortController().signal;
const inspect = (file: string, expectedThreadId = 'thread') => ({ nativePath: join(root, file), expectedThreadId, signal });
const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function outcome(operation: () => Promise<unknown>) {
  try {
    return { value: await operation() };
  } catch (error) {
    if (!(error instanceof AgentIntegrationError)) throw error;
    return { error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details ?? null } };
  }
}

const resolve = async (stored: string, discovered: string | Error | null) => {
  let discoveryCalls = 0;
  const value = await outcome(() => resolveCodexNativePath({
    agentSessionId: 'thread',
    nativePath: join(root, stored),
  }, {
    logger,
    signal,
    async discover() {
      discoveryCalls++;
      if (discovered instanceof Error) throw discovered;
      return discovered === null ? null : join(root, discovered);
    },
  }));
  return { value, discoveryCalls };
};

const result = {
  paginated: await outcome(() => inspectCodexHistoryProfile(inspect('paginated'))),
  savedProvider: await outcome(() => inspectCodexSessionModelProvider(inspect('paginated'))),
  missingMode: await outcome(() => inspectCodexHistoryProfile(inspect('legacy'))),
  invalidProvider: await outcome(() => inspectCodexSessionModelProvider(inspect('invalid'))),
  futureProfile: await outcome(() => inspectCodexHistoryProfile(inspect('future'))),
  futureIdentity: await outcome(() => inspectCodexSessionIdentity(inspect('future'))),
  missing: await outcome(() => inspectCodexSessionIdentity(inspect('missing'))),
  empty: await outcome(() => inspectCodexSessionIdentity(inspect('empty'))),
  incomplete: await outcome(() => inspectCodexSessionIdentity(inspect('incomplete'))),
  oversized: await outcome(() => inspectCodexSessionIdentity(inspect('oversized'))),
  mismatch: await resolve('mismatch', 'paginated'),
  stillMissing: await resolve('missing', 'also-missing'),
  moved: await resolve('missing', 'paginated'),
  corrupt: await resolve('incomplete', 'paginated'),
  discoveryError: await resolve('missing', new Error('synthetic discovery failure')),
};

process.stdout.write(JSON.stringify(result));
