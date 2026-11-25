// Provider identity styling shared by agent pills and usage chart series. Tailwind
// reads these literal class names from source, so each must stay complete.
export interface AgentProviderStyle {
	readonly pillClass: string;
	readonly leftBorderClass: string;
	// A solid accent with contrast against the page background in every theme.
	readonly accentColor: string;
}

const PROVIDER_STYLES: Readonly<Record<string, AgentProviderStyle>> = {
	claude: {
		pillClass:
			'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
		leftBorderClass: 'border-l-provider-claude-border',
		accentColor: 'var(--color-provider-claude-foreground)',
	},
	codex: {
		pillClass: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
		leftBorderClass: 'border-l-provider-codex-border',
		accentColor: 'var(--color-provider-codex-foreground)',
	},
	cursor: {
		pillClass:
			'border-provider-cursor-border bg-provider-cursor-bg text-provider-cursor-foreground',
		leftBorderClass: 'border-l-provider-cursor-border',
		accentColor: 'var(--color-provider-cursor-foreground)',
	},
	opencode: {
		pillClass:
			'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
		leftBorderClass: 'border-l-provider-opencode-border',
		accentColor: 'var(--color-provider-opencode-foreground)',
	},
	amp: {
		pillClass: 'border-provider-amp-border bg-provider-amp-bg text-provider-amp-foreground',
		leftBorderClass: 'border-l-provider-amp-border',
		accentColor: 'var(--color-provider-amp-foreground)',
	},
	factory: {
		pillClass:
			'border-provider-factory-border bg-provider-factory-bg text-provider-factory-foreground',
		leftBorderClass: 'border-l-provider-factory-border',
		accentColor: 'var(--color-provider-factory-foreground)',
	},
	pi: {
		pillClass: 'border-provider-pi-border bg-provider-pi-bg text-provider-pi-foreground',
		leftBorderClass: 'border-l-provider-pi-border',
		accentColor: 'var(--color-provider-pi-foreground)',
	},
	antigravity: {
		pillClass:
			'border-provider-antigravity-border bg-provider-antigravity-bg text-provider-antigravity-foreground',
		leftBorderClass: 'border-l-provider-antigravity-border',
		accentColor: 'var(--color-provider-antigravity-foreground)',
	},
};

/** The provider styling for an agent, or null for agents without a provider identity. */
export function agentProviderStyle(agentId: string): AgentProviderStyle | null {
	return Object.hasOwn(PROVIDER_STYLES, agentId) ? PROVIDER_STYLES[agentId]! : null;
}
