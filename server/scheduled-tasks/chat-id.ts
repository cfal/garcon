import crypto from 'crypto';

export function scheduledChatId(taskId: string, scheduledFor: string): string {
  const epoch = String(Date.parse(scheduledFor));
  const suffix = crypto
    .createHash('sha256')
    .update(`${taskId}:${scheduledFor}`)
    .digest()
    .readUIntBE(0, 3)
    .toString()
    .padStart(8, '0');
  return `${epoch}${suffix}`;
}
