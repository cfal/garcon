import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import { inspectCodexSessionIdentity } from './history-profile.js';

const MISSING_PATH_CODES = new Set(['ENOENT']);

export interface CodexNativePathSession {
  readonly agentSessionId: string | null;
  readonly nativePath: string | null;
}

export interface CodexNativePathOptions {
  readonly discover: () => Promise<string | null>;
  readonly logger: AgentLogger;
  readonly signal: AbortSignal;
}

export async function resolveCodexNativePath(
  session: CodexNativePathSession,
  options: CodexNativePathOptions,
): Promise<string | null> {
  options.signal.throwIfAborted();
  const agentSessionId = session.agentSessionId;
  if (!agentSessionId) return null;

  if (
    session.nativePath &&
    (await matchesCodexSession(session.nativePath, agentSessionId, 'stored', options))
  ) {
    return session.nativePath;
  }

  let discoveredPath: string | null;
  try {
    discoveredPath = await options.discover();
  } catch (error) {
    options.signal.throwIfAborted();
    options.logger.warn('Codex transcript discovery failed', {
      agentSessionId,
      error: errorMessage(error),
    });
    throw new AgentIntegrationError(
      'UNAVAILABLE',
      'Codex transcript discovery is temporarily unavailable',
      true,
      {
        provider: 'codex',
        agentSessionId,
        reason: 'discovery-error',
      },
    );
  }
  options.signal.throwIfAborted();
  if (!discoveredPath) return null;

  return (await matchesCodexSession(discoveredPath, agentSessionId, 'app-server', options))
    ? discoveredPath
    : null;
}

async function matchesCodexSession(
  nativePath: string,
  agentSessionId: string,
  source: 'stored' | 'app-server',
  options: CodexNativePathOptions,
): Promise<boolean> {
  try {
    await inspectCodexSessionIdentity({
      nativePath,
      expectedThreadId: agentSessionId,
      signal: options.signal,
    });
    return true;
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof AgentIntegrationError && error.code === 'TRANSCRIPT_UNAVAILABLE') {
      const reason = stringDetail(error, 'reason') ?? 'invalid-metadata';
      const causeCode = stringDetail(error, 'causeCode');
      if (reason === 'read-failed' && (!causeCode || !MISSING_PATH_CODES.has(causeCode))) {
        options.logger.warn('Codex transcript path could not be validated', {
          agentSessionId,
          nativePath,
          resolutionSource: source,
          reason,
          causeCode,
          error: error.message,
        });
        throw new AgentIntegrationError(
          'UNAVAILABLE',
          'Codex transcript path is temporarily unavailable',
          true,
          {
            provider: 'codex',
            agentSessionId,
            nativePath,
            reason: 'path-read-error',
            ...(causeCode ? { causeCode } : {}),
          },
        );
      }

      options.logger.warn(
        source === 'stored'
          ? 'Codex stored transcript path is unavailable'
          : 'Codex discovered transcript path was rejected',
        {
          agentSessionId,
          nativePath,
          resolutionSource: source,
          reason,
          ...(causeCode ? { causeCode } : {}),
        },
      );
      if (reason === 'read-failed' && causeCode && MISSING_PATH_CODES.has(causeCode)) {
        return false;
      }
      throw error;
    }
    throw error;
  }
}

function stringDetail(error: AgentIntegrationError, key: string): string | null {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
