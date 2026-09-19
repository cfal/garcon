import { randomBytes } from 'node:crypto';
import { isRemoteNodeId, type ExecutionNodeDirection } from '../../common/execution-nodes.js';
import { ValidationDomainError } from '../lib/domain-error.js';

export function createNodeSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function isNodeSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

export function parseConnectionUrl(value: string): { socketUrl: string; secret: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationDomainError('Invalid execution-node connection URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) {
    throw new ValidationDomainError('Invalid execution-node connection URL');
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const secret = fragment.get('secret');
  if ([...fragment.keys()].length !== 1 || !isNodeSecret(secret)) {
    throw new ValidationDomainError('Invalid execution-node connection credential');
  }
  url.hash = '';
  return { socketUrl: url.href, secret };
}

export function validateNodeSocketUrl(value: string, options: {
  direction: ExecutionNodeDirection;
  allowInsecureDevelopment: boolean;
  nodeId?: string;
  allowPlaceholder?: boolean;
}): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationDomainError('Invalid execution-node address'); }
  if (url.hash || url.search || url.username || url.password
    || !(url.protocol === 'wss:' || url.protocol === 'ws:' && options.allowInsecureDevelopment)) {
    throw new ValidationDomainError('Execution-node connections require TLS outside explicit development mode');
  }
  if (options.direction === 'controller-connects') {
    if (url.pathname !== '/execution-node') throw new ValidationDomainError('Expected the worker execution-node endpoint');
  } else {
    const id = url.pathname.startsWith('/execution-node/') ? url.pathname.slice('/execution-node/'.length) : '';
    if (!isRemoteNodeId(id) || options.nodeId !== undefined && id !== options.nodeId) {
      throw new ValidationDomainError('The connection URL must retain the configured execution-node ID');
    }
  }
  if (!options.allowPlaceholder && (url.hostname === '0.0.0.0' || url.hostname === '[::]')) {
    throw new ValidationDomainError('Replace the unspecified address with a reachable hostname or IP');
  }
  return url.href;
}

export function nodeConnectionUrl(socketUrl: string, secret: string): string {
  const url = new URL(socketUrl);
  url.hash = new URLSearchParams({ secret }).toString();
  return url.href;
}
