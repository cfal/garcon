import type { AcpAdvertisedCapabilities } from './reconnect-policy.js';

export interface AcpCapabilityCacheKey {
  command: string;
  binaryVersion: string;
}

function keyFor(input: AcpCapabilityCacheKey): string {
  return `${input.command}::${input.binaryVersion}`;
}

export class AcpCapabilityCache {
  #cache = new Map<string, AcpAdvertisedCapabilities>();

  get(input: AcpCapabilityCacheKey): AcpAdvertisedCapabilities | null {
    return this.#cache.get(keyFor(input)) ?? null;
  }

  set(input: AcpCapabilityCacheKey, capabilities: AcpAdvertisedCapabilities): void {
    this.#cache.set(keyFor(input), capabilities);
  }
}
