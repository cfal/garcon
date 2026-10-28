import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
	CHAT_EVENT_CARD_SURFACE_CLASSES,
	type ChatEventCardVariant,
} from '$lib/chat/transcript/chat-event-card-style';
import ChatEventCard from '../rows/ChatEventCard.svelte';

const variants = Object.keys(CHAT_EVENT_CARD_SURFACE_CLASSES) as ChatEventCardVariant[];

describe('ChatEventCard', () => {
	it.each(variants)(
		'exposes the appearance slot for the %s surface',
		(variant) => {
			render(ChatEventCard, { variant });

			const card = screen.getByRole('article');
			expect(card.getAttribute('data-slot')).toBe('chat-event-card');
			expect(card.classList.contains('rounded-xl')).toBe(true);
		},
	);
});
