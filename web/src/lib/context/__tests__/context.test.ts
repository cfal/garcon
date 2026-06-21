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
	getChatState,
	setChatState,
	getComposerState,
	setComposerState,
	getAgentState,
	setAgentState,
	getChatLifecycle,
	setChatLifecycle,
	getNotifications,
	setNotifications,
	getSidebarSearch,
	setSidebarSearch,
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
	});

	it('exports getter/setter pairs for all chat-level contexts', () => {
		expect(typeof getChatState).toBe('function');
		expect(typeof setChatState).toBe('function');
		expect(typeof getComposerState).toBe('function');
		expect(typeof setComposerState).toBe('function');
		expect(typeof getAgentState).toBe('function');
		expect(typeof setAgentState).toBe('function');
		expect(typeof getChatLifecycle).toBe('function');
		expect(typeof setChatLifecycle).toBe('function');
	});
});
