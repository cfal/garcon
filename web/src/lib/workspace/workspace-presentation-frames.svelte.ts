import type { FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
import type { TerminalRegistry } from '$lib/stores/terminal-registry.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { FrameExpectation, SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import {
	CHAT_SURFACE_ID,
	type PresentationHostId,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { visiblePresentationMap } from './visible-presentations.js';

interface WorkspacePresentationFramesDeps {
	frames?: SurfaceFrameRegistry;
	terminals: TerminalRegistry;
	files: FileSessionRegistry;
}

export class WorkspacePresentationFrames {
	versions = $state<Record<string, number>>({});
	errors = $state<Record<string, string>>({});
	#presentationGeneration = 0;

	constructor(private readonly deps: WorkspacePresentationFramesDeps) {}

	version(surfaceId: string): number {
		return this.versions[surfaceId] ?? 0;
	}

	async retry(surfaceId: string, host: PresentationHostId): Promise<boolean> {
		const frames = this.deps.frames;
		if (!frames) return false;
		const generation = ++this.#presentationGeneration;
		const expectation = frames.beginTransfer(surfaceId, host);
		this.clearError(surfaceId);
		this.#bumpVersion(surfaceId);
		await this.settle(expectation);
		return generation === this.#presentationGeneration;
	}

	beginTransition(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: 'desktop' | 'mobile',
		toMode: 'desktop' | 'mobile',
	): number | null {
		const before = visiblePresentationMap(base, fromMode);
		const after = visiblePresentationMap(next, toMode);
		if (before.size !== after.size) return ++this.#presentationGeneration;
		for (const [host, surfaceId] of before) {
			if (after.get(host) !== surfaceId) return ++this.#presentationGeneration;
		}
		return null;
	}

	isTransitionCurrent(generation: number | null): boolean {
		return generation === null || generation === this.#presentationGeneration;
	}

	prepare(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: 'desktop' | 'mobile',
		toMode: 'desktop' | 'mobile',
	): FrameExpectation[] {
		const frames = this.deps.frames;
		if (!frames) return [];
		const before = visiblePresentationMap(base, fromMode);
		const after = visiblePresentationMap(next, toMode);
		for (const [host, surfaceId] of before) {
			if (after.get(host) === surfaceId) continue;
			this.#prepareRetainedRenderer(surfaceId, base);
		}
		const afterSurfaceIds = new Set(after.values());
		for (const surfaceId of before.values()) {
			if (!afterSurfaceIds.has(surfaceId)) frames.cancel(surfaceId);
		}
		const expectations: FrameExpectation[] = [];
		for (const [host, surfaceId] of after) {
			if (surfaceId === CHAT_SURFACE_ID || before.get(host) === surfaceId) continue;
			this.clearError(surfaceId);
			expectations.push(frames.beginTransfer(surfaceId, host));
			this.#bumpVersion(surfaceId);
		}
		return expectations;
	}

	cancel(expectations: readonly FrameExpectation[]): void {
		for (const expectation of expectations) this.deps.frames?.cancel(expectation.surfaceId);
	}

	recordPreparationError(
		snapshot: WorkspaceLayoutSnapshot,
		error: unknown,
		mode: 'desktop' | 'mobile',
	): void {
		const message = error instanceof Error ? error.message : m.workspace_surface_attach_failed();
		const nextErrors = { ...this.errors };
		for (const surfaceId of visiblePresentationMap(snapshot, mode).values()) {
			if (surfaceId !== CHAT_SURFACE_ID) nextErrors[surfaceId] = message;
		}
		this.errors = nextErrors;
	}

	clearError(surfaceId: string): void {
		const { [surfaceId]: _removed, ...remaining } = this.errors;
		this.errors = remaining;
	}

	async settle(expectation: FrameExpectation): Promise<void> {
		const frames = this.deps.frames;
		if (!frames) return;
		try {
			const handle = await frames.waitFor(expectation);
			await handle.attachRetainedRenderer();
			this.clearError(expectation.surfaceId);
		} catch (error) {
			if (isAbortError(error)) return;
			this.errors = {
				...this.errors,
				[expectation.surfaceId]:
					error instanceof Error ? error.message : m.workspace_surface_attach_failed(),
			};
		}
	}

	#prepareRetainedRenderer(surfaceId: string, snapshot: WorkspaceLayoutSnapshot): void {
		const surface = snapshot.surfaces[surfaceId];
		if (surface?.type === 'terminal') {
			this.deps.terminals.prepareRendererTransfer(surface.terminalId);
			return;
		}
		if (surface?.type === 'file') {
			this.deps.files.get(surface.fileSessionId)?.editor?.prepareRendererTransfer();
		}
	}

	#bumpVersion(surfaceId: string): void {
		this.versions = {
			...this.versions,
			[surfaceId]: (this.versions[surfaceId] ?? 0) + 1,
		};
	}
}
