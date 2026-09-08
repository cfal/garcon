import type {
	CanvasContent,
	CanvasListResponse,
	CanvasSummary,
	ChatCanvas,
	CreateCanvasRequest,
	DeleteCanvasRequest,
	UpdateCanvasRequest,
} from '$shared/chat-canvas';
import { canvasSummary } from '$shared/chat-canvas';
import { ApiError } from '$lib/api/client.js';
import * as api from '$lib/api/chat-canvases.js';
import { CanvasSession } from './canvas-session.svelte.js';
import { browserCanvasRecovery, type CanvasRecoveryPort } from './canvas-recovery.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export interface CanvasApiPort {
	list(): Promise<CanvasListResponse>;
	get(id: string): Promise<ChatCanvas>;
	create(request: CreateCanvasRequest): Promise<ChatCanvas>;
	update(request: UpdateCanvasRequest): Promise<ChatCanvas>;
	remove(request: DeleteCanvasRequest): Promise<void>;
}

const defaultApi: CanvasApiPort = {
	list: api.listCanvases,
	get: api.getCanvas,
	create: api.createCanvas,
	update: api.updateCanvas,
	remove: api.deleteCanvas,
};

export interface CanvasViewport {
	x: number;
	y: number;
	zoom: number;
}

export class CanvasController implements PortableSingletonController {
	canvases = $state.raw<CanvasSummary[]>([]);
	unavailableIds = $state.raw<string[]>([]);
	session = $state.raw<CanvasSession | null>(null);
	loading = $state(false);
	closing = $state(false);
	loaded = $state(false);
	error = $state<string | null>(null);
	view = $state<'diagram' | 'list'>('diagram');
	#viewports = new Map<string, CanvasViewport>();
	#disposed = false;
	#refreshing = false;
	#catalogGeneration = 0;
	#pendingCreate: CreateCanvasRequest | null = null;

	constructor(
		private readonly api: CanvasApiPort = defaultApi,
		private readonly recovery: CanvasRecoveryPort = browserCanvasRecovery,
	) {}

	async activate(): Promise<void> {
		if (this.loading || this.closing || this.#disposed) return;
		this.loading = true;
		try {
			const catalog = await this.api.list();
			if (this.#disposed) return;
			this.#setCatalog(catalog);
			this.loaded = true;
			this.error = null;
			if (!this.session && this.canvases[0]) await this.#load(this.canvases[0].id);
		} catch (error) {
			this.#failure(error);
		} finally {
			this.loading = false;
		}
	}

	async open(id: string): Promise<void> {
		if (this.loading || this.closing || this.#disposed || this.session?.saved.id === id) return;
		this.loading = true;
		try {
			await this.#load(id);
			this.error = null;
		} catch (error) {
			this.#failure(error);
		} finally {
			this.loading = false;
		}
	}

	async create(title: string): Promise<boolean> {
		if (this.loading || this.closing || this.#disposed) return false;
		this.loading = true;
		try {
			if (this.session && !(await this.session.flush())) return false;
			return await this.#create({ title: title.trim(), nodes: [], connections: [] });
		} catch (error) {
			this.#failure(error);
			return false;
		} finally {
			this.loading = false;
		}
	}

	async saveCopy(title: string): Promise<boolean> {
		if (this.loading || this.closing || !this.session || this.#disposed) return false;
		this.loading = true;
		try {
			const previous = this.session;
			if (!(await previous.flush()) && !previous.conflict) return false;
			return await this.#create({ ...previous.document.content, title: title.trim() });
		} catch (error) {
			this.#failure(error);
			return false;
		} finally {
			this.loading = false;
		}
	}

	async removeCurrent(): Promise<boolean> {
		if (this.loading || this.closing || !this.session || this.#disposed) return false;
		this.loading = true;
		let release: (() => void) | undefined;
		try {
			const current = this.session;
			release = await current.prepareDelete();
			try {
				await this.api.remove({ id: current.saved.id, expectedRevision: current.saved.revision });
			} catch (error) {
				if (!(error instanceof ApiError && error.status === 404)) throw error;
			}
			if (this.#disposed) return false;
			current.discardRecovery();
			current.abandon();
			this.session = null;
			this.#setCatalog({
				canvases: this.canvases.filter((entry) => entry.id !== current.saved.id),
				unavailableIds: this.unavailableIds,
			});
			this.error = null;
			return true;
		} catch (error) {
			this.#failure(error);
			return false;
		} finally {
			release?.();
			this.loading = false;
		}
	}

	async refresh(): Promise<void> {
		if (this.loading || this.closing || this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		const generation = this.#catalogGeneration;
		try {
			const catalog = await this.api.list();
			if (this.#disposed || this.loading || this.closing || generation !== this.#catalogGeneration)
				return;
			this.#setCatalog(catalog);
			await this.session?.refresh();
		} catch (error) {
			this.#failure(error);
		} finally {
			this.#refreshing = false;
		}
	}

	viewport(id: string): CanvasViewport | undefined {
		return this.#viewports.get(id);
	}
	setViewport(id: string, viewport: CanvasViewport): void {
		this.#viewports.set(id, viewport);
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		void projectState;
	}

	setPresentationVisible(visible: boolean): void {
		void visible;
	}

	dispose(): void {
		this.#disposed = true;
		this.session?.dispose();
		this.#viewports.clear();
	}

	async prepareClose(): Promise<(() => void) | null> {
		if (
			this.loading ||
			this.closing ||
			this.#disposed ||
			this.session?.reloading ||
			this.session?.interacting
		)
			return null;
		this.closing = true;
		const releaseInteraction = this.session?.beginInteraction();
		const release = () => {
			releaseInteraction?.();
			this.closing = false;
		};
		try {
			if (this.session && !(await this.session.flush()) && !this.session.backup()) {
				release();
				return null;
			}
			return release;
		} catch {
			release();
			return null;
		}
	}

	async #create(content: CanvasContent): Promise<boolean> {
		if (this.#disposed) return false;
		if (
			!this.#pendingCreate ||
			JSON.stringify(this.#pendingCreate.content) !== JSON.stringify(content)
		) {
			this.#pendingCreate = { id: crypto.randomUUID(), content };
		}
		const canvas = await this.api.create(this.#pendingCreate);
		if (this.#disposed) return false;
		this.#pendingCreate = null;
		this.session?.discardRecovery();
		this.session?.abandon();
		this.#use(canvas);
		this.#saved(canvas);
		this.loaded = true;
		this.error = null;
		return true;
	}

	async #load(id: string): Promise<void> {
		let canvas: ChatCanvas;
		let recovered = false;
		try {
			canvas = await this.api.get(id);
		} catch (error) {
			if (
				!(error instanceof ApiError) ||
				(error.status !== 404 && error.errorCode !== 'CANVAS_CORRUPT')
			)
				throw error;
			const draft = this.recovery.read(id);
			if (!draft) throw error;
			canvas = draft;
			recovered = true;
		}
		if (this.#disposed) return;
		if (this.session && !(await this.session.preserveBeforeSwitch())) return;
		if (this.#disposed) return;
		this.#use(canvas);
		if (this.session) {
			if (recovered) this.session.conflict = true;
			else if (!this.session.dirty) this.session.discardRecovery();
		}
	}

	#use(canvas: ChatCanvas): void {
		if (this.#disposed) return;
		this.session?.dispose();
		this.session = new CanvasSession(canvas, this.api, this.recovery, (saved) =>
			this.#saved(saved),
		);
	}

	#saved(canvas: ChatCanvas): void {
		if (this.#disposed) return;
		this.#catalogGeneration += 1;
		this.canvases = [
			canvasSummary(canvas),
			...this.canvases.filter((entry) => entry.id !== canvas.id),
		];
	}

	#setCatalog({ canvases, unavailableIds }: CanvasListResponse): void {
		this.#catalogGeneration += 1;
		this.unavailableIds = unavailableIds;
		const ids = new Set(canvases.map((entry) => entry.id));
		this.canvases = canvases;
		try {
			this.canvases = [
				...canvases,
				...this.recovery
					.list()
					.filter((draft) => !ids.has(draft.id))
					.map(canvasSummary),
			];
		} catch {
			// Storage failures must not prevent opening server documents; the session reports recovery availability.
		}
		for (const id of this.#viewports.keys()) if (!ids.has(id)) this.#viewports.delete(id);
	}

	#failure(error: unknown): void {
		this.error = error instanceof Error ? error.message : String(error);
	}
}
