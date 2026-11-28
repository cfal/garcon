import { executorPublicUrl, parsePublicUrl, requestPublicUrl } from '../../../server/controller/executors/public-url.ts';

export { executorPublicUrl, parsePublicUrl };

export function requestPublicUrlFixture(url: string, host: string | null, configured: string | null, basePath = '') {
  const headers = host === null ? {} : { host };
  return requestPublicUrl(new Request(url, { headers }), configured, basePath);
}
