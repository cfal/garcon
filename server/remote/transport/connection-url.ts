import { randomBytes } from 'node:crypto';
import { ValidationDomainError } from '../../common/domain-error.js';
import { isExecutorSecret } from '../../../common/executors.js';

export { isExecutorSecret };

export function createExecutorSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function parseConnectionUrl(value: string): { socketUrl: string; secret: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationDomainError('Invalid executor connection URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new ValidationDomainError('Invalid executor connection URL');
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const secret = fragment.get('secret');
  if ([...fragment.keys()].length !== 1 || !isExecutorSecret(secret)) {
    throw new ValidationDomainError('Invalid executor connection credential');
  }
  url.hash = '';
  return { socketUrl: url.href, secret };
}

export function validateExecutorSocketUrl(value: string, options: {
  noTls: boolean;
  allowPlaceholder?: boolean;
}): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationDomainError('Invalid executor address'); }
  if (url.hash || url.username || url.password
    || !(url.protocol === 'wss:' || url.protocol === 'ws:' && options.noTls)) {
    throw new ValidationDomainError('Executor connections require TLS unless no-TLS mode is explicit');
  }
  if (!options.allowPlaceholder && (url.hostname === '0.0.0.0' || url.hostname === '[::]')) {
    throw new ValidationDomainError('Replace the unspecified address with a reachable hostname or IP');
  }
  return url.href;
}

export function executorConnectionUrl(socketUrl: string, secret: string): string {
  const url = new URL(socketUrl);
  url.hash = new URLSearchParams({ secret }).toString();
  return url.href;
}
