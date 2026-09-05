import { describe, expect, it } from 'vitest';
import { parseChatReferenceHref, resolveChatReferenceTarget } from '../chat-reference.js';

const CHAT_ID = '1788592720180699';

describe('chat references', () => {
	it('accepts only the exact canonical chat route', () => {
		expect(parseChatReferenceHref(`/chat/${CHAT_ID}`)).toBe(CHAT_ID);
	});

	it.each([
		null,
		undefined,
		'',
		` /chat/${CHAT_ID}`,
		`/chat/${CHAT_ID}/`,
		`/chat/${CHAT_ID}?view=1`,
		`/chat/${CHAT_ID}#message`,
		`https://garcon.example/chat/${CHAT_ID}`,
		'/chat/%31%37%38%38%35%39%32%37%32%30%31%38%30%36%39%39',
		'/chat/178859272018069',
		'/chat/17885927201806999',
		`/chats/${CHAT_ID}`,
		'/chat/0000000000000000',
		'/chat/9999999999999999',
	])('rejects a noncanonical destination: %s', (href) => {
		expect(parseChatReferenceHref(href)).toBeNull();
	});

	it('resolves a known target and normalizes its title', () => {
		expect(resolveChatReferenceTarget(CHAT_ID, '1788592720180600', { title: '  Design  ' })).toEqual({
			title: 'Design',
			isCurrent: false,
		});
	});

	it.each([{ title: '' }, { title: '   ' }, { title: CHAT_ID }, {}])(
		'normalizes absent titles while retaining target existence',
		(target) => {
			expect(resolveChatReferenceTarget(CHAT_ID, null, target)).toEqual({
				title: null,
				isCurrent: false,
			});
		},
	);

	it('distinguishes an unavailable target from the current chat', () => {
		expect(resolveChatReferenceTarget(CHAT_ID, null, null)).toBeNull();
		expect(resolveChatReferenceTarget(CHAT_ID, CHAT_ID, { title: 'Current' })).toEqual({
			title: 'Current',
			isCurrent: true,
		});
	});
});
