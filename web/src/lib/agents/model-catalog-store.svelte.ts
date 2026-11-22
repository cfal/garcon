import { fetchModelCatalogResponse } from '$lib/api/model-catalog';
import { ApiError, isTransientRequestFailure } from '$lib/api/client';
import { effectiveExecutorId, type ExecutorSnapshot } from '$shared/executors';
import { isRecord } from '$shared/json';
import { agentLabelFor } from './agent-labels.js';
import { PendingAgentLogins } from './pending-agent-logins.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import { CATALOG_INSTANCE_HEADER, type ModelCatalogResponse } from '$shared/model-catalog';
import type { ResolvedModelSelection } from '$shared/start-selection';
import {
	isAgentSettingLabelKey,
	isAgentSettingOptionDescriptionKey,
	isAgentSettingOptionLabelKey,
	parseAgentSettingsEnvelope,
	type AgentSettingDescriptor,
	type AgentSettingsEnvelope,
} from '$shared/agent-integration';
import { createEmptyAgentSettings } from '$shared/agent-settings';
import {
	ANY_FILE_ATTACHMENT_MIME_TYPE,
	type FileAttachmentMimeTypes,
} from '$shared/attachments';
import { hasAgentExecutionMetadata, isAgentId, type AgentCatalogEntry } from '$shared/agents';
import {
	isPermissionMode,
	isThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';
import {
	isApiProviderTemplateId,
	type ApiProtocol,
	type ApiProviderCatalogEntry,
	type ApiProviderEndpointCatalogEntry,
	type ApiProviderTemplateId,
	type ModelDiscoveryKind,
	type OpenAiEndpointCapabilities,
} from '$shared/api-providers';

export interface ModelOption {
	value: string;
	label: string;
	supportsImages?: boolean;
	isLocal?: boolean;
	apiProviderId?: string;
	endpointId?: string;
	rawModel?: string;
	protocol?: ApiProtocol;
}

export interface AgentMetadata extends Pick<AgentCatalogEntry, 'executionPolicy' | 'selectionLabel' | 'inputFormatByModel'> {
	id: string;
	label: string;
	description?: string;
	supportsCompact: boolean;
	supportsFork: boolean;
	supportsForkAtMessage: boolean;
	supportsForkWhileRunning: boolean;
	supportsUpdateProjectPath: boolean;
	supportsSteering: boolean;
	supportsImages: boolean;
	fileAttachmentMimeTypes: FileAttachmentMimeTypes;
	acceptsApiProviderEndpoints: boolean;
	supportedProtocols: ApiProtocol[];
	authLoginSupported: boolean;
	supportedPermissionModes: PermissionMode[];
	supportedThinkingModes: ThinkingMode[];
	settings: AgentSettingDescriptor[];
	defaultSettings: AgentSettingsEnvelope;
	defaultModel: string;
}

type AgentModels = Record<string, ModelOption[]>;
type AgentMetadataMap = Record<string, AgentMetadata>;

interface ModelCatalogSnapshot {
	instanceId: string | null;
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
	etag: string | null;
	lastFetchedAt: number | null;
	lastValidatedAt: number | null;
}

const SNAPSHOT_SCHEMA_VERSION = 2;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const VALIDATION_RETRY_MS = 30_000;

function normalizeModelOption(value: unknown): ModelOption | null {
	if (!value || typeof value !== 'object') return null;
	const maybe = value as Record<string, unknown>;
	if (typeof maybe.value !== 'string' || typeof maybe.label !== 'string') return null;
	return {
		value: maybe.value,
		label: maybe.label,
		supportsImages: typeof maybe.supportsImages === 'boolean' ? maybe.supportsImages : undefined,
		isLocal: typeof maybe.isLocal === 'boolean' ? maybe.isLocal : undefined,
		apiProviderId: typeof maybe.apiProviderId === 'string' ? maybe.apiProviderId : undefined,
		endpointId: typeof maybe.endpointId === 'string' ? maybe.endpointId : undefined,
		rawModel: typeof maybe.rawModel === 'string' ? maybe.rawModel : undefined,
		protocol:
			maybe.protocol === 'openai-compatible' || maybe.protocol === 'anthropic-messages'
				? (maybe.protocol as ApiProtocol)
				: undefined,
	};
}

function normalizeProtocols(value: unknown): ApiProtocol[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(p): p is ApiProtocol => p === 'openai-compatible' || p === 'anthropic-messages',
	);
}

function normalizeFileAttachmentMimeTypes(value: unknown): FileAttachmentMimeTypes {
	if (value === ANY_FILE_ATTACHMENT_MIME_TYPE) return ANY_FILE_ATTACHMENT_MIME_TYPE;
	if (!Array.isArray(value)) return [];
	return value.filter((mimeType): mimeType is string => typeof mimeType === 'string');
}

function normalizePermissionModes(value: unknown): PermissionMode[] {
	return Array.isArray(value) ? value.filter(isPermissionMode) : [];
}

function normalizeThinkingModes(value: unknown): ThinkingMode[] {
	return Array.isArray(value) ? value.filter(isThinkingMode) : [];
}

function normalizeSettingDescriptors(value: unknown): AgentSettingDescriptor[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate): AgentSettingDescriptor[] => {
		if (!candidate || typeof candidate !== 'object') return [];
		const descriptor = candidate as Record<string, unknown>;
		if (typeof descriptor.key !== 'string' || typeof descriptor.label !== 'string') return [];
		const base = {
			key: descriptor.key,
			label: descriptor.label,
			...(isAgentSettingLabelKey(descriptor.labelKey) ? { labelKey: descriptor.labelKey } : {}),
		};
		if (descriptor.type === 'boolean' || descriptor.type === 'string') {
			return [{ ...base, type: descriptor.type }];
		}
		if (descriptor.type === 'credential-ref') {
			return typeof descriptor.credentialKind === 'string'
				? [{ ...base, type: descriptor.type, credentialKind: descriptor.credentialKind }]
				: [];
		}
		if (descriptor.type === 'enum') {
			if (!Array.isArray(descriptor.options)) return [];
			const options = descriptor.options.flatMap((candidateOption) => {
				if (!candidateOption || typeof candidateOption !== 'object') return [];
				const option = candidateOption as Record<string, unknown>;
				if (typeof option.value !== 'string' || typeof option.label !== 'string') return [];
				return [
					{
						value: option.value,
						label: option.label,
						...(isAgentSettingOptionLabelKey(option.labelKey) ? { labelKey: option.labelKey } : {}),
						...(typeof option.description === 'string' ? { description: option.description } : {}),
						...(isAgentSettingOptionDescriptionKey(option.descriptionKey)
							? { descriptionKey: option.descriptionKey }
							: {}),
					},
				];
			});
			return options.length === descriptor.options.length
				? [{ ...base, type: descriptor.type, options }]
				: [];
		}
		return descriptor.type === 'number' &&
			typeof descriptor.min === 'number' &&
			typeof descriptor.max === 'number' &&
			typeof descriptor.step === 'number'
			? [
					{
						...base,
						type: descriptor.type,
						min: descriptor.min,
						max: descriptor.max,
						step: descriptor.step,
					},
				]
			: [];
	});
}

function normalizeDefaultSettings(
	agentId: string,
	value: unknown,
	fallback?: AgentSettingsEnvelope,
): AgentSettingsEnvelope {
	const parsed = parseAgentSettingsEnvelope(value);
	if (parsed?.ownerId === agentId) return parsed;
	if (fallback?.ownerId === agentId) return fallback;
	return createEmptyAgentSettings(agentId);
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId | undefined {
	if (isApiProviderTemplateId(value)) return value;
	return undefined;
}

function normalizeModelDiscovery(value: unknown): ModelDiscoveryKind | undefined {
	if (
		value === 'none' ||
		value === 'anthropic-models' ||
		value === 'openai-models' ||
		value === 'ollama-tags' ||
		value === 'openrouter-models'
	) {
		return value;
	}
	return undefined;
}

function normalizeOpenAiCapabilities(value: unknown): OpenAiEndpointCapabilities | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	return {
		chatCompletions: raw.chatCompletions === true,
		responses: raw.responses === true,
	};
}

function normalizeApiProviderEndpoint(value: unknown): ApiProviderEndpointCatalogEntry | null {
	if (!value || typeof value !== 'object') return null;
	const entry = value as Record<string, unknown>;
	const protocol =
		entry.protocol === 'openai-compatible' || entry.protocol === 'anthropic-messages'
			? entry.protocol
			: null;
	if (
		typeof entry.id !== 'string' ||
		!protocol ||
		typeof entry.baseUrl !== 'string' ||
		typeof entry.defaultModel !== 'string' ||
		typeof entry.supportsImages !== 'boolean' ||
		typeof entry.hasApiKey !== 'boolean'
	) {
		return null;
	}
	return {
		id: entry.id,
		protocol,
		baseUrl: entry.baseUrl,
		capabilities: normalizeOpenAiCapabilities(entry.capabilities),
		defaultModel: entry.defaultModel,
		models: Array.isArray(entry.models)
			? entry.models
					.map((model) => normalizeModelOption(model))
					.filter((model): model is ModelOption => model !== null)
			: [],
		supportsImages: entry.supportsImages,
		hasApiKey: entry.hasApiKey,
		apiKeyLabel: typeof entry.apiKeyLabel === 'string' ? entry.apiKeyLabel : undefined,
		modelDiscovery: normalizeModelDiscovery(entry.modelDiscovery),
	};
}

function normalizeApiProviders(value: unknown): ApiProviderCatalogEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const e = entry as Record<string, unknown>;
			if (
				typeof e.id !== 'string' ||
				typeof e.label !== 'string' ||
				!Number.isSafeInteger(e.revision) || Number(e.revision) < 1 ||
				typeof e.createdAt !== 'string' ||
				typeof e.updatedAt !== 'string' ||
				!Array.isArray(e.endpoints)
			) {
				return null;
			}
			const endpoints = e.endpoints
				.map((endpoint) => normalizeApiProviderEndpoint(endpoint))
				.filter((endpoint): endpoint is ApiProviderEndpointCatalogEntry => endpoint !== null);
			if (endpoints.length === 0) return null;
			const templateId = normalizeTemplateId(e.templateId);
			return {
				id: e.id,
				revision: Number(e.revision),
				label: e.label,
				...(templateId ? { templateId } : {}),
				createdAt: e.createdAt,
				updatedAt: e.updatedAt,
				endpoints,
			} satisfies ApiProviderCatalogEntry;
		})
		.filter((e): e is ApiProviderCatalogEntry => e !== null);
}

function normalizeAgentMetadataMap(agentMetadata: AgentMetadataMap): AgentMetadataMap {
	return Object.fromEntries(
		Object.entries(agentMetadata)
			.filter(([id]) => isAgentId(id))
			.map(([id, metadata]) => {
				return [
					id,
					{
						...metadata,
						supportsCompact: metadata.supportsCompact === true,
						supportsFork: metadata.supportsFork === true,
						supportsForkAtMessage: metadata.supportsForkAtMessage === true,
						supportsForkWhileRunning: metadata.supportsForkWhileRunning === true,
						supportsUpdateProjectPath: metadata.supportsUpdateProjectPath === true,
						supportsSteering: metadata.supportsSteering === true,
						label: metadata.label ?? id,
						supportedPermissionModes: normalizePermissionModes(metadata.supportedPermissionModes),
						supportedThinkingModes: normalizeThinkingModes(metadata.supportedThinkingModes),
						settings: normalizeSettingDescriptors(metadata.settings),
						defaultSettings: normalizeDefaultSettings(id, metadata.defaultSettings),
						defaultModel: metadata.defaultModel ?? '',
					},
				];
			}),
	);
}

function parseCatalogResponse(data: unknown): {
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
} | null {
	if (!data || typeof data !== 'object') return null;
	const root = data as Record<string, unknown>;
	const catalog = root.catalog;
	if (!catalog || typeof catalog !== 'object') return null;
	const inner = catalog as Record<string, unknown>;
	if (!Array.isArray(inner.agents)) return null;

	const agentModels: AgentModels = {};
	const agentMetadata: AgentMetadataMap = {};

	for (const entry of inner.agents as Array<Record<string, unknown>>) {
		if (!entry || typeof entry.id !== 'string') continue;

		const id = entry.id;
		if (!isAgentId(id)) continue;
		if (!hasAgentExecutionMetadata(entry)) return null;
		agentMetadata[id] = {
			id,
			executionPolicy: entry.executionPolicy,
			selectionLabel: entry.selectionLabel,
			inputFormatByModel: entry.inputFormatByModel,
			label: typeof entry.label === 'string' ? entry.label : id,
			description: typeof entry.description === 'string' ? entry.description : undefined,
			supportsCompact: Boolean(entry.supportsCompact),
			supportsFork: Boolean(entry.supportsFork),
			supportsForkAtMessage: Boolean(entry.supportsForkAtMessage),
			supportsForkWhileRunning: Boolean(entry.supportsForkWhileRunning),
			supportsUpdateProjectPath: Boolean(entry.supportsUpdateProjectPath),
			supportsSteering: Boolean(entry.supportsSteering),
			supportsImages: Boolean(entry.supportsImages),
			fileAttachmentMimeTypes: normalizeFileAttachmentMimeTypes(entry.fileAttachmentMimeTypes),
			acceptsApiProviderEndpoints: Boolean(entry.acceptsApiProviderEndpoints),
			supportedProtocols: normalizeProtocols(entry.supportedProtocols),
			authLoginSupported: Boolean(entry.authLoginSupported),
			supportedPermissionModes: normalizePermissionModes(entry.supportedPermissionModes),
			supportedThinkingModes: normalizeThinkingModes(entry.supportedThinkingModes),
			settings: normalizeSettingDescriptors(entry.settings),
			defaultSettings: normalizeDefaultSettings(id, entry.defaultSettings),
			defaultModel: typeof entry.defaultModel === 'string' ? entry.defaultModel : '',
		};

		if (Array.isArray(entry.models)) {
			agentModels[id] = entry.models
				.map((m) => normalizeModelOption(m))
				.filter((m): m is ModelOption => m !== null);
		}
	}

	return {
		agentModels,
		agentMetadata,
		apiProviderCatalog: normalizeApiProviders(inner.apiProviders),
	};
}

function emptySnapshot(): ModelCatalogSnapshot {
	return {
		instanceId: null,
		agentModels: {},
		agentMetadata: {},
		apiProviderCatalog: [],
		etag: null,
		lastFetchedAt: null,
		lastValidatedAt: null,
	};
}

function normalizeSnapshot(parsed: Record<string, unknown>): ModelCatalogSnapshot {
	if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return emptySnapshot();
	if (!parsed.agentMetadata || typeof parsed.agentMetadata !== 'object'
		|| Array.isArray(parsed.agentMetadata)
		|| !Object.values(parsed.agentMetadata).every(hasAgentExecutionMetadata)) return emptySnapshot();
	const agentModels =
		typeof parsed.agentModels === 'object' && parsed.agentModels !== null
			? (parsed.agentModels as AgentModels)
			: {};
	const agentMetadata = normalizeAgentMetadataMap(parsed.agentMetadata as AgentMetadataMap);
	const apiProviderCatalog = normalizeApiProviders(parsed.apiProviderCatalog);
	const lastFetchedAt = typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
	const lastValidatedAt =
		typeof parsed.lastValidatedAt === 'number' ? parsed.lastValidatedAt : lastFetchedAt;

	return {
		instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : null,
		agentModels,
		agentMetadata,
		apiProviderCatalog,
		etag: typeof parsed.etag === 'string' ? parsed.etag : null,
		lastFetchedAt,
		lastValidatedAt,
	};
}

function readExecutorSnapshots(owner: string): Record<string, ModelCatalogSnapshot> {
	try {
		const parsed: unknown = JSON.parse(getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors) ?? '{}');
		if (!isRecord(parsed)) return {};
		const snapshots = new Map<string, ModelCatalogSnapshot>();
		for (const [id, value] of Object.entries(parsed)) {
			if (isRecord(value) && value.owner === owner) snapshots.set(id, normalizeSnapshot(value));
		}
		return Object.fromEntries(snapshots);
	} catch {
		return {};
	}
}

function readPersisted(executorId: string, owner: string): ModelCatalogSnapshot {
	try {
		if (executorId !== 'local') return readExecutorSnapshots(owner)[executorId] ?? emptySnapshot();
		const raw =
			getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog) ??
			getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogLegacy);
		if (!raw) return emptySnapshot();
		const snapshot: unknown = JSON.parse(raw);
		return isRecord(snapshot) && snapshot.owner === owner ? normalizeSnapshot(snapshot) : emptySnapshot();
	} catch {
		return emptySnapshot();
	}
}

function ownedSnapshot(snapshot: ModelCatalogSnapshot, owner: string) {
	return { ...snapshot, schemaVersion: SNAPSHOT_SCHEMA_VERSION, owner };
}

function writeExecutorSnapshots(owner: string, snapshots: Record<string, ModelCatalogSnapshot>): void {
	const entries = Object.entries(snapshots).map(([id, value]) => [id, ownedSnapshot(value, owner)]);
	setLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors, JSON.stringify(Object.fromEntries(entries)));
}

function persist(executorId: string, snapshot: ModelCatalogSnapshot, owner: string): void {
	if (executorId === 'local') {
		setLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog, JSON.stringify(ownedSnapshot(snapshot, owner)));
		return;
	}
	writeExecutorSnapshots(owner, { ...readExecutorSnapshots(owner), [executorId]: snapshot });
}

function clearPersistedCatalogs(): void {
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog);
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogLegacy);
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors);
}

export class ModelCatalogStore {
	agentModels = $state<AgentModels>({});
	agentMetadata = $state<AgentMetadataMap>({});
	apiProviderCatalog = $state<ApiProviderCatalogEntry[]>([]);
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
	#executorAvailability = new Map<string, Pick<ExecutorSnapshot, 'enabled' | 'availability' | 'instanceId'>>();
	readonly pendingLogins: PendingAgentLogins;

	constructor(readonly executorId = 'local', private readonly catalogs = new Map<string, ModelCatalogStore>(), owner: string | null = null) {
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
		const catalog = new ModelCatalogStore(id, this.catalogs, this.#owner);
		const executor = this.#executorAvailability.get(id);
		catalog.#inventoryInstance = executor?.availability === 'ready' ? executor.instanceId : null;
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
		for (const id of Object.keys(persisted)) if (!ids.has(id)) delete persisted[id];
		for (const id of this.#executorAvailability.keys()) if (!ids.has(id)) this.#executorAvailability.delete(id);
		for (const [id, catalog] of this.catalogs) {
			if (ids.has(id) || id === 'local') continue;
			catalog.#retireLogins();
			catalog.invalidate();
			this.catalogs.delete(id);
		}
		for (const executor of executors) {
			const { enabled, availability, instanceId } = executor;
			const previous = this.#executorAvailability.get(executor.id);
			const catalog = this.catalogs.get(executor.id);
			if (catalog) catalog.#inventoryInstance = enabled && availability === 'ready' ? instanceId : null;
			const changed = previous && (enabled !== previous.enabled || availability !== previous.availability || instanceId !== previous.instanceId);
			if (changed || (catalog && catalog.#instanceId !== null && catalog.#instanceId !== instanceId)) {
				if (executor.id === 'local' && owner !== null) {
					removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog);
					removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogLegacy);
				} else delete persisted[executor.id];
				if (catalog) {
					if (!enabled || availability === 'offline' || instanceId !== previous?.instanceId) catalog.#retireLogins();
					catalog.invalidate();
				}
			}
			this.#executorAvailability.set(executor.id, { enabled, availability, instanceId });
		}
		if (owner !== null) writeExecutorSnapshots(owner, persisted);
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
			const data = response.status === 304 ? null : await response.json() as ModelCatalogResponse;
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
