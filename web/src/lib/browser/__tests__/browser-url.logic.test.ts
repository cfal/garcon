import { describe, expect, it } from 'vitest';
import { isMixedContentBlocked, normalizeBrowserUrl } from '../browser-url';

const APP_ORIGIN = 'https://garcon.example.com';

describe('normalizeBrowserUrl', () => {
	it('defaults bare domains to https', () => {
		expect(normalizeBrowserUrl('docs.example.com/guide', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'https://docs.example.com/guide',
		});
	});

	it('defaults loopback hosts to http', () => {
		expect(normalizeBrowserUrl('localhost:5173', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://localhost:5173/',
		});
		expect(normalizeBrowserUrl('127.0.0.1:8080/app', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://127.0.0.1:8080/app',
		});
		expect(normalizeBrowserUrl('[::1]:3000', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://[::1]:3000/',
		});
		expect(normalizeBrowserUrl('app.localhost', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://app.localhost/',
		});
	});

	it('preserves explicit schemes', () => {
		expect(normalizeBrowserUrl('http://example.com', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://example.com/',
		});
		expect(normalizeBrowserUrl('https://localhost:5173', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'https://localhost:5173/',
		});
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeBrowserUrl('  https://example.com  ', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'https://example.com/',
		});
	});

	it('rejects empty input', () => {
		expect(normalizeBrowserUrl('', APP_ORIGIN)).toEqual({ ok: false, reason: 'empty' });
		expect(normalizeBrowserUrl('   ', APP_ORIGIN)).toEqual({ ok: false, reason: 'empty' });
	});

	it('rejects non-http schemes', () => {
		for (const input of [
			'javascript:alert(1)',
			'data:text/html,<script>1</script>',
			'file:///etc/passwd',
			'about:blank',
			'blob:https://example.com/x',
			'vbscript:x',
		]) {
			expect(normalizeBrowserUrl(input, APP_ORIGIN)).toEqual({ ok: false, reason: 'scheme' });
		}
	});

	it('rejects unparseable input', () => {
		expect(normalizeBrowserUrl('http://', APP_ORIGIN)).toEqual({
			ok: false,
			reason: 'unparseable',
		});
	});

	it('rejects URLs with userinfo', () => {
		expect(normalizeBrowserUrl('https://user:pw@example.com', APP_ORIGIN)).toEqual({
			ok: false,
			reason: 'userinfo',
		});
		expect(normalizeBrowserUrl('https://user@example.com', APP_ORIGIN)).toEqual({
			ok: false,
			reason: 'userinfo',
		});
	});

	it('rejects the app origin but accepts other origins on the same host', () => {
		expect(normalizeBrowserUrl('https://garcon.example.com/chat', APP_ORIGIN)).toEqual({
			ok: false,
			reason: 'same-origin',
		});
		expect(normalizeBrowserUrl('https://garcon.example.com:8443/', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'https://garcon.example.com:8443/',
		});
		expect(normalizeBrowserUrl('http://garcon.example.com/', APP_ORIGIN)).toEqual({
			ok: true,
			url: 'http://garcon.example.com/',
		});
	});
});

describe('isMixedContentBlocked', () => {
	it('flags plain-http public hosts under an https app', () => {
		expect(isMixedContentBlocked('http://example.com/', APP_ORIGIN)).toBe(true);
		expect(isMixedContentBlocked('http://192.168.1.10:3000/', APP_ORIGIN)).toBe(true);
	});

	it('allows loopback hosts under an https app', () => {
		expect(isMixedContentBlocked('http://localhost:5173/', APP_ORIGIN)).toBe(false);
		expect(isMixedContentBlocked('http://127.0.0.1/', APP_ORIGIN)).toBe(false);
		expect(isMixedContentBlocked('http://[::1]:3000/', APP_ORIGIN)).toBe(false);
		expect(isMixedContentBlocked('http://dev.localhost/', APP_ORIGIN)).toBe(false);
	});

	it('never flags https targets or http-served apps', () => {
		expect(isMixedContentBlocked('https://example.com/', APP_ORIGIN)).toBe(false);
		expect(isMixedContentBlocked('http://example.com/', 'http://garcon.local:3000')).toBe(false);
	});
});
