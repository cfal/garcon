import { parseAuthTokenIdentity } from '../../common/auth.js';
import { CANVAS_RECOVERY_STORAGE_PREFIX } from '../../web/src/lib/chat-canvas/canvas-recovery-storage.js';

export function canvasRecoveryKey(token: string | null | undefined, id: string): string {
  const payload = token?.split('.')[1];
  const identity = payload && parseAuthTokenIdentity(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  if (!identity) throw new Error('Canvas fixture requires a signed-in viewer');
  return `${CANVAS_RECOVERY_STORAGE_PREFIX}viewer:${encodeURIComponent('user:' + identity.ownerKey)}:${id}`;
}
