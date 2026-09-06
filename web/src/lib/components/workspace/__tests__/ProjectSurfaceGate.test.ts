import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectTarget } from '$shared/project-resolution';
import ProjectSurfaceGateTestHost from './ProjectSurfaceGateTestHost.svelte';

const retained = {
	retainedProjectPath: '/project',
	retainedEffectiveProjectKey: '/canonical/project',
};

describe('ProjectSurfaceGate', () => {
	it('keeps same-path content visible but inert while a draft resolves', () => {
		const { container } = render(ProjectSurfaceGateTestHost, {
			...retained,
			projectState: {
				kind: 'resolving',
				context: { chatId: 'draft', projectPath: '/project' },
			},
		});

		const action = screen.getByRole('button', { name: 'Project action' });
		const interactionLayer = action.parentElement;
		expect(interactionLayer?.hasAttribute('inert')).toBe(true);
		expect(interactionLayer?.classList.contains('invisible')).toBe(false);
		expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
	});

	it('conceals stale content when a different raw project path is resolving', () => {
		const { container } = render(ProjectSurfaceGateTestHost, {
			...retained,
			projectState: {
				kind: 'resolving',
				context: { chatId: 'draft', projectPath: '/other' },
			},
		});

		const action = screen.getByRole('button', { name: 'Project action', hidden: true });
		expect(action.parentElement?.classList.contains('invisible')).toBe(true);
		expect(action.parentElement?.getAttribute('aria-hidden')).toBe('true');
		expect(screen.getByRole('status').textContent).toContain('Resolving project...');
		expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
	});

	it('restores interaction only after the retained controller matches the available key', () => {
		const projectState = {
			kind: 'available' as const,
			project: {
				chatId: 'chat2',
				projectPath: '/project',
				effectiveProjectKey: '/canonical/project',
			},
		};
		const { container } = render(ProjectSurfaceGateTestHost, {
			...retained,
			projectState,
		});

		const action = screen.getByRole('button', { name: 'Project action' });
		expect(action.parentElement?.hasAttribute('inert')).toBe(false);
		expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('false');
	});

	it('shows actionable unavailable feedback and retries the explicit target', async () => {
		const target = { kind: 'path' as const, projectPath: '/missing-project' };
		const fetchResolution = vi.fn(async (_target: ProjectTarget) => ({
			target,
			resolution: { kind: 'unavailable' as const, reason: 'not-found' as const },
		}));
		const onChooseFolder = vi.fn();
		render(ProjectSurfaceGateTestHost, {
			props: {
				...retained,
				target,
				onChooseFolder,
				fetchResolution,
				projectState: {
					kind: 'unavailable',
					context: { chatId: 'draft', projectPath: target.projectPath },
					reason: 'not-found',
				},
			},
		});

		expect(screen.getByText('Project folder unavailable')).toBeTruthy();
		expect(screen.getByText('The folder could not be found.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

		expect(onChooseFolder).toHaveBeenCalledOnce();
		await waitFor(() => expect(fetchResolution).toHaveBeenCalledOnce());
		expect(fetchResolution.mock.calls[0]?.[0]).toEqual(target);
	});
});
