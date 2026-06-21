import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { ReadToolUseMessage } from '$shared/chat-types';
import ChatReadToolGroup from '../ChatReadToolGroup.svelte';

const TS = '2026-05-29T00:00:00.000Z';

describe('ChatReadToolGroup', () => {
	it('renders known file counts in the header', () => {
		render(ChatReadToolGroup, {
			messages: [
				new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
				new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
			],
		});

		expect(screen.getByText('Read')).toBeTruthy();
		expect(screen.getByText('2 files')).toBeTruthy();
	});

	it('renders mixed known and unknown file counts in the header', () => {
		render(ChatReadToolGroup, {
			messages: [
				new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
				new ReadToolUseMessage(TS, 'read-2', ''),
				new ReadToolUseMessage(TS, 'read-3', '   '),
				new ReadToolUseMessage(TS, 'read-4', '/tmp/d.ts'),
				new ReadToolUseMessage(TS, 'read-5', '/tmp/e.ts'),
			],
		});

		expect(screen.getByText('5 files (2 unknown)')).toBeTruthy();
		expect(screen.getAllByText('Unknown file')).toHaveLength(2);
	});

	it('renders all-unknown file counts in the header', () => {
		render(ChatReadToolGroup, {
			messages: [
				new ReadToolUseMessage(TS, 'read-1', ''),
				new ReadToolUseMessage(TS, 'read-2', ''),
				new ReadToolUseMessage(TS, 'read-3', ''),
				new ReadToolUseMessage(TS, 'read-4', ''),
				new ReadToolUseMessage(TS, 'read-5', ''),
			],
		});

		expect(screen.getByText('5 unknown files')).toBeTruthy();
	});

	it('opens known files and leaves unknown rows inert', async () => {
		const onFileOpen = vi.fn();
		render(ChatReadToolGroup, {
			messages: [
				new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts', 3, 2),
				new ReadToolUseMessage(TS, 'read-2', ''),
			],
			onFileOpen,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));

		expect(onFileOpen).toHaveBeenCalledWith('/tmp/a.ts');
		expect(screen.getByText('Lines 3-4')).toBeTruthy();
		expect(screen.getByText('Unknown file')).toBeTruthy();
	});
});
