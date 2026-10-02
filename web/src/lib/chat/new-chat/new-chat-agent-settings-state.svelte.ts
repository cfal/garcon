import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { cloneAgentSettings, normalizeAgentSettings, withAgentSetting } from '$shared/agent-settings';
import type { JsonValue } from '$shared/json';
import type { RemoteExecutionDefaults } from '$shared/settings';

type SettingsCatalog = Pick<ModelCatalogStore, 'getDefaultAgentSettings'>;

export class NewChatAgentSettingsState {
	byId = $state<Record<string, AgentSettingsEnvelope>>({});
	readonly #configured = new Set<string>();
	#restored = false;

	forAgent(agentId: string, catalog: SettingsCatalog): AgentSettingsEnvelope {
		return normalizeAgentSettings(agentId, this.byId[agentId], catalog.getDefaultAgentSettings(agentId));
	}

	setSetting(agentId: string, descriptor: AgentSettingDescriptor, value: JsonValue, catalog: SettingsCatalog): void {
		this.#configured.add(agentId);
		this.byId = {
			...this.byId,
			[agentId]: withAgentSetting(this.forAgent(agentId, catalog), descriptor, value),
		};
	}

	restore(settingsById: Record<string, AgentSettingsEnvelope>, agentIds: readonly string[], catalog: SettingsCatalog): void {
		this.#restored = true;
		this.#configured.clear();
		const next: Record<string, AgentSettingsEnvelope> = {};
		for (const [agentId, settings] of Object.entries(settingsById)) {
			if (settings.ownerId !== agentId) continue;
			next[agentId] = cloneAgentSettings(settings);
			this.#configured.add(agentId);
		}
		for (const agentId of agentIds) {
			next[agentId] = normalizeAgentSettings(agentId, next[agentId], catalog.getDefaultAgentSettings(agentId));
		}
		this.byId = next;
	}

	hydrate(defaults: RemoteExecutionDefaults, selectableAgentIds: readonly string[], catalog: SettingsCatalog): void {
		if (this.#restored) return;
		const next = { ...this.byId };
		const agentIds = new Set([
			...Object.keys(defaults.global.agentSettingsById),
			...Object.keys(defaults.byAgent),
			...selectableAgentIds,
		]);
		for (const agentId of agentIds) {
			if (this.#configured.has(agentId)) continue;
			const configured = defaults.byAgent[agentId]?.agentSettingsById?.[agentId]
				?? defaults.global.agentSettingsById[agentId];
			if (configured) this.#configured.add(agentId);
			next[agentId] = normalizeAgentSettings(agentId, configured ?? next[agentId], catalog.getDefaultAgentSettings(agentId));
		}
		this.byId = next;
	}

	applyDefault(agentId: string, configured: AgentSettingsEnvelope | undefined, catalog: SettingsCatalog): void {
		let current = this.byId[agentId];
		if (configured && !this.#restored && !this.#configured.has(agentId)) {
			this.#configured.add(agentId);
			current = configured;
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
			if (this.#configured.has(agentId)) continue;
			// Omitted schedule entries use catalog defaults; explicit empty envelopes stay empty.
			next[agentId] = cloneAgentSettings(catalog.getDefaultAgentSettings(agentId));
		}
		this.byId = next;
	}
}
