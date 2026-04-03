import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ShellMobileControlsState } from '../shell-mobile-controls.svelte';

describe('ShellMobileControlsState', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-04T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('buffers ctrl for the next character input', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');

		expect(controls.ctrlMode).toBe('pending');
		expect(controls.transformTerminalInput('a')).toBe('\x01');
		expect(controls.ctrlMode).toBe('inactive');
	});

	it('locks ctrl on a quick double tap and keeps applying it', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');
		vi.advanceTimersByTime(200);
		controls.toggleModifier('ctrl');

		expect(controls.ctrlMode).toBe('locked');
		expect(controls.transformTerminalInput('c')).toBe('\x03');
		expect(controls.ctrlMode).toBe('locked');
		expect(controls.transformTerminalInput('c')).toBe('\x03');

		controls.toggleModifier('ctrl');
		expect(controls.ctrlMode).toBe('inactive');
	});

	it('cancels a buffered modifier when tapped again after the lock window', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('alt');
		vi.advanceTimersByTime(500);
		controls.toggleModifier('alt');

		expect(controls.altMode).toBe('inactive');
	});

	it('prefixes alt for the next character input', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('alt');

		expect(controls.transformTerminalInput('f')).toBe('\x1bf');
		expect(controls.altMode).toBe('inactive');
	});

	it('combines ctrl and alt for a single printable key', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');
		controls.toggleModifier('alt');

		expect(controls.transformTerminalInput('d')).toBe('\x1b\x04');
		expect(controls.ctrlMode).toBe('inactive');
		expect(controls.altMode).toBe('inactive');
	});

	it('leaves pending modifiers armed when input cannot be transformed', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');

		expect(controls.transformTerminalInput('ll')).toBe('ll');
		expect(controls.ctrlMode).toBe('pending');
	});

	it('consumes buffered modifiers when a toolbar key is sent', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');

		expect(controls.buildToolbarSequence('up')).toBe('\x1b[1;5A');
		expect(controls.ctrlMode).toBe('inactive');
	});

	it('encodes alt-modified cursor keys using xterm modifier parameters', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('alt');

		expect(controls.buildToolbarSequence('left')).toBe('\x1b[1;3D');
		expect(controls.altMode).toBe('inactive');
	});

	it('encodes ctrl+alt-modified cursor keys using xterm modifier parameters', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');
		controls.toggleModifier('alt');

		expect(controls.buildToolbarSequence('right')).toBe('\x1b[1;7C');
		expect(controls.ctrlMode).toBe('inactive');
		expect(controls.altMode).toBe('inactive');
	});

	it('encodes ctrl-modified tab using xterm modifyOtherKeys sequences', () => {
		const controls = new ShellMobileControlsState();

		controls.toggleModifier('ctrl');

		expect(controls.buildToolbarSequence('tab')).toBe('\x1b[27;5;9~');
		expect(controls.ctrlMode).toBe('inactive');
	});
});
