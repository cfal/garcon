// Verifies that all typed context factory exports are properly defined.

import { describe, it, expect } from 'vitest';
import {
	getAuth, setAuth,
	getPreferences, setPreferences,
	getNavigation, setNavigation,
	getChatRuntime, setChatRuntime,
	getChatSessions, setChatSessions,
	getAppShell, setAppShell,
	getWs, setWs,
	getModelCatalog, setModelCatalog,
	getChatState, setChatState,
	getComposerState, setComposerState,
	getProviderState, setProviderState,
	getChatLifecycle, setChatLifecycle,
} from '../index';

describe('context factories', () => {
	it('exports getter/setter pairs for all root-level contexts', () => {
		expect(typeof getAuth).toBe('function');
		expect(typeof setAuth).toBe('function');
		expect(typeof getPreferences).toBe('function');
		expect(typeof setPreferences).toBe('function');
		expect(typeof getNavigation).toBe('function');
		expect(typeof setNavigation).toBe('function');
		expect(typeof getChatRuntime).toBe('function');
		expect(typeof setChatRuntime).toBe('function');
		expect(typeof getChatSessions).toBe('function');
		expect(typeof setChatSessions).toBe('function');
		expect(typeof getAppShell).toBe('function');
		expect(typeof setAppShell).toBe('function');
		expect(typeof getWs).toBe('function');
		expect(typeof setWs).toBe('function');
		expect(typeof getModelCatalog).toBe('function');
		expect(typeof setModelCatalog).toBe('function');
	});

	it('exports getter/setter pairs for all chat-level contexts', () => {
		expect(typeof getChatState).toBe('function');
		expect(typeof setChatState).toBe('function');
		expect(typeof getComposerState).toBe('function');
		expect(typeof setComposerState).toBe('function');
		expect(typeof getProviderState).toBe('function');
		expect(typeof setProviderState).toBe('function');
		expect(typeof getChatLifecycle).toBe('function');
		expect(typeof setChatLifecycle).toBe('function');
	});
});
