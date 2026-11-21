import type { AcpClient } from './client.js';
import { isRecoverableLoadFailure } from './errors.js';
import type { AcpSessionNewResult } from './protocol.js';

export interface AcpAdvertisedCapabilities {
  loadSession: boolean;
  sessionResume: boolean;
}

// Reconnects only to the original conversation. A new session cannot supply
// that conversation's history, even if the agent no longer recognizes its ID.
export async function reconnectAcpSession(
  client: AcpClient,
  target: Parameters<AcpClient['resumeSession']>[0],
): Promise<AcpSessionNewResult> {
  const { sessionResume, loadSession } = client.getAdvertisedCapabilities();
  const methods: Array<'resumeSession' | 'loadSession'> = [];
  if (sessionResume) methods.push('resumeSession');
  if (loadSession) methods.push('loadSession');
  for (const method of methods) {
    try {
      const opened = await client[method](target);
      return { ...opened, sessionId: target.sessionId };
    } catch (error) {
      if (!isRecoverableLoadFailure(error)) throw error;
    }
  }
  throw new Error(`Unable to restore ACP session ${target.sessionId}. Start a new chat session.`);
}
