// Shared contract for the advisory Browser-surface embed check. The server
// probes framing headers cookielessly, so verdicts are hints: a blocked
// verdict shows a banner, but the client never gates navigation on it.
//
// The response carries the verdict alone. Upstream status codes and
// redirect-resolved URLs are deliberately not echoed back.

export type EmbedVerdict = 'embeddable' | 'blocked' | 'restricted' | 'unreachable';

export interface EmbedCheckResponse {
  verdict: EmbedVerdict;
}

// Longest URL the probe accepts. Shared so the client can skip probing URLs
// the server would reject rather than issuing a request that always 400s.
export const MAX_EMBED_CHECK_URL_LENGTH = 4096;

// The probe makes the server fetch a caller-supplied URL, so it requires a
// header that only same-origin script can set. Document navigations cannot set
// headers at all, and a cross-origin fetch carrying a custom header needs a
// CORS preflight that this server never approves. Unlike Sec-Fetch-* this does
// not depend on the deployment being a trustworthy origin, so it also holds
// for plain-HTTP LAN deployments.
export const EMBED_CHECK_REQUEST_HEADER = 'X-Garcon-Embed-Check';

export function isEmbedVerdict(value: unknown): value is EmbedVerdict {
  return (
    value === 'embeddable' ||
    value === 'blocked' ||
    value === 'restricted' ||
    value === 'unreachable'
  );
}
