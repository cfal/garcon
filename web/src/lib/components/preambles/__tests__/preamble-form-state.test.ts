import { describe, expect, it } from 'vitest';
import { PREAMBLE_FILE_CONTEXT_SEPARATOR } from '$shared/preambles';
import { PreambleFormState } from '../preamble-form-state.svelte';

describe('PreambleFormState', () => {
	it('builds global definitions without hidden path drafts', () => {
		const form = new PreambleFormState();
		form.title = '  Repository conventions  ';
		form.content = 'Keep exact whitespace.\n';
		form.scopeType = 'project-paths';
		form.addPath('/workspace/project');
		form.scopeType = 'global';

		expect(form.buildDefinition()).toEqual({
			enabled: true,
			title: 'Repository conventions',
			content: 'Keep exact whitespace.\n',
			scope: { type: 'global' },
		});
	});

	it('defaults new preambles to enabled and preserves an edited disabled value', () => {
		const form = new PreambleFormState();
		form.reset(null);
		expect(form.enabled).toBe(true);

		form.reset({
			id: 'disabled',
			enabled: false,
			title: 'Disabled preamble',
			content: 'Disabled content',
			scope: { type: 'global' },
			createdAt: '2029-01-01T00:00:00.000Z',
			updatedAt: '2029-01-01T00:00:00.000Z',
		});
		expect(form.enabled).toBe(false);
	});

	it('preserves independent nested choices across multiple path rules', () => {
		const form = new PreambleFormState();
		form.title = 'Scoped instructions';
		form.content = 'Use scoped instructions.';
		form.scopeType = 'project-paths';
		const first = form.addPath('/workspace/first');
		const second = form.addPath('/workspace/second');
		const firstRule = form.pathRules.find((rule) => rule.key === first);
		const secondRule = form.pathRules.find((rule) => rule.key === second);
		if (!firstRule || !secondRule) throw new Error('Expected path rules');
		firstRule.includeNested = true;
		secondRule.includeNested = false;

		expect(form.buildDefinition()?.scope).toEqual({
			type: 'project-paths',
			rules: [
				{ projectPath: '/workspace/first', includeNested: true },
				{ projectPath: '/workspace/second', includeNested: false },
			],
		});
	});

	it('rejects duplicate normalized paths and reserved file-context text', () => {
		const form = new PreambleFormState();
		form.title = 'Scoped instructions';
		form.content = `Before${PREAMBLE_FILE_CONTEXT_SEPARATOR}after`;
		form.scopeType = 'project-paths';
		form.addPath('/workspace/project/');
		form.addPath('/workspace/project');

		expect(form.contentError).toContain('reserved');
		expect(form.scopeError).toContain('unique');
		expect(form.canSave).toBe(false);
	});
});
