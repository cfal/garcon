import { ValidationDomainError } from '../../common/domain-error.js';

export function parsePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationDomainError('Public URL must be an absolute HTTP(S) base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || ['0.0.0.0', '[::]', 'example.com'].includes(url.hostname) || /[\s\\]/u.test(value)
    || !/^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/iu.test(url.hostname)) {
    throw new ValidationDomainError('Public URL must have a reachable HTTP(S) host and no credentials, query, or fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url.href;
}

export function requestPublicUrl(request: Request, configured: string | null): string {
  if (configured !== null) return parsePublicUrl(configured);
  const incoming = new URL(request.url);
  const host = request.headers.get('host') ?? incoming.host;
  if (!host || /[\s\\/@?#]/u.test(host)) throw new ValidationDomainError('Invalid public Host; configure --public-url');
  // Forwarding headers cannot prove the proxy's public scheme or path.
  return parsePublicUrl(`${incoming.protocol}//${host}/`);
}

export function executorPublicUrl(base: string, id: string): string {
  const url = new URL(`executor/${encodeURIComponent(id)}`, parsePublicUrl(base));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
