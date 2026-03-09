// Canonical provider definitions and capabilities. Shared between server
// and frontend as the single source of truth for provider identity and
// static capability policy.

export const PROVIDERS = ['claude', 'codex', 'opencode', 'amp'] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderCapabilities {
  supportsFork: boolean;
  supportsImages: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  claude: { supportsFork: true, supportsImages: true },
  codex: { supportsFork: true, supportsImages: false },
  opencode: { supportsFork: false, supportsImages: false },
  amp: { supportsFork: false, supportsImages: false },
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function supportsFork(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider].supportsFork;
}

export function supportsImages(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider].supportsImages;
}
