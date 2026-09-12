export type IssuesInvalidation =
	| { readonly kind: 'collection'; readonly revision: number }
	| { readonly kind: 'reconnect' }
	| { readonly kind: 'authority'; readonly authenticated: boolean };

export class IssuesInvalidationHub {
	readonly #listeners = new Set<(event: IssuesInvalidation) => void>();
	authenticationAvailable: boolean | null = null;

	subscribe(listener: (event: IssuesInvalidation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish(event: IssuesInvalidation): void {
		if (event.kind === 'authority') this.authenticationAvailable = event.authenticated;
		for (const listener of this.#listeners) listener(event);
	}

	publishReconnect(): void {
		this.publish({ kind: 'reconnect' });
	}

	publishAuthority(authenticated: boolean): void {
		this.publish({ kind: 'authority', authenticated });
	}
}
