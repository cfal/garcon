import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ConversationWorkspaceStub from './ConversationWorkspaceStub.svelte';

vi.mock('$lib/components/chat/ConversationWorkspace.svelte', () => ({
	default: ConversationWorkspaceStub
}));

import WorkspaceViewTestHarness from './WorkspaceViewTestHarness.svelte';

describe('WorkspaceView header visibility', () => {
	it('hides the top header on desktop when Show header is disabled on the chat tab', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: false,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeTruthy();
		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('keeps the top header visible on desktop when Show header is disabled on non-chat tabs', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'preview',
			showChatHeader: false,
			isMobile: false
		});

		expect(screen.getByRole('heading', { name: 'Header Test Chat' })).toBeTruthy();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
	});

	it('hides the top header on mobile chat tab when Show header is disabled', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: false,
			isMobile: true
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(screen.queryByLabelText('Open menu')).toBeNull();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
		expect(screen.queryByTitle('Fullscreen')).toBeNull();
	});

	it('shows the top header when Show header is enabled', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.getByRole('heading', { name: 'Header Test Chat' })).toBeTruthy();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('shows exit fullscreen title when desktop fullscreen is active', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			isDesktopFullscreen: true
		});

		expect(screen.getByTitle('Exit fullscreen')).toBeTruthy();
	});

	it('hides fullscreen control on git tab when always-fullscreen-on-git is enabled', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'git',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.queryByTitle('Fullscreen')).toBeNull();
	});

	it('shows fullscreen control on git tab when always-fullscreen-on-git is disabled', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'git',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: false,
			isMobile: false
		});

		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('uses semantic token classes for header and active tabs', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			isMobile: false
		});

		expect(container.querySelector('.bg-chat-header')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-rail')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-active')).toBeTruthy();
	});
});
