import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import { THINKING_MODES } from '$lib/chat/composer/chat-ui-constants.js';
import { isCodexSolModel } from '@garcon/common/models';
import { areAgentSettingsCompatible } from '$shared/agent-settings';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export function buildComposerSendPresentation(
	catalog: Pick<ModelCatalogStore, 'getDefaultAgentSettings' | 'getAgentSettingsDescriptors' | 'isValidated' | 'error'>,
	selection: { readonly agentId: string; readonly agentSettings: AgentSettingsEnvelope | null },
	availability: { executorReady: boolean; controllerCommand: boolean; requiresQueuedSubmission: boolean },
) {
	const defaults = catalog.getDefaultAgentSettings(selection.agentId);
	const settingsEnvelope = selection.agentSettings ?? defaults;
	const settingsCompatible = Boolean(defaults && settingsEnvelope
		&& areAgentSettingsCompatible(settingsEnvelope, defaults, catalog.getAgentSettingsDescriptors(selection.agentId)));
	const { executorReady, controllerCommand, requiresQueuedSubmission } = availability;
	const modelsLoading = executorReady && !catalog.isValidated && !catalog.error;
	let sendTitle: string = m.chat_composer_send_message();
	if (!controllerCommand) {
		// Loading is explained by the disabled send button so the composer keeps its height.
		if (modelsLoading) sendTitle = m.chat_composer_loading_models();
		else if (!settingsCompatible) sendTitle = 'Saved provider settings are unavailable or incompatible.';
		else if (requiresQueuedSubmission) sendTitle = m.chat_composer_queue_message();
	}
	return { settingsEnvelope, settingsCompatible, sendTitle };
}

export type ComposerModeIconId =
	| 'permission-default'
	| 'permission-accept-edits'
	| 'permission-manual-bypass'
	| 'permission-bypass'
	| 'permission-plan'
	| 'thinking-none'
	| 'thinking-low'
	| 'thinking-medium'
	| 'thinking-high'
	| 'thinking-xhigh'
	| 'thinking-max'
	| 'thinking-ultra';

export interface ComposerMenuOption<T extends string = string> {
	value: T;
	label: string;
	description: string;
}

export interface ComposerModeOption<T extends string = string> extends ComposerMenuOption<T> {
	iconId: ComposerModeIconId;
	toneClass: string;
	rainbow?: boolean;
}

const PERMISSION_OPTION_METADATA: Record<
	PermissionMode,
	Omit<ComposerModeOption<PermissionMode>, 'value'>
> = {
	default: {
		label: 'Default',
		description: 'Asks before high-impact operations.',
		iconId: 'permission-default',
		toneClass:
			'bg-muted text-foreground border-border hover:bg-accent hover:text-accent-foreground',
	},
	acceptEdits: {
		label: 'Accept Edits',
		description: 'Allows safe file edits without interruption.',
		iconId: 'permission-accept-edits',
		toneClass: 'bg-secondary text-secondary-foreground border-border hover:bg-secondary/80',
	},
	manualBypass: {
		label: 'Manual Bypass',
		description: 'Starts normally and auto-approves permission prompts.',
		iconId: 'permission-manual-bypass',
		toneClass:
			'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/90',
	},
	bypassPermissions: {
		label: 'Bypass Permissions',
		description: 'Runs without permission prompts.',
		iconId: 'permission-bypass',
		toneClass:
			'bg-status-warning text-status-warning-foreground border-status-warning-border hover:bg-status-warning/90',
	},
	plan: {
		label: 'Plan Mode',
		description: 'Focuses on planning before execution.',
		iconId: 'permission-plan',
		toneClass: 'bg-card text-card-foreground border-border hover:bg-muted',
	},
};

const THINKING_ICON_METADATA: Record<
	ThinkingMode,
	Pick<ComposerModeOption<ThinkingMode>, 'iconId' | 'toneClass'>
> = {
	none: {
		iconId: 'thinking-none',
		toneClass:
			'bg-muted text-foreground border-border hover:bg-accent hover:text-accent-foreground',
	},
	low: {
		iconId: 'thinking-low',
		toneClass:
			'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/90',
	},
	medium: {
		iconId: 'thinking-medium',
		toneClass:
			'bg-status-success text-status-success-foreground border-status-success-border hover:bg-status-success/90',
	},
	high: {
		iconId: 'thinking-high',
		toneClass:
			'bg-status-warning text-status-warning-foreground border-status-warning-border hover:bg-status-warning/90',
	},
	xhigh: {
		iconId: 'thinking-xhigh',
		toneClass: 'bg-destructive/20 text-foreground border-destructive/40 hover:bg-destructive/30',
	},
	max: {
		iconId: 'thinking-max',
		toneClass: 'bg-destructive/30 text-foreground border-destructive/50 hover:bg-destructive/40',
	},
	ultra: {
		iconId: 'thinking-ultra',
		toneClass: 'bg-destructive/40 text-foreground border-destructive/60 hover:bg-destructive/50',
	},
};

export function buildPermissionOptions(
	modes: readonly PermissionMode[],
): ComposerModeOption<PermissionMode>[] {
	return modes.map((mode) => ({
		value: mode,
		...PERMISSION_OPTION_METADATA[mode],
	}));
}

export function buildThinkingOptions(
	modes: readonly ThinkingMode[],
	model?: string,
): ComposerModeOption<ThinkingMode>[] {
	return modes.map((modeId) => {
		const mode = THINKING_MODES.find((candidate) => candidate.id === modeId);
		const iconMeta = THINKING_ICON_METADATA[modeId] ?? THINKING_ICON_METADATA.none;
		const rainbow = modeId === 'ultra' && isCodexSolModel(model);
		return {
			value: modeId,
			label: mode?.name ?? modeId,
			description: mode?.description || 'Default thinking behavior.',
			iconId: iconMeta.iconId,
			toneClass: rainbow ? 'rainbow-ultra-surface' : iconMeta.toneClass,
			...(rainbow ? { rainbow: true } : {}),
		};
	});
}
