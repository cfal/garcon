import { describe, it, expect, afterAll } from 'bun:test';
import createBrowserRoutes, { framingVerdict } from '../browser.js';
import { isNoAuthHandler } from '../../lib/http-route.js';
import { EMBED_CHECK_REQUEST_HEADER } from '../../../common/browser-embed.ts';

const routes = createBrowserRoutes();
const handler = routes['/api/v1/browser/embed-check'].GET;

const fixture = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/open') return new Response('ok');
    if (path === '/deny') {
      return new Response('ok', { headers: { 'X-Frame-Options': 'DENY' } });
    }
    if (path === '/sameorigin') {
      return new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } });
    }
    if (path === '/fa-none') {
      return new Response('ok', {
        headers: {
          'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (path === '/fa-list') {
      return new Response('ok', {
        headers: { 'Content-Security-Policy': 'frame-ancestors https://allowed.example' },
      });
    }
    if (path === '/fa-star') {
      return new Response('ok', {
        headers: { 'Content-Security-Policy': 'frame-ancestors *' },
      });
    }
    if (path === '/fa-conflict') {
      const headers = new Headers();
      headers.append('Content-Security-Policy', 'frame-ancestors *');
      headers.append('Content-Security-Policy', "frame-ancestors 'none'");
      return new Response('ok', { headers });
    }
    if (path === '/report-only') {
      return new Response('ok', {
        headers: {
          'Content-Security-Policy-Report-Only': "frame-ancestors 'none'",
        },
      });
    }
    if (path === '/redirect') {
      return new Response(null, { status: 302, headers: { Location: '/deny' } });
    }
    if (path === '/loop') {
      return new Response(null, { status: 302, headers: { Location: '/loop' } });
    }
    if (path === '/bad-redirect') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'javascript:alert(1)' },
      });
    }
    return new Response('missing', { status: 404 });
  },
});

const fixtureOrigin = `http://127.0.0.1:${fixture.port}`;

afterAll(() => {
  fixture.stop(true);
});

async function check(target) {
  const url = new URL(
    `http://localhost/api/v1/browser/embed-check?url=${encodeURIComponent(target)}`,
  );
  const response = await handler(
    new Request(url, { headers: { [EMBED_CHECK_REQUEST_HEADER]: '1' } }),
    url,
  );
  return { status: response.status, body: await response.json() };
}

describe('embed-check route', () => {
  it('requires authentication like every API route', () => {
    expect(isNoAuthHandler(handler)).toBe(false);
  });

  it('reports embeddable for pages without framing headers and echoes nothing else', async () => {
    const { status, body } = await check(`${fixtureOrigin}/open`);
    expect(status).toBe(200);
    expect(body).toEqual({ verdict: 'embeddable' });
  });

  it('reports blocked for X-Frame-Options deny and sameorigin', async () => {
    expect((await check(`${fixtureOrigin}/deny`)).body.verdict).toBe('blocked');
    expect((await check(`${fixtureOrigin}/sameorigin`)).body.verdict).toBe('blocked');
  });

  it('reads frame-ancestors directives', async () => {
    expect((await check(`${fixtureOrigin}/fa-none`)).body.verdict).toBe('blocked');
    expect((await check(`${fixtureOrigin}/fa-list`)).body.verdict).toBe('restricted');
    expect((await check(`${fixtureOrigin}/fa-star`)).body.verdict).toBe('embeddable');
  });

  it('takes the most restrictive policy when a permissive one comes first', async () => {
    expect((await check(`${fixtureOrigin}/fa-conflict`)).body.verdict).toBe('blocked');
  });

  it('ignores report-only policies because they do not enforce', async () => {
    expect((await check(`${fixtureOrigin}/report-only`)).body.verdict).toBe('embeddable');
  });

  it('follows redirects and reports the final hop verdict', async () => {
    const { body } = await check(`${fixtureOrigin}/redirect`);
    expect(body).toEqual({ verdict: 'blocked' });
  });

  it('gives up on redirect loops and non-http redirect targets', async () => {
    expect((await check(`${fixtureOrigin}/loop`)).body.verdict).toBe('unreachable');
    expect((await check(`${fixtureOrigin}/bad-redirect`)).body.verdict).toBe('unreachable');
  });

  it('reports unreachable hosts without failing the request', async () => {
    const { status, body } = await check('http://127.0.0.1:1/nothing');
    expect(status).toBe(200);
    expect(body.verdict).toBe('unreachable');
  });

  it('rejects missing and non-http URLs', async () => {
    const missing = new URL('http://localhost/api/v1/browser/embed-check');
    expect(
      (
        await handler(
          new Request(missing, { headers: { [EMBED_CHECK_REQUEST_HEADER]: '1' } }),
          missing,
        )
      ).status,
    ).toBe(400);
    expect((await check('ftp://example.com/file')).status).toBe(400);
    expect((await check('javascript:alert(1)')).status).toBe(400);
  });

  // A navigation cannot set request headers at all, and a cross-origin fetch
  // carrying one needs a preflight this server never approves. That holds even
  // on plain-HTTP deployments, where browsers omit Sec-Fetch-* entirely.
  it('refuses requests without the same-origin probe header, without probing upstream', async () => {
    let upstreamHits = 0;
    const counted = Bun.serve({
      port: 0,
      fetch() {
        upstreamHits += 1;
        return new Response('ok');
      },
    });
    try {
      const url = new URL(
        `http://localhost/api/v1/browser/embed-check?url=${encodeURIComponent(
          `http://127.0.0.1:${counted.port}/`,
        )}`,
      );
      const bare = await handler(new Request(url), url);
      const navigationShaped = await handler(
        new Request(url, {
          headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' },
        }),
        url,
      );
      const withHeader = await handler(
        new Request(url, { headers: { [EMBED_CHECK_REQUEST_HEADER]: '1' } }),
        url,
      );

      expect(bare.status).toBe(403);
      expect(navigationShaped.status).toBe(403);
      expect(withHeader.status).toBe(200);
      expect(upstreamHits).toBe(1);
    } finally {
      counted.stop(true);
    }
  });
});

describe('framingVerdict', () => {
  it('treats comma-joined X-Frame-Options values as blocking', () => {
    expect(framingVerdict(new Headers({ 'X-Frame-Options': 'SAMEORIGIN, DENY' }))).toBe('blocked');
  });

  it('finds frame-ancestors across comma-joined policies', () => {
    expect(
      framingVerdict(
        new Headers({
          'Content-Security-Policy': "default-src 'self', frame-ancestors 'none'",
        }),
      ),
    ).toBe('blocked');
  });

  // Browsers ignore X-Frame-Options entirely when an enforced policy declares
  // frame-ancestors, so an advisory banner must not fire on the stale header.
  it('lets an enforced frame-ancestors supersede X-Frame-Options', () => {
    expect(
      framingVerdict(
        new Headers({
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': 'frame-ancestors *',
        }),
      ),
    ).toBe('embeddable');
  });

  it('keeps only the first frame-ancestors directive within one policy', () => {
    expect(
      framingVerdict(
        new Headers({
          'Content-Security-Policy': "frame-ancestors *; frame-ancestors 'none'",
        }),
      ),
    ).toBe('embeddable');
  });

  // Sources in one directive are alternatives, so a wildcard permits framing
  // no matter what else the list names.
  it('treats a wildcard among other sources as permitting framing', () => {
    expect(
      framingVerdict(
        new Headers({ 'Content-Security-Policy': 'frame-ancestors * https://allowed.example' }),
      ),
    ).toBe('embeddable');
  });

  it('ignores directive names that merely start with frame-ancestors', () => {
    expect(
      framingVerdict(
        new Headers({ 'Content-Security-Policy': 'frame-ancestors-report https://x.example' }),
      ),
    ).toBe('embeddable');
  });

  it('still intersects frame-ancestors across separate policies', () => {
    const headers = new Headers();
    headers.append('Content-Security-Policy', 'frame-ancestors *');
    headers.append('Content-Security-Policy', "frame-ancestors 'none'");
    expect(framingVerdict(headers)).toBe('blocked');
  });
});
