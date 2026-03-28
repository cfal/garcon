import type { ChatSessionRecord, ChatTurnState } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';

export type ChatVisualStatusKind = 'idle' | 'draft' | 'running' | 'completed' | 'failed';

export interface ChatVisualStatus {
	kind: ChatVisualStatusKind;
	label: string | null;
	accentClass: string;
	chipClass: string;
	dotClass: string;
	textClass: string;
}

function resolveTurnState(session: Pick<ChatSessionRecord, 'status' | 'isProcessing' | 'turnState'>): ChatTurnState | 'draft' {
	if (session.status === 'draft') return 'draft';
	if (session.isProcessing) return 'running';
	if (session.turnState === 'running') return 'idle';
	return session.turnState ?? 'idle';
}

export function getChatVisualStatus(
	session: Pick<ChatSessionRecord, 'status' | 'isProcessing' | 'turnState'>,
): ChatVisualStatus {
	const turnState = resolveTurnState(session);

	switch (turnState) {
		case 'draft':
			return {
				kind: 'draft',
				label: m.chat_status_draft(),
				accentClass: 'border-l-status-warning',
				chipClass:
					'border-status-warning-border/70 bg-status-warning/12 text-status-warning-foreground',
				dotClass: 'bg-status-warning-foreground',
				textClass: 'text-status-warning-foreground',
			};
		case 'running':
			return {
				kind: 'running',
				label: m.chat_status_running(),
				accentClass: 'border-l-status-processing',
				chipClass:
					'border-status-processing-border/70 bg-status-processing/12 text-status-processing-foreground',
				dotClass: 'bg-status-processing animate-pulse',
				textClass: 'text-status-processing-foreground',
			};
		case 'completed':
			return {
				kind: 'completed',
				label: m.chat_status_completed(),
				accentClass: 'border-l-status-success',
				chipClass:
					'border-status-success-border/70 bg-status-success/14 text-status-success-foreground',
				dotClass: 'bg-status-success-foreground',
				textClass: 'text-status-success-foreground',
			};
		case 'failed':
			return {
				kind: 'failed',
				label: m.chat_status_failed(),
				accentClass: 'border-l-status-error',
				chipClass: 'border-status-error-border/70 bg-status-error/14 text-status-error-foreground',
				dotClass: 'bg-status-error-foreground',
				textClass: 'text-status-error-foreground',
			};
		case 'idle':
		default:
			return {
				kind: 'idle',
				label: null,
				accentClass: 'border-l-transparent',
				chipClass: 'border-status-neutral-border/70 bg-status-neutral/14 text-status-neutral-foreground',
				dotClass: 'bg-status-neutral-foreground',
				textClass: 'text-muted-foreground',
			};
	}
}
