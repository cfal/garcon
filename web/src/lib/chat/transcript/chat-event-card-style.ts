export const CHAT_EVENT_CARD_SURFACE_CLASSES = {
	default: 'border-border bg-card text-foreground',
	bash: 'border-border bg-chat-bash-row text-foreground',
	info: 'border-status-info-border bg-status-info/20 text-status-info-foreground',
	success: 'border-status-success-border bg-status-success/20 text-status-success-foreground',
	warning: 'border-status-warning-border bg-status-warning/20 text-status-warning-muted-foreground',
	error: 'border-status-error-border bg-status-error/20 text-status-error-foreground',
	neutral: 'border-status-neutral-border bg-status-neutral/25 text-status-neutral-foreground',
	thinking: 'border-border border-dotted bg-muted/50 text-foreground',
} as const;

export type ChatEventCardVariant = keyof typeof CHAT_EVENT_CARD_SURFACE_CLASSES;

export function chatEventCardSurfaceClass(variant: ChatEventCardVariant): string {
	return CHAT_EVENT_CARD_SURFACE_CLASSES[variant];
}
