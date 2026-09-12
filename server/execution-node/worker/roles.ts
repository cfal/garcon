export type NodeWorkerRole = 'session' | 'instance';
export const NODE_SESSION_WORKER_FLAG = '--internal-node-session-worker';
export const NODE_INSTANCE_WORKER_FLAG = '--internal-node-instance-worker';

export function nodeWorkerRoleFlag(role: NodeWorkerRole): string {
  return role === 'session' ? NODE_SESSION_WORKER_FLAG : NODE_INSTANCE_WORKER_FLAG;
}
