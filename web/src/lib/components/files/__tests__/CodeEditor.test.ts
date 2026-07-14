import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import CodeEditorFocusTestHost from './CodeEditorFocusTestHost.svelte';

describe('CodeEditor', () => {
	it('delegates primary focus to the editor controller', async () => {
		const onFocus = vi.fn();
		const { rerender } = render(CodeEditorFocusTestHost, {
			focusRequestToken: 0,
			onFocus,
		});

		await rerender({ focusRequestToken: 1, onFocus });

		expect(onFocus).toHaveBeenCalledOnce();
	});
});
