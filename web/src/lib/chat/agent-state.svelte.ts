// Agent, model, and permission mode state for the active chat session.
// Manages cycling through permission modes and models, and persists
// selections to localStorage.

import type { SessionAgentId } from '$lib/types/app';
import type { AmpAgentMode, PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { ApiProtocol } from '$shared/api-providers';
import {
	AMP_AGENT_MODES,
	THINKING_MODES,
	CYCLABLE_PERMISSION_MODES,
	MODE_LABELS,
} from '$lib/chat/chat-ui-constants';
import type { AmpAgentModeOption, ThinkingModeOption } from '$lib/chat/chat-ui-constants';

export { AMP_AGENT_MODES, THINKING_MODES, MODE_LABELS };
export type { AmpAgentModeOption, ThinkingModeOption };

export const MODE_STYLES: Record<string, { button: string; dot: string }> = {
	default: {
		button: 'bg-muted text-foreground border-border hover:bg-accent hover:text-accent-foreground',
		dot: 'bg-muted-foreground',
	},
	acceptEdits: {
		button: 'bg-secondary text-secondary-foreground border-border hover:bg-secondary/80',
		dot: 'bg-primary',
	},
	bypassPermissions: {
		button:
			'bg-status-warning text-status-warning-foreground border-status-warning-border hover:bg-status-warning/90',
		dot: 'bg-status-warning-foreground',
	},
	plan: {
		button: 'bg-card text-card-foreground border-border hover:bg-muted',
		dot: 'bg-foreground',
	},
};

export const DEFAULT_MODE_STYLE = {
	button: 'bg-primary text-primary-foreground border-primary/20 hover:bg-primary/90',
	dot: 'bg-primary-foreground',
};

export interface ModelSelectionPayload {
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
}

export class AgentState {
	agentId = $state<SessionAgentId>('claude');
	model = $state('opus');
	apiProviderId = $state<string | null>(null);
	modelEndpointId = $state<string | null>(null);
	modelProtocol = $state<ApiProtocol | null>(null);
	permissionMode = $state<PermissionMode>('default');
	thinkingMode = $state<ThinkingMode>('none');
	ampAgentMode = $state<AmpAgentMode>('smart');

	/** Cycles to the next user-cyclable permission mode. */
	cyclePermissionMode(): void {
		const currentIndex = CYCLABLE_PERMISSION_MODES.indexOf(this.permissionMode);
		const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % CYCLABLE_PERMISSION_MODES.length;
		this.permissionMode = CYCLABLE_PERMISSION_MODES[nextIndex];
	}

	/** Cycles to the next thinking mode. */
	cycleThinkingMode(): void {
		const ids = THINKING_MODES.map((m) => m.id);
		const idx = ids.indexOf(this.thinkingMode);
		this.thinkingMode = ids[(idx + 1) % ids.length];
	}

	/** Returns the current thinking mode option. */
	get currentThinkingMode(): ThinkingModeOption {
		return THINKING_MODES.find((m) => m.id === this.thinkingMode) || THINKING_MODES[0];
	}

	/** Returns the current Amp agent mode option. */
	get currentAmpAgentMode(): AmpAgentModeOption {
		return AMP_AGENT_MODES.find((m) => m.id === this.ampAgentMode) || AMP_AGENT_MODES[0];
	}

	/** Returns the style config for the current permission mode. */
	get modeStyle(): { button: string; dot: string } {
		return MODE_STYLES[this.permissionMode] || DEFAULT_MODE_STYLE;
	}

	/** Returns the human-readable label for the current permission mode. */
	get modeLabel(): string {
		return MODE_LABELS[this.permissionMode] || 'Default';
	}

	/** Restores the permission mode for a chat from the server-provided
	 * default. The server session data is the authoritative source. */
	restorePermissionMode(_chatId: string, defaultMode: PermissionMode): void {
		this.permissionMode = defaultMode;
	}

	/** Sets the selected agent. */
	setAgentId(agentId: SessionAgentId): void {
		this.agentId = agentId;
	}

	/** Sets the model and persists the choice. */
	setModel(model: string): void {
		this.model = model;
	}

	/** Sets the full model selection including API provider metadata. */
	setModelSelection(selection: ModelSelectionPayload): void {
		this.model = selection.model;
		this.apiProviderId = selection.apiProviderId ?? null;
		this.modelEndpointId = selection.modelEndpointId ?? null;
		this.modelProtocol = selection.modelProtocol ?? null;
	}
}

export function createAgentState(): AgentState {
	return new AgentState();
}
