import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { cloneAgentSettings, normalizeAgentSettings, withAgentSetting } from '$shared/agent-settings';
import type { JsonValue } from '$shared/json';
import type { RemoteExecutionDefaults } from '$shared/settings';

type SettingsCatalog = Pick<ModelCatalogStore, 'getDefaultAgentSettings'>;

export class NewChatAgentSettingsState {
	byId = $state<Record<string, AgentSettingsEnvelope>>({});
	readonly #configuredAgentIds = new Set<string>();
	#hasRestoredSettings = false;

	forAgent(agentId: string, catalog: SettingsCatalog): AgentSettingsEnvelope {
		return normalizeAgentSettings(agentId, this.byId[agentId], catalog.getDefaultAgentSettings(agentId));
	}

	setSetting(
		agentId: string,
		descriptor: AgentSettingDescriptor,
		value: JsonValue,
		catalog: SettingsCatalog,
	): void {
		this.#configuredAgentIds.add(agentId);
		this.byId = {
			...this.byId,
			[agentId]: withAgentSetting(this.forAgent(agentId, catalog), descriptor, value),
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
			next[agentId] = normalizeAgentSettings(agentId, next[agentId], catalog.getDefaultAgentSettings(agentId));
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
			next[agentId] = normalizeAgentSettings(
				agentId,
				configuredSettings ?? next[agentId],
				catalog.getDefaultAgentSettings(agentId),
			);
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
		this.byId = {
			...this.byId,
			[agentId]: normalizeAgentSettings(agentId, current, catalog.getDefaultAgentSettings(agentId)),
		};
	}

	ensure(agentId: string, catalog: SettingsCatalog): void {
		this.byId = { ...this.byId, [agentId]: this.forAgent(agentId, catalog) };
	}

	reconcileCatalog(agentIds: readonly string[], catalog: SettingsCatalog): void {
		const next = { ...this.byId };
		for (const agentId of agentIds) {
			if (this.#configuredAgentIds.has(agentId)) continue;
			// Omitted schedule entries use catalog defaults; explicit empty envelopes stay empty.
			next[agentId] = cloneAgentSettings(catalog.getDefaultAgentSettings(agentId));
		}
		this.byId = next;
	}
}
