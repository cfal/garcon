import { BroadcastChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserNotificationCoordinator } from '../browser-notification-coordinator.js';

afterEach(() => vi.unstubAllGlobals());

describe('cross-tab browser notifications', () => {
	it('suppresses delivery from an unfocused tab when another Garcon tab has focus', async () => {
		vi.stubGlobal('BroadcastChannel', BroadcastChannel);
		vi.stubGlobal('navigator', {});
		const focused = new BrowserNotificationCoordinator({
			isFocused: () => true,
			eligible: () => true,
		});
		const background = new BrowserNotificationCoordinator({
			isFocused: () => false,
			eligible: () => true,
		});
		const deliver = vi.fn(async () => {});
		try {
			await background.run('focused-event', deliver);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			focused.destroy();
			background.destroy();
		}
	});
	it('elects one unfocused tab and remembers its receipt without randomUUID', async () => {
		vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
		vi.stubGlobal('BroadcastChannel', BroadcastChannel);
		vi.stubGlobal('navigator', {});
		const first = new BrowserNotificationCoordinator({
			isFocused: () => false,
			eligible: () => true,
		});
		const second = new BrowserNotificationCoordinator({
			isFocused: () => false,
			eligible: () => true,
		});
		const deliver = vi.fn(async () => {});
		try {
			await Promise.all([first.run('shared-event', deliver), second.run('shared-event', deliver)]);
			expect(deliver).toHaveBeenCalledOnce();
			await Promise.all([first.run('shared-event', deliver), second.run('shared-event', deliver)]);
			expect(deliver).toHaveBeenCalledOnce();
		} finally {
			first.destroy();
			second.destroy();
		}
	});
	it('does not elect a peer that has notifications disabled', async () => {
		vi.stubGlobal('BroadcastChannel', BroadcastChannel);
		vi.stubGlobal('navigator', {});
		const disabled = new BrowserNotificationCoordinator({
			isFocused: () => false,
			eligible: () => false,
		});
		const enabled = new BrowserNotificationCoordinator({
			isFocused: () => false,
			eligible: () => true,
		});
		const deliver = vi.fn(async () => {});
		try {
			await enabled.run('enabled-event', deliver);
			expect(deliver).toHaveBeenCalledOnce();
		} finally {
			disabled.destroy();
			enabled.destroy();
		}
	});
});
