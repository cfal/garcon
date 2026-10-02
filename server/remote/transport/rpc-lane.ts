export type RpcLane = 'primary' | 'bulk';

export const RPC_LANES = ['primary', 'bulk'] as const satisfies readonly RpcLane[];

export type BulkConnectionControl = {
  readonly type: 'bulk-prepare' | 'bulk-prepared' | 'bulk-connect' | 'bulk-activate' | 'bulk-active' | 'bulk-lost';
  readonly sessionId: string;
};

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function parseBulkControl(value: unknown): BulkConnectionControl {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2
    || !('type' in value) || !('sessionId' in value) || !isSessionId(value.sessionId)
    || !['bulk-prepare', 'bulk-prepared', 'bulk-connect', 'bulk-activate', 'bulk-active', 'bulk-lost'].includes(String(value.type))) {
    throw new Error('Invalid bulk connection control');
  }
  return value as BulkConnectionControl;
}
