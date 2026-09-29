import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browseDirectory } from '$lib/api/files';
import ProjectPathField from '../ProjectPathField.svelte';
import ProjectPathFieldTestHost from './ProjectPathFieldTestHost.svelte';

vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn() }));

type Props = ComponentProps<typeof ProjectPathField>;

function browser(overrides: Partial<Props['browser']> = {}): Props['browser'] {
	return {
		open: false,
		executorId: '22222222-2222-4222-8222-222222222222',
		executorContextKey: 'worker-instance-1',
		currentPath: '/workspace/',
		basePath: '/workspace',
		isMobile: false,
		onSelect: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

function renderField(props: Partial<Props> & { onSubmit?: () => void } = {}) {
	return render(ProjectPathFieldTestHost, {
		id: 'test-path',
		value: '/workspace/project',
		browser: browser(),
		...props,
	});
}

afterEach(() => vi.resetAllMocks());

describe('ProjectPathField', () => {
	it('binds edits in both directions and forwards native input and focus events', async () => {
		const values: string[] = [];
		const onfocus = vi.fn();
		renderField({ oninput: (event) => values.push(event.currentTarget.value), onfocus });
		const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Project path' });
		await fireEvent.input(input, { target: { value: '/typed' } });
		expect(values).toEqual(['/typed']);
		expect(screen.getByTestId('path-value').textContent).toBe('/typed');
		await fireEvent.click(screen.getByRole('button', { name: 'Replace path' }));
		expect(input.value).toBe('/replacement');
		await fireEvent.click(screen.getByRole('button', { name: 'Focus path' }));
		expect(document.activeElement).toBe(input);
		expect(onfocus).toHaveBeenCalledOnce();
	});

	it('leaves Enter and Tab policy to its owner', async () => {
		const onkeydown = vi.fn();
		renderField({ onkeydown });
		const input = screen.getByRole('textbox');
		for (const key of ['Enter', 'Tab']) {
			const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
			await fireEvent(input, event);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(onkeydown).toHaveBeenCalledTimes(2);
	});

	it('keeps readonly, disabled, required and accessible feedback independent', async () => {
		const view = renderField({
			readonly: true,
			required: true,
			'aria-invalid': true,
			'aria-describedby': 'path-feedback',
			feedback: { id: 'path-feedback', error: 'Directory unavailable' },
		});
		const input = screen.getByRole<HTMLInputElement>('textbox');
		expect(input.readOnly).toBe(true);
		expect(input.disabled).toBe(false);
		expect(input.required).toBe(true);
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain(
			'Directory unavailable',
		);
		await view.rerender({ readonly: false, disabled: true });
		expect(input.readOnly).toBe(false);
		expect(input.disabled).toBe(true);
	});

	it('applies feedback layout classes independently of the input', async () => {
		const view = renderField({
			feedback: { id: 'path-feedback', class: '-mt-1' },
		});
		const feedback = document.getElementById('path-feedback')!;
		expect(feedback.classList.contains('min-h-5')).toBe(true);
		expect(feedback.classList.contains('-mt-1')).toBe(true);
		expect(screen.getByRole('textbox').classList.contains('-mt-1')).toBe(false);
		await view.rerender({ feedback: { id: 'path-feedback' } });
		expect(feedback.classList.contains('min-h-5')).toBe(true);
		expect(feedback.classList.contains('-mt-1')).toBe(false);
	});

	it.each([
		['checking', '.animate-spin'],
		['valid', '.text-status-success-foreground'],
		['invalid', '.text-destructive'],
	] as const)(
		'renders %s feedback without showing stale status for an empty path',
		async (status, icon) => {
			const view = renderField({ validationStatus: status, validationError: 'Invalid folder' });
			const field = view.container.querySelector('[data-slot="project-path-field"]')!;
			expect(field.querySelector(icon)).not.toBeNull();
			expect(screen.getByRole('textbox').getAttribute('title')).toBe(
				status === 'invalid' ? 'Invalid folder' : null,
			);
			await view.rerender({ value: ' ' });
			expect(field.querySelector('svg')).toBeNull();
			expect(screen.getByRole('textbox').hasAttribute('title')).toBe(false);
		},
	);

	it('preserves action order and never submits the containing form from a field action', async () => {
		const onToggle = vi.fn();
		const onBrowse = vi.fn();
		const onOpen = vi.fn();
		const onSubmit = vi.fn();
		renderField({
			onSubmit,
			pin: { isPinned: false, loading: false, disabled: false, onToggle },
			browser: browser({ button: { label: 'Browse folders', disabled: false, onclick: onBrowse } }),
			feedback: { worktree: { disabled: false, onOpen } },
		});
		const actions = screen.getAllByRole('button');
		expect(
			actions.slice(0, 5).map((button) => button.getAttribute('aria-label') || button.textContent),
		).toEqual([
			'Executor selector',
			'Pin project path',
			'Browse folders',
			'Additional action',
			'Select a different worktree',
		]);
		await fireEvent.click(screen.getByRole('button', { name: 'Pin project path' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Select a different worktree' }));
		expect(onToggle).toHaveBeenCalledOnce();
		expect(onBrowse).toHaveBeenCalledOnce();
		expect(onOpen).toHaveBeenCalledOnce();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('honors independent pin, browser and worktree gates and prioritizes errors', async () => {
		const onToggle = vi.fn();
		const onOpen = vi.fn();
		const view = renderField({
			pin: { isPinned: true, loading: true, disabled: false, onToggle },
			browser: browser({ button: { label: 'Browse folders', disabled: true, onclick: vi.fn() } }),
			feedback: { worktree: { disabled: true, onOpen } },
		});
		const pin = screen.getByRole<HTMLButtonElement>('button', { name: 'Unpin project path' });
		expect(pin.disabled).toBe(true);
		expect(pin.getAttribute('aria-busy')).toBe('true');
		expect(pin.querySelector('.animate-spin')).not.toBeNull();
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Browse folders' }).disabled).toBe(
			true,
		);
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Select a different worktree' })
				.disabled,
		).toBe(true);
		await fireEvent.click(pin);
		expect(onToggle).not.toHaveBeenCalled();
		await view.rerender({
			feedback: { error: 'Missing folder', worktree: { disabled: false, onOpen } },
		});
		expect(screen.getByText('Missing folder')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Select a different worktree' })).toBeNull();
	});

	it('loads only the supplied executor and fences a same-path executor switch', async () => {
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof browseDirectory>>>();
		vi.mocked(browseDirectory)
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue([{ name: 'current', path: '/workspace/current', type: 'directory' }]);
		const first = browser();
		const view = renderField({ browser: first });
		expect(browseDirectory).not.toHaveBeenCalled();
		await view.rerender({ browser: { ...first, open: true } });
		await waitFor(() =>
			expect(browseDirectory).toHaveBeenCalledWith(
				'/workspace/',
				expect.any(AbortSignal),
				first.executorId,
			),
		);
		const signal = vi.mocked(browseDirectory).mock.calls[0][1];
		const next = browser({
			open: true,
			executorId: '33333333-3333-4333-8333-333333333333',
			executorContextKey: 'builder-instance-1',
		});
		await view.rerender({ browser: next });
		const current = await screen.findByRole('button', { name: 'current' });
		expect(signal?.aborted).toBe(true);
		expect(browseDirectory).toHaveBeenLastCalledWith(
			'/workspace/',
			expect.any(AbortSignal),
			next.executorId,
		);
		await fireEvent.click(current);
		expect(next.onSelect).toHaveBeenCalledWith('/workspace/current');
		expect(first.onSelect).not.toHaveBeenCalled();
		pending.resolve([{ name: 'stale', path: '/workspace/stale', type: 'directory' }]);
		await tick();
		expect(screen.queryByRole('button', { name: 'stale' })).toBeNull();
		await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(next.onClose).toHaveBeenCalledOnce();
		await view.rerender({ browser: { ...next, open: false } });
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
