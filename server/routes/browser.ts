import type { RouteMap } from '../lib/http-route-types.js';
import {
  EMBED_CHECK_REQUEST_HEADER,
  MAX_EMBED_CHECK_URL_LENGTH,
  type EmbedCheckResponse,
  type EmbedVerdict,
} from '../../common/browser-embed.ts';

// Advisory, cookieless probe of framing headers for the Browser surface.
// Reports a verdict only and never echoes response bodies, so it exposes
// nothing beyond what the authenticated user's own shell access already can.
// Verdicts are hints: a cookieless fetch can differ from the user's
// credentialed view, so the client never gates navigation on them.

const MAX_REDIRECTS = 5;
// Per-hop budget; total time is bounded by (MAX_REDIRECTS + 1) hops.
const FETCH_TIMEOUT_MS = 5000;

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

// Mirrors how browsers actually decide framing, per CSP3: commas separate
// policies in a combined header, semicolons separate directives within one
// policy, only the first occurrence of a directive name in a policy counts,
// and every delivered policy is enforced (so the effective permission is their
// intersection). Report-only policies do not enforce and are ignored.
//
// Returns null when no policy declares frame-ancestors, which is what lets the
// caller fall back to X-Frame-Options.
function frameAncestorsVerdict(headers: Headers): EmbedVerdict | null {
  const csp = headers.get('content-security-policy');
  if (!csp) return null;
  let verdict: EmbedVerdict | null = null;
  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const trimmed = directive.trim();
      const separator = trimmed.search(/\s/);
      const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
      // Exact name only: `frame-ancestors-report` is an unrelated directive.
      if (name !== 'frame-ancestors') continue;
      const sources =
        separator === -1 ? [] : trimmed.slice(separator).trim().toLowerCase().split(/\s+/);
      if (sources.length === 0 || (sources.length === 1 && sources[0] === "'none'")) {
        verdict = 'blocked';
      } else if (sources.includes('*')) {
        // Sources within a directive are alternatives, so a wildcard permits
        // this deployment regardless of what else is listed.
        if (verdict === null) verdict = 'embeddable';
      } else {
        // A source list may or may not match this deployment's origin, which
        // the server cannot know behind proxies; treat as likely-blocked.
        if (verdict !== 'blocked') verdict = 'restricted';
      }
      // Later duplicates within the same policy are ignored by browsers.
      break;
    }
  }
  return verdict;
}

export function framingVerdict(headers: Headers): EmbedVerdict {
  // An enforced frame-ancestors supersedes X-Frame-Options entirely.
  const fromCsp = frameAncestorsVerdict(headers);
  if (fromCsp !== null) return fromCsp;
  const xfo = headers.get('x-frame-options');
  if (xfo) {
    const values = xfo.split(',').map((part) => part.trim().toLowerCase());
    if (values.includes('deny') || values.includes('sameorigin')) return 'blocked';
  }
  return 'embeddable';
}

function embedCheckResult(verdict: EmbedVerdict): Response {
  const body: EmbedCheckResponse = { verdict };
  return Response.json(body);
}

async function handleEmbedCheck(request: Request, url: URL): Promise<Response> {
  // Only same-origin script can set this header, which keeps framed content
  // from driving the server-side fetch when auth is disabled.
  if (!request.headers.get(EMBED_CHECK_REQUEST_HEADER)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const target = url.searchParams.get('url');
  if (!target || target.length > MAX_EMBED_CHECK_URL_LENGTH) {
    return Response.json({ error: 'Missing or invalid url' }, { status: 400 });
  }
  let current = parseHttpUrl(target);
  if (!current) {
    return Response.json({ error: 'Only http(s) URLs are supported' }, { status: 400 });
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return embedCheckResult('unreachable');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return embedCheckResult('unreachable');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return embedCheckResult('unreachable');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return embedCheckResult('unreachable');
      }
      current = next;
      continue;
    }
    const verdict = framingVerdict(response.headers);
    await response.body?.cancel();
    return embedCheckResult(verdict);
  }
  return embedCheckResult('unreachable');
}

export default function createBrowserRoutes(): RouteMap {
  return {
    '/api/v1/browser/embed-check': { GET: handleEmbedCheck },
  };
}
