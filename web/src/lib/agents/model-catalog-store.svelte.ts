import { fetchModelCatalogResponse } from '$lib/api/model-catalog';
import { ApiError, isTransientRequestFailure } from '$lib/api/client';
import { effectiveExecutorId, type ExecutorSnapshot } from '$shared/executors';
import { agentLabelFor } from './agent-labels.js';
import { PendingAgentLogins } from './pending-agent-logins.js';
import { LOCAL_STORAGE_KEYS, removeLocalStorageItem } from '$lib/utils/local-persistence';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import { CATALOG_INSTANCE_HEADER } from '$shared/model-catalog';
import type { ResolvedModelSelection } from '$shared/start-selection';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { createEmptyAgentSettings } from '$shared/agent-settings';
import type { FileAttachmentMimeTypes } from '$shared/attachments';
import { isAgentId } from '$shared/agents';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import type { ApiProviderCatalogEntry } from '$shared/api-providers';
import {
	clearPersistedCatalogs,
	emptySnapshot,
	parseCatalogResponse,
	persist,
	readExecutorSnapshots,
	readPersisted,
	writeExecutorSnapshots,
	type AgentMetadata,
	type AgentMetadataMap,
	type AgentModels,
	type ModelOption,
} from './model-catalog-snapshot.js';

export type { AgentMetadata, ModelOption } from './model-catalog-snapshot.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const VALIDATION_RETRY_MS = 30_000;

type ExecutorAvailability = Pick<ExecutorSnapshot, 'enabled' | 'availability' | 'instanceId'>;

export class ModelCatalogStore {
	agentModels = $state.raw<AgentModels>({});
	agentMetadata = $state.raw<AgentMetadataMap>({});
	apiProviderCatalog = $state.raw<ApiProviderCatalogEntry[]>([]);
	etag = $state<string | null>(null);
	lastFetchedAt = $state<number | null>(null);
	lastValidatedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);
	#syncPromise: Promise<void> | null = null;
	#lastSyncAttemptAt = 0;
	#requestVersion = 0;
	#loginRefreshInstance: string | null = null;
	#loginAgents = new Set<string>();
	#instanceId: string | null = null;
	#inventoryInstance = $state<string | null>(null);
	#requiresInventoryMatch = $state(false);
	#owner: string | null;
	readonly pendingLogins: PendingAgentLogins;

	constructor(
		readonly executorId = 'local',
		private readonly catalogs = new Map<string, ModelCatalogStore>(),
		owner: string | null = null,
		private readonly executorAvailability = new Map<string, ExecutorAvailability>(),
	) {
		this.#owner = owner;
		this.pendingLogins = new PendingAgentLogins(executorId, (agentId, instanceId) => {
			// Supersedes pre-login discovery without blocking other validated selections.
			this.#supersedeRefresh();
			if (this.#loginRefreshInstance !== instanceId) this.#loginAgents.clear();
			this.#loginAgents.add(agentId);
			this.#loginRefreshInstance = instanceId;
			this.#persistSnapshot();
			void this.forceRefresh();
		});
		this.catalogs.set(executorId, this);
		this.hydrateFromStorage();
	}

	forExecutor(executorId?: string | null): ModelCatalogStore {
		const id = effectiveExecutorId(executorId);
		const existing = this.catalogs.get(id);
		if (existing) return existing;
		const catalog = new ModelCatalogStore(id, this.catalogs, this.#owner, this.executorAvailability);
		const executor = this.executorAvailability.get(id);
		catalog.#inventoryInstance = executor?.enabled && executor.availability === 'ready' ? executor.instanceId : null;
		return catalog;
	}

	get isValidated(): boolean {
		const confirmed = !this.#requiresInventoryMatch || (this.#instanceId !== null && this.#instanceId === this.#inventoryInstance);
		return confirmed && this.lastValidatedAt !== null && this.error === null;
	}

	reconcileExecutors(executors: readonly ExecutorSnapshot[]): void {
		const ids = new Set(executors.map((executor) => executor.id));
		const owner = this.#owner;
		const persisted = owner !== null ? readExecutorSnapshots(owner) : {};
		let snapshotsChanged = false;
		const removeSnapshot = (id: string) => {
			if (Object.hasOwn(persisted, id)) {
				delete persisted[id];
				snapshotsChanged = true;
			}
		};
		for (const id of Object.keys(persisted)) if (!ids.has(id)) removeSnapshot(id);
		for (const id of this.executorAvailability.keys()) if (!ids.has(id)) this.executorAvailability.delete(id);
		for (const [id, catalog] of this.catalogs) {
			if (ids.has(id) || id === 'local') continue;
			catalog.#retireLogins();
			catalog.invalidate();
			this.catalogs.delete(id);
		}
		for (const executor of executors) {
			const { enabled, availability, instanceId } = executor;
			const previous = this.executorAvailability.get(executor.id);
			const catalog = this.catalogs.get(executor.id);
			const persistedInstance = Object.hasOwn(persisted, executor.id)
				? persisted[executor.id]?.instanceId
				: null;
			if (catalog) catalog.#inventoryInstance = enabled && availability === 'ready' ? instanceId : null;
			const changed = previous && (enabled !== previous.enabled || availability !== previous.availability || instanceId !== previous.instanceId);
			const cachedInstance = catalog ? catalog.#instanceId ?? persistedInstance : persistedInstance;
			if (changed || (cachedInstance != null && cachedInstance !== instanceId)) {
				if (executor.id === 'local' && owner !== null) {
					removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog);
				} else removeSnapshot(executor.id);
				if (catalog) {
					if (!enabled || availability === 'offline' || instanceId !== previous?.instanceId) catalog.#retireLogins();
					catalog.invalidate();
				}
			}
			if (!previous || changed) this.executorAvailability.set(executor.id, { enabled, availability, instanceId });
		}
		if (owner !== null && snapshotsChanged) writeExecutorSnapshots(owner, persisted);
	}

	#supersedeRefresh(): void {
		this.#requestVersion += 1;
		this.#syncPromise = null;
	}

	invalidate(): void {
		this.#instanceId = null;
		this.#supersedeRefresh();
		this.#lastSyncAttemptAt = 0;
		this.isRefreshing = false;
		this.lastValidatedAt = null;
		this.lastFetchedAt = null;
		this.etag = null;
		this.version += 1;
	}

	invalidateAll(): void {
		for (const catalog of this.catalogs.values()) catalog.invalidate();
		if (this.#owner !== null) clearPersistedCatalogs();
	}

	dispose(): void {
		for (const catalog of this.catalogs.values()) {
			catalog.invalidate();
			catalog.#retireLogins();
		}
	}

	#retireLogins(): void {
		this.pendingLogins.clear();
		this.#loginAgents.clear();
		this.#loginRefreshInstance = null;
	}

	beginLogin(agentId: string): Promise<void> {
		if (this.#loginAgents.delete(agentId)) {
			this.#supersedeRefresh();
			this.isRefreshing = false;
			this.#lastSyncAttemptAt = 0;
			if (this.#loginAgents.size === 0) this.#loginRefreshInstance = null;
		}
		return this.pendingLogins.launch(agentId);
	}

	setOwner(owner: string | null): void {
		if (this.#owner === owner) return;
		if (this.#owner !== null) clearPersistedCatalogs();
		for (const catalog of this.catalogs.values()) {
			catalog.#retireLogins();
			catalog.invalidate();
			catalog.#owner = owner;
			catalog.error = null;
			catalog.hydrateFromStorage();
		}
	}

	getSelectableAgents(): SessionAgentId[] {
		return Object.keys(this.agentMetadata).filter(isAgentId) as SessionAgentId[];
	}

	getAgentMetadataList(): AgentMetadata[] {
		return Object.values(this.agentMetadata).filter((metadata) => isAgentId(metadata.id));
	}

	getAgent(id: string): AgentMetadata | null {
		if (!isAgentId(id)) return null;
		return this.agentMetadata[id] ?? null;
	}

	getAgentLabel(id: string): string {
		return agentLabelFor(id, this.agentMetadata[id]?.label ?? id);
	}

	getModels(agentId: SessionAgentId): ModelOption[] {
		if (!isAgentId(agentId)) return [];
		return this.agentModels[agentId] ?? [];
	}

	getDefaultModel(agentId: SessionAgentId): string {
		return this.agentMetadata[agentId]?.defaultModel || this.getModels(agentId)[0]?.value || '';
	}

	getAgentSettingsDescriptors(agentId: SessionAgentId): readonly AgentSettingDescriptor[] {
		return this.agentMetadata[agentId]?.settings ?? [];
	}

	getDefaultAgentSettings(agentId: SessionAgentId): AgentSettingsEnvelope {
		return this.agentMetadata[agentId]?.defaultSettings ?? createEmptyAgentSettings(agentId);
	}

	getPermissionModes(agentId: SessionAgentId): readonly PermissionMode[] {
		return this.agentMetadata[agentId]?.supportedPermissionModes ?? [];
	}

	getThinkingModes(agentId: SessionAgentId): readonly ThinkingMode[] {
		return this.agentMetadata[agentId]?.supportedThinkingModes ?? [];
	}

	// Catalog values identify explicit endpoint choices. Raw persisted names
	// resolve only within their recorded endpoint or the native catalog.
	getModelForSelection(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): ModelOption | null {
		const models = this.getModels(agentId);
		if (modelEndpointId === null) {
			return models.find(
				(entry) => !entry.endpointId && (entry.value === model || entry.rawModel === model),
			) ?? null;
		}
		if (modelEndpointId !== undefined) {
			return models.find(
				(entry) =>
					entry.endpointId === modelEndpointId &&
					(entry.value === model || entry.rawModel === model),
			) ?? null;
		}
		return (
			models.find((entry) => entry.value === model) ??
			models.find((entry) => !entry.endpointId && entry.rawModel === model) ??
			null
		);
	}

	supportsCompact(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsCompact ?? false;
	}

	supportsFork(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsFork ?? false;
	}

	supportsForkAtMessage(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsForkAtMessage ?? false;
	}

	supportsForkWhileRunning(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsForkWhileRunning ?? false;
	}

	supportsUpdateProjectPath(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsUpdateProjectPath ?? false;
	}

	supportsSteering(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsSteering ?? false;
	}

	supportsImages(
		agentId: SessionAgentId,
		model?: string,
		modelEndpointId?: string | null,
	): boolean {
		if (!isAgentId(agentId)) return false;
		if (model) {
			const selected = this.getModelForSelection(agentId, model, modelEndpointId);
			if (selected && typeof selected.supportsImages === 'boolean') {
				return selected.supportsImages;
			}
		}
		return this.agentMetadata[agentId]?.supportsImages ?? false;
	}

	fileAttachmentMimeTypes(agentId: SessionAgentId): FileAttachmentMimeTypes {
		if (!isAgentId(agentId)) return [];
		return this.agentMetadata[agentId]?.fileAttachmentMimeTypes ?? [];
	}

	isLocalModel(agentId: SessionAgentId, model: string, modelEndpointId?: string | null): boolean {
		return this.getModelForSelection(agentId, model, modelEndpointId)?.isLocal === true;
	}

	selectionFor(
		agentId: SessionAgentId,
		model: string,
	): ResolvedModelSelection;
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId: string,
	): ResolvedModelSelection | null;
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId: null | undefined,
	): ResolvedModelSelection;
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): ResolvedModelSelection | null;
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): ResolvedModelSelection | null {
		const selected = this.getModelForSelection(agentId, model, modelEndpointId);
		if (!selected && modelEndpointId) return null;
		return {
			model: selected?.rawModel ?? model,
			apiProviderId: selected?.apiProviderId ?? null,
			modelEndpointId: selected?.endpointId ?? null,
			modelProtocol: selected?.protocol ?? null,
		};
	}

	selectionValueFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): string {
		return this.getModelForSelection(agentId, model, modelEndpointId)?.value ?? model;
	}

	findEndpoint(endpointId: string): {
		apiProvider: ApiProviderCatalogEntry;
		endpoint: ApiProviderCatalogEntry['endpoints'][number];
	} | null {
		for (const apiProvider of this.apiProviderCatalog) {
			const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
			if (endpoint) return { apiProvider, endpoint };
		}
		return null;
	}

	hydrateFromStorage(): void {
		const snapshot = this.#owner !== null ? readPersisted(this.executorId, this.#owner) : emptySnapshot();
		this.#instanceId = snapshot.instanceId;
		this.#requiresInventoryMatch = snapshot.lastValidatedAt !== null;
		this.agentModels = snapshot.agentModels;
		this.agentMetadata = snapshot.agentMetadata;
		this.apiProviderCatalog = snapshot.apiProviderCatalog;
		this.etag = snapshot.etag;
		this.lastFetchedAt = snapshot.lastFetchedAt;
		this.lastValidatedAt = snapshot.lastValidatedAt;
		this.version += 1;
	}

	async refreshIfStale(ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
		if (!this.isStale(ttlMs)) return;
		await this.syncWithServer();
	}

	isStale(ttlMs: number = DEFAULT_TTL_MS): boolean {
		if (!this.isValidated || this.#loginRefreshInstance !== null) return true;
		return this.lastValidatedAt === null || Date.now() - this.lastValidatedAt >= ttlMs;
	}

	async forceRefresh(): Promise<void> {
		await this.syncWithServer({ force: true });
	}

	async syncWithServer(options: { force?: boolean } = {}): Promise<void> {
		const now = Date.now();
		if (this.#syncPromise) return this.#syncPromise;
		if (!options.force && now - this.#lastSyncAttemptAt < VALIDATION_RETRY_MS) return;

		this.#lastSyncAttemptAt = now;
		const requestVersion = this.#requestVersion;
		this.#syncPromise = this.#syncWithServer(options, requestVersion).finally(() => {
			if (requestVersion === this.#requestVersion) this.#syncPromise = null;
		});
		return this.#syncPromise;
	}

	async #syncWithServer(options: { force?: boolean }, requestVersion: number): Promise<void> {
		this.isRefreshing = true;

		try {
			const confirmation = this.#loginRefreshInstance;
			let ordinaryFallback = false;
			let response: Response;
			if (confirmation === null) {
				response = await fetchModelCatalogResponse(this.executorId, options.force ? null : this.etag);
			} else {
				try {
					response = await fetchModelCatalogResponse(this.executorId, null, confirmation, [...this.#loginAgents]);
				} catch (error) {
					if (requestVersion !== this.#requestVersion) return;
					const canUseOrdinaryCatalog = !this.isValidated && error instanceof ApiError && error.errorCode === 'MODEL_DISCOVERY_UNAVAILABLE';
					if (!canUseOrdinaryCatalog) throw error;
					ordinaryFallback = true;
					response = await fetchModelCatalogResponse(this.executorId, null);
				}
			}
			if (requestVersion !== this.#requestVersion) return;
			const responseEtag = response.headers?.get?.('etag') ?? null;
			const servingInstance = response.headers?.get?.(CATALOG_INSTANCE_HEADER) ?? null;
			const data = response.status === 304 ? null : await response.json() as unknown;
			if (requestVersion !== this.#requestVersion) return;
			if ((ordinaryFallback && servingInstance !== confirmation) ||
				(servingInstance && this.#inventoryInstance && this.#inventoryInstance !== servingInstance)) {
				throw new Error('Executor changed during model discovery.');
			}

			if (response.status === 304) {
				if (ordinaryFallback) throw new Error('Expected a complete executor model catalog.');
				this.etag = responseEtag ?? this.etag;
				this.#recordValidation(Date.now(), servingInstance, confirmation);
				return;
			}

			const catalogResult = parseCatalogResponse(data);
			if (!catalogResult || Object.keys(catalogResult.agentMetadata).length === 0) {
				throw new Error('Model catalog response is invalid');
			}
			this.agentModels = catalogResult.agentModels;
			this.agentMetadata = catalogResult.agentMetadata;
			this.apiProviderCatalog = catalogResult.apiProviderCatalog;

			this.etag = responseEtag;
			this.lastFetchedAt = Date.now();
			this.#recordValidation(this.lastFetchedAt, servingInstance, ordinaryFallback ? null : confirmation);
		} catch (error) {
			if (requestVersion !== this.#requestVersion) return;
			if (this.#loginRefreshInstance !== null) {
				const temporarilyBusy = error instanceof ApiError && (error.errorCode === 'EXECUTOR_BUSY' || error.errorCode === 'MODEL_DISCOVERY_UNAVAILABLE');
				if (this.isValidated && (temporarilyBusy || isTransientRequestFailure(error))) return;
				if (error instanceof ApiError && error.errorCode === 'LOGIN_INSTANCE_CHANGED') this.#loginRefreshInstance = null;
			}
			this.error = error instanceof Error ? error.message : 'Unknown error';
		} finally {
			if (requestVersion === this.#requestVersion) this.isRefreshing = false;
		}
	}

	#persistSnapshot(): void {
		if (this.#owner === null) return;
		persist(this.executorId, {
			instanceId: this.#instanceId,
			agentModels: this.agentModels,
			agentMetadata: this.agentMetadata,
			apiProviderCatalog: this.apiProviderCatalog,
			etag: this.etag,
			lastFetchedAt: this.#loginRefreshInstance === null ? this.lastFetchedAt : null,
			lastValidatedAt: this.#loginRefreshInstance === null ? this.lastValidatedAt : null,
		}, this.#owner);
	}

	#recordValidation(checkedAt: number, instanceId: string | null, confirmedLogin: string | null): void {
		this.#instanceId = instanceId;
		this.#requiresInventoryMatch = false;
		if (confirmedLogin !== null) {
			this.#loginAgents.clear();
			this.#loginRefreshInstance = null;
		}
		this.lastValidatedAt = checkedAt;
		this.error = null;
		this.#persistSnapshot();
		this.version += 1;
	}
}

export function createModelCatalogStore(): ModelCatalogStore {
	return new ModelCatalogStore();
}
