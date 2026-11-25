import { isRecord } from '$shared/json';
import {
	isAgentSettingLabelKey,
	isAgentSettingOptionDescriptionKey,
	isAgentSettingOptionLabelKey,
	parseAgentSettingsEnvelope,
	type AgentSettingDescriptor,
	type AgentSettingsEnvelope,
} from '$shared/agent-integration';
import { createEmptyAgentSettings } from '$shared/agent-settings';
import { ANY_FILE_ATTACHMENT_MIME_TYPE, type FileAttachmentMimeTypes } from '$shared/attachments';
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
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

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

export interface AgentMetadata extends Pick<
	AgentCatalogEntry,
	'executionPolicy' | 'selectionLabel' | 'inputFormatByModel'
> {
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

export type AgentModels = Record<string, ModelOption[]>;
export type AgentMetadataMap = Record<string, AgentMetadata>;

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
				!Number.isSafeInteger(e.revision) ||
				Number(e.revision) < 1 ||
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

export function parseCatalogResponse(data: unknown): {
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

export function emptySnapshot(): ModelCatalogSnapshot {
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
	if (
		!parsed.agentMetadata ||
		typeof parsed.agentMetadata !== 'object' ||
		Array.isArray(parsed.agentMetadata) ||
		!Object.values(parsed.agentMetadata).every(hasAgentExecutionMetadata)
	)
		return emptySnapshot();
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

export function readExecutorSnapshots(owner: string): Record<string, ModelCatalogSnapshot> {
	try {
		const parsed: unknown = JSON.parse(
			getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors) ?? '{}',
		);
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

export function readPersisted(executorId: string, owner: string): ModelCatalogSnapshot {
	try {
		if (executorId !== 'local') {
			const snapshots = readExecutorSnapshots(owner);
			return Object.hasOwn(snapshots, executorId) ? snapshots[executorId]! : emptySnapshot();
		}
		const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog);
		if (!raw) return emptySnapshot();
		const snapshot: unknown = JSON.parse(raw);
		return isRecord(snapshot) && snapshot.owner === owner
			? normalizeSnapshot(snapshot)
			: emptySnapshot();
	} catch {
		return emptySnapshot();
	}
}

function ownedSnapshot(snapshot: ModelCatalogSnapshot, owner: string) {
	return { ...snapshot, schemaVersion: SNAPSHOT_SCHEMA_VERSION, owner };
}

export function writeExecutorSnapshots(
	owner: string,
	snapshots: Record<string, ModelCatalogSnapshot>,
): void {
	const entries = Object.entries(snapshots).map(([id, value]) => [id, ownedSnapshot(value, owner)]);
	setLocalStorageItem(
		LOCAL_STORAGE_KEYS.modelCatalogExecutors,
		JSON.stringify(Object.fromEntries(entries)),
	);
}

export function persist(executorId: string, snapshot: ModelCatalogSnapshot, owner: string): void {
	if (executorId === 'local') {
		setLocalStorageItem(
			LOCAL_STORAGE_KEYS.modelCatalog,
			JSON.stringify(ownedSnapshot(snapshot, owner)),
		);
		return;
	}
	writeExecutorSnapshots(owner, { ...readExecutorSnapshots(owner), [executorId]: snapshot });
}

export function clearPersistedCatalogs(): void {
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog);
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors);
}
