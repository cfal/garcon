import * as m from '$lib/paraglide/messages.js';
import type { WorkspaceFiles, WorkspaceSingletons } from './workspace-resource-ports.js';
import type { SurfaceDescriptor } from './surface-types.js';

export interface SurfaceCloseGuardRequest {
	surfaceId: string;
	title: string;
	description: string;
	confirmLabel: string;
}

interface SurfaceCloseDependencies {
	files: WorkspaceFiles;
	singletons: WorkspaceSingletons;
	confirmClose(request: SurfaceCloseGuardRequest): Promise<boolean>;
}

type CloseLease = () => void;
type ClosePreparation = CloseLease | null | Promise<CloseLease | null>;

export function prepareSurfaceClose(
	deps: SurfaceCloseDependencies,
	descriptors: readonly SurfaceDescriptor[],
): ClosePreparation {
	const canvas = descriptors.some(
		(surface) => surface.type === 'singleton' && surface.kind === 'chat-canvas',
	)
		? deps.singletons.chatCanvasIfPresent()
		: null;
	const ticketSurface = descriptors.find(
		(surface) => surface.type === 'singleton' && surface.kind === 'tickets',
	);
	const fileIds = descriptors.flatMap((surface) =>
		surface.type === 'file' ? [surface.fileSessionId] : [],
	);
	const prepareFiles = (): ClosePreparation =>
		fileIds.length ? deps.files.prepareDestructiveViews(fileIds, 'close') : () => {};

	const prepareCommit = (): ClosePreparation => {
		const commit = descriptors.find(
			(surface): surface is Extract<SurfaceDescriptor, { type: 'singleton'; kind: 'commit' }> =>
				surface.type === 'singleton' && surface.kind === 'commit',
		);
		if (commit) {
			const controller = deps.singletons.commitIfPresent();
			if (controller && !controller.canClose) return null;
			const draftCount = controller?.retainedDraftCount ?? 0;
			if (draftCount > 0)
				return deps
					.confirmClose({
						surfaceId: commit.id,
						title: m.commit_surface_close_title(),
						description:
							draftCount === 1
								? m.commit_surface_close_drafts_singular()
								: m.commit_surface_close_drafts_plural({ count: draftCount }),
						confirmLabel: m.commit_surface_discard_close(),
					})
					.then((confirmed) => (confirmed ? prepareFiles() : null));
		}
		return prepareFiles();
	};

	const prepareRemaining = (): ClosePreparation => {
		if (ticketSurface) {
			const tickets = deps.singletons.ticketsIfPresent();
			if (tickets?.drafts.pending) return null;
			tickets?.drafts.flush();
			if (tickets?.drafts.needsExitGuard)
				return deps
					.confirmClose({
						surfaceId: ticketSurface.id,
						title: m.tickets_close_surface_title(),
						description: m.tickets_close_surface_description(),
						confirmLabel: m.tickets_close_surface(),
					})
					.then((confirmed) => (confirmed ? prepareCommit() : null));
		}
		return prepareCommit();
	};

	if (!canvas) return prepareRemaining();
	return canvas.prepareClose().then(async (releaseCanvas) => {
		if (!releaseCanvas) return null;
		let releaseRemaining: CloseLease | null = null;
		try {
			releaseRemaining = await prepareRemaining();
			if (!releaseRemaining) return null;
			return () => {
				try {
					releaseCanvas();
				} finally {
					releaseRemaining?.();
				}
			};
		} finally {
			if (!releaseRemaining) releaseCanvas();
		}
	});
}

export function disposeClosedSurface(
	deps: Pick<SurfaceCloseDependencies, 'files' | 'singletons'> & {
		clearAttachmentError(surfaceId: string): void;
		onTerminalLauncherDismissed?(): void;
	},
	surface: SurfaceDescriptor,
): void | Promise<void> {
	deps.clearAttachmentError(surface.id);
	if (surface.type === 'file') return deps.files.destroy(surface.fileSessionId);
	if (surface.type === 'terminal-launcher') deps.onTerminalLauncherDismissed?.();
	if (surface.type === 'singleton') {
		if (surface.kind === 'commit') deps.singletons.commitIfPresent()?.discardDrafts();
		deps.singletons.disposeSurface(surface.kind);
	}
}
