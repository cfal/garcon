// Verifies that all typed context factory exports are properly defined.

import { describe, it, expect } from 'vitest';
import {
	getAuth,
	setAuth,
	getLocalSettings,
	setLocalSettings,
	getRemoteSettings,
	setRemoteSettings,
	getNavigation,
	setNavigation,
	getChatSessions,
	setChatSessions,
	getAppShell,
	setAppShell,
	getWs,
	setWs,
	getModelCatalog,
	setModelCatalog,
	getActiveTranscriptState,
	setActiveTranscriptState,
	getComposerState,
	setComposerState,
	getAgentState,
	setAgentState,
	getConversationLifecycle,
	setConversationLifecycle,
	getNotifications,
	setNotifications,
	getSidebarSearch,
	setSidebarSearch,
	getSidebarProjectCollapse,
	setSidebarProjectCollapse,
	getAppTitle,
	setAppTitle,
	getGhCapability,
	setGhCapability,
} from '../index';

describe('context factories', () => {
	it('exports getter/setter pairs for all root-level contexts', () => {
		expect(typeof getAuth).toBe('function');
		expect(typeof setAuth).toBe('function');
		expect(typeof getLocalSettings).toBe('function');
		expect(typeof setLocalSettings).toBe('function');
		expect(typeof getRemoteSettings).toBe('function');
		expect(typeof setRemoteSettings).toBe('function');
		expect(typeof getNavigation).toBe('function');
		expect(typeof setNavigation).toBe('function');
		expect(typeof getChatSessions).toBe('function');
		expect(typeof setChatSessions).toBe('function');
		expect(typeof getAppShell).toBe('function');
		expect(typeof setAppShell).toBe('function');
		expect(typeof getWs).toBe('function');
		expect(typeof setWs).toBe('function');
		expect(typeof getModelCatalog).toBe('function');
		expect(typeof setModelCatalog).toBe('function');
		expect(typeof getNotifications).toBe('function');
		expect(typeof setNotifications).toBe('function');
		expect(typeof getSidebarSearch).toBe('function');
		expect(typeof setSidebarSearch).toBe('function');
		expect(typeof getSidebarProjectCollapse).toBe('function');
		expect(typeof setSidebarProjectCollapse).toBe('function');
			expect(typeof getAppTitle).toBe('function');
			expect(typeof setAppTitle).toBe('function');
			expect(typeof getGhCapability).toBe('function');
			expect(typeof setGhCapability).toBe('function');
		});

	it('exports getter/setter pairs for all chat-level contexts', () => {
		expect(typeof getActiveTranscriptState).toBe('function');
		expect(typeof setActiveTranscriptState).toBe('function');
		expect(typeof getComposerState).toBe('function');
		expect(typeof setComposerState).toBe('function');
		expect(typeof getAgentState).toBe('function');
		expect(typeof setAgentState).toBe('function');
		expect(typeof getConversationLifecycle).toBe('function');
		expect(typeof setConversationLifecycle).toBe('function');
	});
});
