import type { AcpClient } from './client.js';
import { isRecoverableLoadFailure } from './errors.js';
import type { AcpSessionConfigOption, AcpSessionModelState } from './protocol.js';

export type ReconnectStrategy = 'resume' | 'load' | 'new';

export interface AcpAdvertisedCapabilities {
  loadSession: boolean;
  sessionResume: boolean;
}

export function reconnectOrder(caps: AcpAdvertisedCapabilities): ReconnectStrategy[] {
  if (caps.sessionResume) return ['resume', 'load', 'new'];
  if (caps.loadSession) return ['load', 'new'];
  return ['new'];
}

export interface AcpReconnectTarget {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers?: unknown[];
  readonly allowNewSession: boolean;
  readonly newSessionModel?: string;
}

export interface AcpReconnectedSession {
  readonly sessionId: string;
  readonly configOptions?: AcpSessionConfigOption[];
  readonly models?: AcpSessionModelState;
}

// Restores a session in a fresh agent process, trying each strategy in order;
// a strategy the agent lacks or a session it no longer knows falls through.
export async function reconnectAcpSession(
  client: AcpClient,
  target: AcpReconnectTarget,
  order: readonly ReconnectStrategy[],
): Promise<AcpReconnectedSession | null> {
  const existing = { sessionId: target.sessionId, cwd: target.cwd, mcpServers: target.mcpServers };
  for (const strategy of order) {
    if (strategy === 'new') {
      if (!target.allowNewSession) continue;
      const created = await client.newSession({
        cwd: target.cwd,
        mcpServers: target.mcpServers,
        ...(target.newSessionModel ? { model: target.newSessionModel } : {}),
      });
      return { sessionId: created.sessionId, configOptions: created.configOptions, models: created.models };
    }
    try {
      const loaded = strategy === 'resume'
        ? await client.resumeSession(existing)
        : await client.loadSession(existing);
      return { sessionId: target.sessionId, configOptions: loaded.configOptions, models: loaded.models };
    } catch (error) {
      if (!isRecoverableLoadFailure(error)) throw error;
    }
  }
  return null;
}
