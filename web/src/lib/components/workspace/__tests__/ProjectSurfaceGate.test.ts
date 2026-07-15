import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
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
				context: { chatId: 'draft', projectPath: '/project', effectiveProjectKey: null },
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
				context: { chatId: 'draft', projectPath: '/other', effectiveProjectKey: null },
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
});
