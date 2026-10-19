import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import PullRequestThread from '../PullRequestThread.svelte';
import type { PullRequestThread as PullRequestThreadData } from '$lib/api/pull-requests';

afterEach(cleanup);

it('renders review comments without an action that submits to the selected chat', () => {
	const thread = {
		id: 'thread',
		path: 'src/example.ts',
		side: 'after',
		line: 7,
		diffHunk: '@@ -1 +1 @@\n-old\n+new',
		isOutdated: false,
		comments: [{ id: 1, author: 'reviewer', body: 'Check the error case.', createdAt: '' }],
	} satisfies PullRequestThreadData;
	render(PullRequestThread, { thread });
	expect(screen.getByText('Check the error case.')).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Address with agent' })).toBeNull();
});
