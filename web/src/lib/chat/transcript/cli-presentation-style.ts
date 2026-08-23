import type { CliPresentationStyle } from '@garcon/common/cli-presentation';
import * as m from '$lib/paraglide/messages.js';

export type CliPresentationCardVariant = 'info' | 'error' | 'neutral';

export function cliPresentationLabel(style: CliPresentationStyle): string {
	switch (style) {
		case 'notice':
			return m.chat_message_cli_notice();
		case 'error':
			return m.chat_message_cli_error();
	}
}

export function cliPresentationCardVariant(
	style: CliPresentationStyle,
): CliPresentationCardVariant {
	switch (style) {
		case 'notice':
			return 'info';
		case 'error':
			return 'error';
	}
}

export function cliPresentationHeaderClass(style: CliPresentationStyle): string {
	switch (style) {
		case 'notice':
			return 'border-status-info-border bg-status-info text-status-info-foreground';
		case 'error':
			return 'border-status-error-border bg-status-error text-status-error-foreground';
	}
}
