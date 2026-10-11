export type TicketsInvalidation =
	| { readonly kind: 'collection'; readonly revision: number }
	| { readonly kind: 'reconnect' }
	| { readonly kind: 'availability'; readonly authenticated: boolean }
	| { readonly kind: 'authority'; readonly authenticated: boolean };

export class TicketsInvalidationHub {
	readonly #listeners = new Set<(event: TicketsInvalidation) => void>();
	authenticationAvailable: boolean | null = null;

	subscribe(listener: (event: TicketsInvalidation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish(event: TicketsInvalidation): void {
		if (event.kind === 'authority' || event.kind === 'availability')
			this.authenticationAvailable = event.authenticated;
		for (const listener of this.#listeners) listener(event);
	}

	publishReconnect(): void {
		this.publish({ kind: 'reconnect' });
	}

	publishAuthority(authenticated: boolean): void {
		this.publish({ kind: 'authority', authenticated });
	}

	publishAvailability(authenticated: boolean): void {
		if (this.authenticationAvailable !== authenticated)
			this.publish({ kind: 'availability', authenticated });
	}
}
