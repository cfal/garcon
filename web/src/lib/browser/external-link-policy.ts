// Cross-cutting policy for external (http/https) link clicks in rendered
// markdown. Provided via optional context so renderers work unchanged where
// the workspace is absent (e.g. the shared-transcript page).
export interface ExternalLinkPolicy {
	/**
	 * Returns true when the click was handled in-app and default navigation
	 * must be prevented.
	 */
	openExternalLink(href: string): boolean;
}
