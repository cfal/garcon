import { describe, expect, it } from 'vitest';
import { SnippetFormState } from '../snippet-form-state.svelte';
import type { Snippet } from '$shared/snippets';

function snippet(id: string, shortName: string): Snippet {
	return {
		id,
		shortName,
		template: `Template ${id}`,
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

		expect(form.buildDefinition()).toEqual({
			shortName: 'review_api-2',
			template: '\nReview {{arguments}}\n',
		});
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
