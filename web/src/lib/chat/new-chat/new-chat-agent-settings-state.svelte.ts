import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { areAgentSettingsCompatible, cloneAgentSettings, withAgentSetting } from '$shared/agent-settings';
import type { JsonValue } from '$shared/json';
import type { RemoteExecutionDefaults } from '$shared/settings';

type SettingsCatalog = Pick<ModelCatalogStore, 'getDefaultAgentSettings' | 'getAgentSettingsDescriptors'>;

export class NewChatAgentSettingsState {
	byId = $state<Record<string, AgentSettingsEnvelope>>({});
	readonly #configuredAgentIds = new Set<string>();
	#hasRestoredSettings = false;

	forAgent(agentId: string, catalog: SettingsCatalog): AgentSettingsEnvelope | null {
		const envelope = this.byId[agentId] ?? catalog.getDefaultAgentSettings(agentId);
		return envelope ? cloneAgentSettings(envelope) : null;
	}

	isCompatible(agentId: string, catalog: SettingsCatalog): boolean {
		const defaults = catalog.getDefaultAgentSettings(agentId);
		const envelope = this.forAgent(agentId, catalog);
		return Boolean(defaults && envelope
			&& areAgentSettingsCompatible(envelope, defaults, catalog.getAgentSettingsDescriptors(agentId)));
	}

	setSetting(
		agentId: string,
		descriptor: AgentSettingDescriptor,
		value: JsonValue,
		catalog: SettingsCatalog,
	): void {
		const envelope = this.forAgent(agentId, catalog);
		if (!envelope || !this.isCompatible(agentId, catalog)) return;
		this.#configuredAgentIds.add(agentId);
		this.byId = {
			...this.byId,
			[agentId]: withAgentSetting(envelope, descriptor, value),
		};
	}

	restore(
		settingsById: Record<string, AgentSettingsEnvelope>,
		agentIds: readonly string[],
		catalog: SettingsCatalog,
	): void {
		this.#hasRestoredSettings = true;
		this.#configuredAgentIds.clear();
		const next: Record<string, AgentSettingsEnvelope> = {};
		for (const [agentId, settings] of Object.entries(settingsById)) {
			if (settings.ownerId !== agentId) continue;
			next[agentId] = cloneAgentSettings(settings);
			this.#configuredAgentIds.add(agentId);
		}
		for (const agentId of agentIds) {
			const envelope = next[agentId] ?? catalog.getDefaultAgentSettings(agentId);
			if (envelope) next[agentId] = cloneAgentSettings(envelope);
		}
		this.byId = next;
	}

	hydrate(
		defaults: RemoteExecutionDefaults,
		selectableAgentIds: readonly string[],
		catalog: SettingsCatalog,
	): void {
		if (this.#hasRestoredSettings) return;
		const next = { ...this.byId };
		const agentIds = new Set([
			...Object.keys(defaults.global.agentSettingsById),
			...Object.keys(defaults.byAgent),
			...selectableAgentIds,
		]);
		for (const agentId of agentIds) {
			if (this.#configuredAgentIds.has(agentId)) continue;
			const configuredSettings = defaults.byAgent[agentId]?.agentSettingsById?.[agentId]
				?? defaults.global.agentSettingsById[agentId];
			if (configuredSettings) this.#configuredAgentIds.add(agentId);
			const envelope = configuredSettings ?? next[agentId] ?? catalog.getDefaultAgentSettings(agentId);
			if (envelope) next[agentId] = cloneAgentSettings(envelope);
		}
		this.byId = next;
	}

	applyDefault(
		agentId: string,
		defaultSettings: AgentSettingsEnvelope | undefined,
		catalog: SettingsCatalog,
	): void {
		let current = this.byId[agentId];
		if (defaultSettings && !this.#hasRestoredSettings && !this.#configuredAgentIds.has(agentId)) {
			this.#configuredAgentIds.add(agentId);
			current = defaultSettings;
		}
		const envelope = current ?? catalog.getDefaultAgentSettings(agentId);
		if (envelope) this.byId = { ...this.byId, [agentId]: cloneAgentSettings(envelope) };
	}

	ensure(agentId: string, catalog: SettingsCatalog): void {
		const envelope = this.forAgent(agentId, catalog);
		if (envelope) this.byId = { ...this.byId, [agentId]: envelope };
	}

	reconcileCatalog(agentIds: readonly string[], catalog: SettingsCatalog): void {
		const next = { ...this.byId };
		for (const agentId of agentIds) {
			if (this.#configuredAgentIds.has(agentId)) continue;
			// Omitted schedule entries use catalog defaults; explicit empty envelopes stay empty.
			const defaults = catalog.getDefaultAgentSettings(agentId);
			if (defaults) next[agentId] = cloneAgentSettings(defaults);
		}
		this.byId = next;
	}
}
