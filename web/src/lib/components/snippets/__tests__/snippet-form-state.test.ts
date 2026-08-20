import { describe, expect, it } from 'vitest';
import { SnippetFormState } from '../snippet-form-state.svelte';
import type { Snippet } from '$shared/snippets';

function snippet(id: string, shortName: string): Snippet {
	return {
		id,
		shortName,
		template: `Template ${id}`,
		defaultArguments: '',
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

describe('SnippetFormState', () => {
	it('rejects invalid short names without normalizing the entered value', () => {
		const form = new SnippetFormState(() => []);
		form.shortName = ' Review';
		form.template = 'Review this';

		expect(form.shortNameError).toBeTruthy();
		expect(form.shortName).toBe(' Review');
		expect(form.buildDefinition()).toBeNull();
	});

	it('preserves multiline template whitespace in the saved definition', () => {
		const form = new SnippetFormState(() => []);
		form.shortName = 'review_api-2';
		form.template = '\nReview {{arguments}}\n';
		form.defaultArguments = '\n staged changes \n';

		expect(form.buildDefinition()).toEqual({
			shortName: 'review_api-2',
			template: '\nReview {{arguments}}\n',
			defaultArguments: '\n staged changes \n',
		});
	});

	it('resets new and edited forms with the correct default', () => {
		const saved = {
			...snippet('one', 'review'),
			template: 'Review {{arguments}}',
			defaultArguments: 'staged changes',
		};
		const form = new SnippetFormState(() => [saved]);
		form.reset(saved);
		expect(form.defaultArguments).toBe('staged changes');

		form.saving = true;
		form.error = 'failed';
		form.reset(null);
		expect(form.defaultArguments).toBe('');
		expect(form.saving).toBe(false);
		expect(form.error).toBeNull();
	});

	it('allows empty defaults without a token and bounded defaults with an active token', () => {
		const form = new SnippetFormState(() => []);
		form.shortName = 'review';
		form.template = 'Review';
		expect(form.defaultArgumentsError).toBeNull();
		expect(form.canSave).toBe(true);

		form.template = 'Review {{arguments}}';
		form.defaultArguments = ' '.repeat(32_000);
		expect(form.defaultArgumentsError).toBeNull();
		expect(form.buildDefinition()?.defaultArguments).toHaveLength(32_000);
	});

	it('preserves an invalid default while the token is absent and recovers when restored', () => {
		const form = new SnippetFormState(() => []);
		form.shortName = 'review';
		form.template = 'Review {{arguments}}';
		form.defaultArguments = 'staged changes';

		for (const template of ['Review', 'Review \\{{arguments}}', 'Review {{ arguments }}']) {
			form.template = template;
			expect(form.defaultArgumentsError).toContain('Add {{arguments}}');
			expect(form.defaultArguments).toBe('staged changes');
			expect(form.canSave).toBe(false);
			expect(form.buildDefinition()).toBeNull();
		}

		form.template = 'Review {{arguments}}';
		expect(form.defaultArgumentsError).toBeNull();
		expect(form.canSave).toBe(true);
	});

	it('reports the length limit before the token requirement', () => {
		const form = new SnippetFormState(() => []);
		form.shortName = 'review';
		form.template = 'Review';
		form.defaultArguments = 'x'.repeat(32_001);

		expect(form.defaultArgumentsError).toBe('Default arguments cannot exceed 32,000 characters.');
		expect(form.canSave).toBe(false);
	});

	it('prevents duplicate names while allowing the current snippet name', () => {
		const snippets = [snippet('one', 'review'), snippet('two', 'summarize')];
		const form = new SnippetFormState(() => snippets);
		form.reset(snippets[0]);
		expect(form.shortNameError).toBeNull();

		form.shortName = 'summarize';
		expect(form.shortNameError).toBeTruthy();
		expect(form.buildDefinition()).toBeNull();
	});
});
