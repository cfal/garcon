export const NODE_SESSION_CHANNEL_PATH = '/ws/nodes';
export const NODE_BULK_CHANNEL_PATH = '/ws/nodes/bulk';

export type NodeChannelKind = 'session' | 'bulk';

export function nodeChannelKind(pathname: string): NodeChannelKind | null {
  if (pathname === NODE_SESSION_CHANNEL_PATH) return 'session';
  if (pathname === NODE_BULK_CHANNEL_PATH) return 'bulk';
  return null;
}
