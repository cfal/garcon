import type { CliPresentationStyle } from '@garcon/common/cli-presentation';
import * as m from '$lib/paraglide/messages.js';
import { chatEventCardSurfaceClass } from './chat-event-card-style';

export function cliPresentationLabel(style: CliPresentationStyle): string {
	switch (style) {
		case 'info':
			return m.chat_message_cli_info();
		case 'notice':
			return m.chat_message_cli_notice();
		case 'error':
			return m.chat_message_cli_error();
		case 'custom':
			return m.chat_message_cli_custom();
	}
}

export function cliPresentationSurfaceClass(style: CliPresentationStyle): string {
	switch (style) {
		case 'info':
			return chatEventCardSurfaceClass('neutral');
		case 'notice':
			// Notice retains its established status-info presentation.
			return chatEventCardSurfaceClass('info');
		case 'error':
			return chatEventCardSurfaceClass('error');
		case 'custom':
			return 'cli-presentation-custom';
	}
}
