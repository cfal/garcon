import { describe, expect, it } from 'vitest';
import { fitComposerToolbar, type ComposerToolbarControls } from '../composer-toolbar-layout';

const chat = {
	prompt: ['image', 'snippet', 'expand', 'refine'],
	settings: ['executor', 'model', 'effort', 'agent:speed', 'permission'],
	send: true, bypass: false, refining: false,
} satisfies ComposerToolbarControls;

describe('composer toolbar fit', () => {
	it('promotes both groups without empty menus and bounds long labels', () => {
		const fit = fitComposerToolbar(chat, 80);
		expect([...fit.inline]).toEqual([...chat.prompt, ...chat.settings]);
		expect(fit).toMatchObject({ promptMenu: false, settingsMenu: false, fullExecutor: true, modelWidthRem: 15 });
	});

	it('compacts the executor, then folds it before sacrificing a readable model', () => {
		const medium = fitComposerToolbar(chat, 25);
		expect(medium.inline.has('executor')).toBe(true);
		expect(medium.fullExecutor).toBe(false);
		const narrow = fitComposerToolbar(chat, 15);
		expect([...narrow.inline]).toEqual(['model']);
		expect(narrow.modelWidthRem).toBeGreaterThanOrEqual(7);
		expect(narrow).toMatchObject({ promptMenu: true, settingsMenu: true });
		expect(fitComposerToolbar(chat, 12).inline.size).toBe(0);
	});

	it('preserves cancellation and a configurable bypass ahead of ordinary controls', () => {
		const fit = fitComposerToolbar({ ...chat, refining: true, bypass: true }, 15);
		expect(fit.inline.has('refine')).toBe(true);
		expect(fit.inline.has('permission')).toBe(true);
		expect(fit.inline.has('agent:speed')).toBe(false);
	});

	it('only budgets applicable actions, including the no-send scheduling form', () => {
		const fit = fitComposerToolbar({ ...chat, prompt: [], settings: ['model'], send: false }, 7);
		expect([...fit.inline]).toEqual(['model']);
		expect(fit).toMatchObject({ promptMenu: false, settingsMenu: false, fullExecutor: false });
	});

	it('does not strand a single fixed-size command behind an equally wide menu trigger', () => {
		const fit = fitComposerToolbar({ ...chat, settings: ['permission'] }, 10);
		expect(fit.inline.has('permission')).toBe(true);
		expect(fit.settingsMenu).toBe(false);
		expect(fit.promptMenu).toBe(true);
	});
});
