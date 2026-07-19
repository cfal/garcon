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
