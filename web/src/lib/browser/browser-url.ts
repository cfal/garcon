// Normalizes and validates address-bar input for the Browser surface.
// Only http(s) targets are accepted, and the app's own origin is refused so
// framed content can never run same-origin with Garcon (see
// BROWSER_SURFACE_DESIGN.md and docs/security.md).

export type BrowserUrlRejection =
	| 'empty'
	| 'unparseable'
	| 'scheme'
	| 'userinfo'
	| 'same-origin';

export type BrowserUrlResult =
	| { ok: true; url: string }
	| { ok: false; reason: BrowserUrlRejection };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host) || host === '[::1]' || host.endsWith('.localhost');
}

// Naive loopback heuristic for scheme defaulting only (127.0.0.0/8 beyond
// 127.0.0.1 defaults to https); explicit schemes always win.
function defaultScheme(input: string): 'http://' | 'https://' {
	if (input.startsWith('[')) return input.startsWith('[::1]') ? 'http://' : 'https://';
	const host = input.split(/[/:?#]/, 1)[0]?.toLowerCase() ?? '';
	return isLoopbackHost(host) ? 'http://' : 'https://';
}

// Address-bar disambiguation: "localhost:5173" is a valid scheme token to the
// URL parser, so a colon followed by port-like digits is read as host:port
// rather than a scheme.
function hasExplicitScheme(input: string): boolean {
	const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:(.*)$/.exec(input);
	if (!match) return false;
	return !/^\d+([/?#]|$)/.test(match[1] ?? '');
}

export function normalizeBrowserUrl(input: string, appOrigin: string): BrowserUrlResult {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, reason: 'empty' };
	const candidate = hasExplicitScheme(trimmed)
		? trimmed
		: `${defaultScheme(trimmed)}${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false, reason: 'unparseable' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: 'scheme' };
	}
	if (url.username || url.password) return { ok: false, reason: 'userinfo' };
	if (url.origin === appOrigin) return { ok: false, reason: 'same-origin' };
	return { ok: true, url: url.href };
}

// Deterministic client-side check: an https-served app cannot frame plain-http
// non-loopback content (blockable mixed content).
export function isMixedContentBlocked(url: string, appOrigin: string): boolean {
	if (!appOrigin.startsWith('https:')) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:') return false;
	const host = parsed.hostname === '::1' ? '[::1]' : parsed.hostname.toLowerCase();
	return !isLoopbackHost(host);
}
