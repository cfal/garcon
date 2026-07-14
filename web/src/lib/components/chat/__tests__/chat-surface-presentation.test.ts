import { describe, expect, it } from 'vitest';
import { resolveChatSurfacePresentation } from '../chat-surface-presentation';

describe('resolveChatSurfacePresentation', () => {
	it('keeps a pending draft renderable so startup errors and retry input stay visible', () => {
		expect(
			resolveChatSurfacePresentation(
				{
					status: 'draft',
					projectIdentityState: 'pending',
					effectiveProjectKey: null,
				},
				false,
			),
		).toBe('conversation');
	});

	it('loads unresolved running chats until their project identity is available', () => {
		expect(
			resolveChatSurfacePresentation(
				{
					status: 'running',
					projectIdentityState: 'pending',
					effectiveProjectKey: null,
				},
				false,
			),
		).toBe('loading');
	});

	it('distinguishes an empty chat list from one that is still loading', () => {
		expect(resolveChatSurfacePresentation(null, false)).toBe('empty');
		expect(resolveChatSurfacePresentation(null, true)).toBe('loading');
	});
});
