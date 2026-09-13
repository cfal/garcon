import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { ticketTestHarness, syntheticTicket } from './ticket-test-harness';
import TicketsTestHost from './TicketsTestHost.svelte';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
import { ApiError } from '$lib/api/client';

const controllers: TicketsController[] = [];
async function mount(empty = false) {
	const testCase = ticketTestHarness(empty ? [] : undefined);
	controllers.push(testCase.controller);
	testCase.controller.setPresentationVisible(true);
	await testCase.controller.refresh();
	const view = render(TicketsTestHost, { controller: testCase.controller });
	await tick();
	return { ...testCase, view };
}
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe('Tickets surface', () => {
	it('restores the moved row index when a non-close status change leaves the filter', async () => {
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
			const rects = [new DOMRect(0, 0, 100, 20)];
			return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
		});
		const { controller, setItems } = await mount();
		setItems([syntheticTicket(1), syntheticTicket(2), syntheticTicket(3)]);
		controller.setQuery({ status: 'open' });
		await controller.refresh();
		const status = screen.getByRole('button', { name: 'Change status of G-2' });
		status.focus();
		await fireEvent.click(status);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'In progress' }));
		await controller.refresh();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Open G-2' })).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open G-3' }));
	});

	it('uses the refreshed status when a remote reopen overtakes close confirmation', async () => {
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
			const rects = [new DOMRect(0, 0, 100, 20)];
			return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
		});
		const { controller, api, setItems } = await mount();
		controller.setLayout('board');
		await controller.refresh();
		const status = screen.getByRole('button', { name: 'Change status of G-1' });
		status.focus();
		await fireEvent.click(status);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
		let release!: () => void;
		const counts = api.counts.getMockImplementation()!;
		api.counts.mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return counts(...args);
		});
		await fireEvent.click(
			within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
		);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		setItems([{ ...syntheticTicket(), revision: 3 }]);
		release();
		await controller.refresh();
		await tick();
		expect(controller.activeLane).toBe('open');
		expect(await screen.findByText('G-1 moved to Open.')).toBeTruthy();
	});

	it.each([false, true])(
		'clears a confirmed close owner while the renderer is absent (retry=%s)',
		async (retry) => {
			const { controller, api, view } = await mount();
			const status = screen.getByRole('button', { name: 'Change status of G-1' });
			await fireEvent.click(status);
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
			if (retry) {
				api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost response'));
				await fireEvent.click(
					within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
				);
				await within(screen.getByRole('dialog')).findByRole('button', {
					name: 'Retry same request',
				});
			}
			let release!: () => void;
			const mutate = api.mutate.getMockImplementation()!;
			api.mutate.mockImplementationOnce(async (...args) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return mutate(...args);
			});
			await fireEvent.click(
				within(await screen.findByRole('dialog')).getByRole('button', {
					name: retry ? 'Retry same request' : 'Close ticket',
				}),
			);
			view.unmount();
			release();
			await waitFor(() => expect(controller.drafts.pending).toBe(false));
			expect(controller.closeDraft).toBeNull();
			expect(controller.drafts.active.some((draft) => draft.current.kind === 'close')).toBe(false);
			render(TicketsTestHost, { controller });
			await controller.refresh();
			expect(screen.queryByRole('dialog')).toBeNull();
		},
	);

	it('restores the close invoker fallback after submitting a closing comment', async () => {
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
			const rects = [new DOMRect(0, 0, 100, 20)];
			return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
		});
		const { controller, setItems } = await mount();
		setItems([syntheticTicket(1), syntheticTicket(2)]);
		await controller.refresh();
		const status = screen.getByRole('button', { name: 'Change status of G-1' });
		status.focus();
		await fireEvent.click(status);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
		const dialog = await screen.findByRole('dialog');
		const comment = within(dialog).getByRole('textbox');
		comment.focus();
		await fireEvent.input(comment, { target: { value: 'Synthetic closing comment' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await controller.refresh();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open G-2' })),
		);
	});

	it.each(['failure', 'churn'] as const)(
		'retains status focus completion until a fresh refresh after %s',
		async (mode) => {
			vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
				const rects = [new DOMRect(0, 0, 100, 20)];
				return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
			});
			const { controller, api, view } = await mount();
			controller.setLayout('board');
			await controller.refresh();
			const status = screen.getByRole('button', { name: 'Change status of G-1' });
			status.focus();
			await fireEvent.click(status);
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
			const counts = api.counts.getMockImplementation()!;
			api.counts.mockRejectedValue(
				new ApiError(
					mode === 'failure' ? 503 : 409,
					'Synthetic stale read',
					mode === 'failure' ? 'TICKET_PROJECT_UNAVAILABLE' : 'TICKET_COLLECTION_CHANGED',
				),
			);
			await fireEvent.click(
				within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
			);
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			await controller.refresh();
			expect(controller.stale).toBe(true);
			expect(view.container.querySelector('.sr-only[role="status"]')?.textContent).toBe('');
			expect(screen.queryByText('This ticket is outside the current filters.')).toBeNull();
			api.counts.mockImplementation(counts);
			await controller.refresh();
			await waitFor(() => expect(view.container.querySelector('[data-ticket-id="G-1"]')).toBeNull());
			expect(await screen.findByText('This ticket is outside the current filters.')).toBeTruthy();
			expect(document.activeElement).toBe(
				view.container.querySelector('.ticket-lane[data-status="open"] h3'),
			);
		},
	);

	it('drops pinned snapshots immediately on an authority change', async () => {
		const { controller, invalidations, view } = await mount();
		screen.getByRole('button', { name: 'Open G-1' }).focus();
		invalidations.publishAuthority(false);
		await tick();
		expect(controller.collection).toBeNull();
		expect(view.container.querySelector('[data-ticket-id="G-1"]')).toBeNull();
	});

	it('keeps a newer comment editor open when an unmounted editor submission settles', async () => {
		const { controller, api, setComments, view } = await mount();
		const ticket = syntheticTicket();
		const comments = [1, 2].map((sequence) => ({
			id: `22222222-2222-4222-8222-22222222222${sequence}`,
			ticketId: ticket.id,
			revision: 1,
			sequence,
			body: `Comment ${sequence}`,
			author: ticket.createdBy,
			createdAt: ticket.createdAt,
			updatedAt: ticket.createdAt,
			deletedAt: null,
			canEdit: true,
		}));
		setComments(comments);
		controller.select(ticket.id);
		await controller.refresh();
		const articles = () => view.container.querySelectorAll<HTMLElement>('[data-comment-id]');
		await fireEvent.click(within(articles()[0]!).getByRole('button', { name: 'Edit' }));
		await fireEvent.input(articles()[0]!.querySelector('textarea')!, {
			target: { value: 'Submitted A' },
		});
		let release!: () => void;
		const mutate = api.mutate.getMockImplementation()!;
		api.mutate.mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return mutate(...args);
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await fireEvent.click(within(articles()[1]!).getByRole('button', { name: 'Edit' }));
		await fireEvent.input(articles()[1]!.querySelector('textarea')!, {
			target: { value: 'New draft B' },
		});
		const newer = controller.detail.commentEditDraft;
		release();
		await waitFor(() => expect(controller.drafts.pending).toBe(false));
		await controller.refresh();
		expect(controller.detail.commentEditDraft).toBe(newer);
		expect(articles()[1]!.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
			'New draft B',
		);
	});

	it.each(['card', 'editor'] as const)(
		'preserves newer %s focus while a status refresh is held',
		async (target) => {
			vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
				const rects = [new DOMRect(0, 0, 100, 20)];
				return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
			});
			const { controller, api, setItems, view } = await mount();
			setItems([syntheticTicket(1), syntheticTicket(2), syntheticTicket(3)]);
			controller.select('G-2');
			controller.setLayout('board');
			await controller.refresh();
			await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
			const input = screen.getByLabelText('Title');
			const status = screen.getByRole('button', { name: 'Change status of G-1' });
			status.focus();
			await fireEvent.click(status);
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
			let release!: () => void;
			const counts = api.counts.getMockImplementation()!;
			api.counts.mockImplementationOnce(async (...args) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return counts(...args);
			});
			await fireEvent.click(
				within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
			);
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			const focused =
				target === 'editor' ? input : screen.getByRole('button', { name: 'Open G-3' });
			focused.focus();
			release();
			await controller.refresh();
			await waitFor(() => expect(view.container.querySelector('[data-ticket-id="G-1"]')).toBeNull());
			expect(document.activeElement).toBe(focused);
		},
	);

	it.each([false, true])(
		'ignores a late close confirmation after authority replacement (retry=%s)',
		async (retry) => {
			const { controller, api, invalidations } = await mount();
			controller.closeDraft = controller.drafts.open(
				'close',
				{ ticket: syntheticTicket() },
				{ resolution: 'done' },
			);
			if (retry) {
				api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost response'));
				await fireEvent.click(
					within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
				);
				await within(screen.getByRole('dialog')).findByRole('button', {
					name: 'Retry same request',
				});
			}
			let release!: () => void;
			const mutate = api.mutate.getMockImplementation()!;
			api.mutate.mockImplementationOnce(async (...args) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return mutate(...args);
			});
			await fireEvent.click(
				within(await screen.findByRole('dialog')).getByRole('button', {
					name: retry ? 'Retry same request' : 'Close ticket',
				}),
			);
			invalidations.publishAuthority(false);
			await tick();
			api.bootstrap.mockResolvedValue({
				storeId: '11111111-1111-4111-8111-111111111111',
				collectionRevision: 1,
				viewerKey: 'replacement-viewer',
			});
			invalidations.publishAuthority(true);
			await controller.refresh();
			const newer = controller.drafts.open(
				'close',
				{ ticket: syntheticTicket(2) },
				{ resolution: 'canceled' },
			)!;
			controller.closeDraft = newer;
			newer.setField('body', 'New authority draft');
			await tick();
			release();
			await waitFor(() => expect(controller.drafts.pending).toBe(false));
			expect(controller.closeDraft).toBe(newer);
			expect(screen.getByRole('dialog')).toBeTruthy();
		},
	);

	it('drops a closed card re-pinned by dialog focus restoration during a held refresh', async () => {
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
			const rects = [new DOMRect(0, 0, 100, 20)];
			return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
		});
		const { controller, api, view } = await mount();
		controller.setLayout('board');
		await controller.refresh();
		const status = screen.getByRole('button', { name: 'Change status of G-1' });
		status.focus();
		await fireEvent.click(status);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const counts = api.counts.getMockImplementation()!;
		api.counts.mockImplementationOnce(async (...args) => {
			await held;
			return counts(...args);
		});
		await fireEvent.click(
			within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
		);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		status.blur();
		status.focus();
		expect(document.activeElement).toBe(status);
		release();
		await controller.refresh();
		await waitFor(() => expect(view.container.querySelector('[data-ticket-id="G-1"]')).toBeNull());
		expect(document.activeElement).toBe(
			view.container.querySelector('.ticket-lane[data-status="open"] h3'),
		);
	});

	it.each(['fields', 'comment-edit'] as const)(
		'closes the %s editor after an explicit successful retry',
		async (kind) => {
			const { controller, api, setComments, view } = await mount();
			const ticket = syntheticTicket();
			const comment = {
				id: '22222222-2222-4222-8222-222222222222',
				ticketId: ticket.id,
				revision: 1,
				sequence: 1,
				body: 'Original comment',
				author: ticket.createdBy,
				createdAt: ticket.createdAt,
				updatedAt: ticket.createdAt,
				deletedAt: null,
				canEdit: true,
			};
			setComments(kind === 'comment-edit' ? [comment] : []);
			controller.select(ticket.id);
			await controller.refresh();
			if (kind === 'fields') {
				await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
				await fireEvent.input(screen.getByLabelText('Title'), {
					target: { value: 'Retried title' },
				});
			} else {
				await fireEvent.click(
					within(view.container.querySelector('[data-comment-id]')! as HTMLElement).getByRole(
						'button',
						{ name: 'Edit' },
					),
				);
				await fireEvent.input(view.container.querySelector('[data-comment-id] textarea')!, {
					target: { value: 'Retried comment' },
				});
			}
			api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost response'));
			const draft =
				kind === 'fields' ? controller.detail.fieldsDraft! : controller.detail.commentEditDraft!;
			await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
			if (kind === 'comment-edit')
				setComments([{ ...comment, revision: 2, body: 'Retried comment' }]);
			await fireEvent.click(
				await within(screen.getByRole('region', { name: 'Ticket details' })).findByRole('button', {
					name: 'Retry same request',
				}),
			);
			await controller.refresh();
			expect(draft.dirty).toBe(false);
			expect(
				kind === 'fields' ? controller.detail.fieldsDraft : controller.detail.commentEditDraft,
			).toBeNull();
			expect(
				view.container.querySelector(
					kind === 'fields' ? '.ticket-title-input' : '[data-comment-id] textarea',
				),
			).toBeNull();
			expect(
				await within(screen.getByRole('region', { name: 'Ticket details' })).findByText(
					kind === 'fields' ? 'Retried title' : 'Retried comment',
				),
			).toBeTruthy();
		},
	);
	it.each([false, true])(
		'announces successful card close and focuses a surviving row (retry=%s)',
		async (retry) => {
			vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
				const rects = [new DOMRect(0, 0, 100, 20)];
				return Object.assign(rects, {
					item: (index: number): DOMRect | null => rects[index] ?? null,
				});
			});
			const { controller, api, setItems } = await mount();
			setItems([syntheticTicket(1), syntheticTicket(2)]);
			await controller.refresh();
			const status = screen.getByRole('button', { name: 'Change status of G-1' });
			status.focus();
			await fireEvent.click(status);
			await fireEvent.click(await screen.findByRole('menuitem', { name: 'Close ticket' }));
			if (retry) api.mutate.mockRejectedValueOnce(new TypeError('Synthetic lost response'));
			await fireEvent.click(
				within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close ticket' }),
			);
			if (retry)
				await fireEvent.click(
					await within(screen.getByRole('dialog')).findByRole('button', {
						name: 'Retry same request',
					}),
				);
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(await screen.findByText('This ticket is outside the current filters.')).toBeTruthy();
			await waitFor(() =>
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open G-2' })),
			);
		},
	);

	it('omits readiness unless checked and offers checkable view and filter menus', async () => {
		const { controller } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Ticket view settings' }));
		expect(
			screen.getByRole('menuitemcheckbox', { name: 'List' }).getAttribute('aria-checked'),
		).toBe('true');
		await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'List' }));
		await fireEvent.keyDown(document, { key: 'Escape' });
		await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		await fireEvent.submit(screen.getByPlaceholderText('Search tickets…').closest('form')!);
		expect(controller.query).not.toHaveProperty('ready');
		await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
		await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Ready to pick up' }));
		expect(controller.query.ready).toBe(true);
	});

	it('shows activity errors instead of an empty audit and clears them on retry', async () => {
		const { controller, api } = await mount();
		controller.select('G-1');
		await controller.refresh();
		api.history.mockRejectedValueOnce(new Error('Synthetic activity unavailable'));
		await fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
		expect(await screen.findByText('Synthetic activity unavailable')).toBeTruthy();
		expect(screen.queryByText('No activity yet')).toBeNull();
		await fireEvent.click(
			within(screen.getByRole('alert')).getByRole('button', { name: 'Refresh' }),
		);
		await waitFor(() => expect(screen.queryByText('Synthetic activity unavailable')).toBeNull());
	});

	it('shows failed refreshes beside cached detail and hides generic conflict rebase controls', async () => {
		const { controller, api } = await mount();
		controller.select('G-1');
		await controller.refresh();
		api.read.mockRejectedValueOnce(
			new ApiError(413, 'Synthetic detail unavailable', 'TICKET_RESULT_TOO_LARGE'),
		);
		await controller.refresh();
		expect(await screen.findByText('Synthetic detail unavailable')).toBeTruthy();
		api.mutate.mockRejectedValueOnce(
			new ApiError(
				409,
				'Synthetic mutation conflict',
				'TICKET_REVISION_CONFLICT',
				undefined,
				false,
				{ currentTicket: syntheticTicket() },
			),
		);
		await controller.mutate(syntheticTicket(), {
			action: 'claim',
			ticketId: 'G-1',
			expectedRevision: 1,
		});
		expect(await screen.findByText('Synthetic mutation conflict')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Review and retry' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reload server version' })).toBeNull();
	});

	it('retains text selection through attach followed by an explicit host focus request', async () => {
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => {
			const rects = [new DOMRect(0, 0, 100, 20)];
			return Object.assign(rects, {
				item(index: number): DOMRect | null {
					return rects[index] ?? null;
				},
			});
		});
		const { controller, view } = await mount();
		controller.select('G-1');
		await controller.refresh();
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		const original = screen.getByLabelText('Title') as HTMLInputElement;
		await fireEvent.input(original, { target: { value: 'Retained synthetic selection' } });
		original.focus();
		original.setSelectionRange(2, 10, 'backward');
		view.unmount();
		const frame = new SurfaceFrameBridge();
		render(TicketsTestHost, { controller, frame });
		await frame.activate();
		frame.focusPrimary();
		const restored = screen.getByLabelText('Title') as HTMLInputElement;
		expect(document.activeElement).toBe(restored);
		expect([restored.selectionStart, restored.selectionEnd, restored.selectionDirection]).toEqual([
			2,
			10,
			'backward',
		]);
	});

	it('displays the stored priority and submits changed metadata through the shared form', async () => {
		const { controller, api } = await mount();
		controller.select('G-1');
		await controller.refresh();
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		const priority = within(screen.getByRole('region', { name: 'Ticket details' })).getByLabelText(
			'Priority',
		) as HTMLSelectElement;
		expect(priority.value).toBe('2');
		await fireEvent.change(priority, { target: { value: '0' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(api.mutate.mock.lastCall?.[0].payload).toMatchObject({
			action: 'update',
			patch: { priority: 0 },
		});
	});

	it('retains close resolution and comment across dialog cancellation and renderer remount', async () => {
		const { controller, view, api } = await mount();
		controller.select('G-1');
		await controller.refresh();
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
		const dialog = within(await screen.findByRole('dialog'));
		await fireEvent.change(dialog.getByLabelText('Status'), { target: { value: 'canceled' } });
		await fireEvent.input(dialog.getByRole('textbox'), {
			target: { value: 'Retained closing comment' },
		});
		view.unmount();
		render(TicketsTestHost, { controller });
		await tick();
		const remounted = within(await screen.findByRole('dialog'));
		expect((remounted.getByLabelText('Status') as HTMLSelectElement).value).toBe('canceled');
		expect((remounted.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
			'Retained closing comment',
		);
		await fireEvent.click(remounted.getByRole('button', { name: 'Close ticket' }));
		expect(api.mutate.mock.lastCall?.[0].payload).toMatchObject({
			action: 'close',
			resolution: 'canceled',
			comment: 'Retained closing comment',
		});
	});

	it.each(['repository', 'folder'] as const)(
		'prefills the project from a %s without displaying default-source text',
		async (kind) => {
			const { controller, api } = await mount();
			api.projectDefault.mockResolvedValueOnce({ project: '/synthetic/project', kind });
			await controller.beginCreate('/synthetic/context');
			const dialog = within(await screen.findByRole('dialog'));
			const project = dialog.getByLabelText('Project') as HTMLInputElement;
			expect(project.value).toBe('/synthetic/project');
			expect(dialog.queryByText(/Default from (repository|folder)/)).toBeNull();
			await fireEvent.input(project, { target: { value: '' } });
			expect(
				dialog.getByText('Enter a project name. A chat or folder is not required.'),
			).toBeTruthy();
		},
	);

	it('keeps default lookup failures visible until a project is entered', async () => {
		const { controller, api } = await mount();
		api.projectDefault.mockRejectedValueOnce(
			new ApiError(503, 'Synthetic project lookup unavailable'),
		);
		await controller.beginCreate('/synthetic/context');
		const dialog = within(await screen.findByRole('dialog'));
		expect(dialog.getByText('Synthetic project lookup unavailable')).toBeTruthy();
		await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: 'Release' } });
		expect(dialog.queryByText('Synthetic project lookup unavailable')).toBeNull();
	});

	it('creates without a chat or filesystem default and opens authoritative detail', async () => {
		const { controller, api } = await mount(true);
		expect(screen.getByText('No tickets yet')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
		const dialog = await screen.findByRole('dialog');
		const form = within(dialog);
		await fireEvent.input(form.getByLabelText('Title'), {
			target: { value: 'Human-created work' },
		});
		await fireEvent.input(form.getByLabelText('Project'), { target: { value: 'Release' } });
		await fireEvent.click(form.getByRole('button', { name: 'Create ticket' }));
		await waitFor(() => expect(controller.detail.current?.ticket.title).toBe('Human-created work'));
		expect(api.projectDefault).not.toHaveBeenCalled();
		expect(api.mutate).toHaveBeenCalledTimes(1);
		expect(controller.createDraft).toBeNull();
		expect(dialog.getAttribute('data-state')).toBe('closed');
	});

	it('preserves selection and a dirty editor across layout changes and remote refresh', async () => {
		const { controller, setItems, invalidations } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
		await waitFor(() => expect(controller.detail.current).not.toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		const title = screen.getByLabelText('Title') as HTMLInputElement;
		await fireEvent.input(title, { target: { value: 'Unsaved human title' } });
		setItems([{ ...syntheticTicket(), title: 'Remote title', revision: 2 }]);
		invalidations.publish({ kind: 'collection', revision: 2 });
		await controller.refresh();
		await tick();
		expect(screen.getByLabelText('Title')).toBe(title);
		expect(title.value).toBe('Unsaved human title');
		await fireEvent.click(screen.getByRole('button', { name: 'Ticket view settings' }));
		await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Board' }));
		await controller.refresh();
		expect(controller.detail.selectedId).toBe('G-1');
		expect(title.value).toBe('Unsaved human title');
	});

	it('requires a close confirmation and honors cancellation and resolution', async () => {
		const { controller, api } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
		await waitFor(() => expect(controller.detail.current).not.toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
		await fireEvent.click(
			within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
		);
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
		const form = within(await screen.findByRole('dialog'));
		await fireEvent.change(form.getByLabelText('Status'), { target: { value: 'canceled' } });
		await fireEvent.click(form.getByRole('button', { name: 'Close ticket' }));
		await waitFor(() => expect(controller.detail.current?.ticket.resolution).toBe('canceled'));
	});

	it('keeps the composer node and unsaved text when new remote comments arrive', async () => {
		const { controller, invalidations, setComments } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
		const input = (await screen.findByPlaceholderText(
			'Add to the discussion…',
		)) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: 'Unsubmitted multiline\ntext' } });
		const ticket = syntheticTicket();
		setComments([
			{
				id: '22222222-2222-4222-8222-222222222222',
				ticketId: ticket.id,
				revision: 1,
				sequence: 1,
				body: 'Remote progress',
				createdAt: ticket.createdAt,
				updatedAt: ticket.createdAt,
				deletedAt: null,
				author: ticket.createdBy,
				canEdit: false,
			},
		]);
		invalidations.publish({ kind: 'collection', revision: 2 });
		await controller.refresh();
		await tick();
		expect(screen.getByPlaceholderText('Add to the discussion…')).toBe(input);
		expect(input.value).toBe('Unsubmitted multiline\ntext');
		expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
	});
});
