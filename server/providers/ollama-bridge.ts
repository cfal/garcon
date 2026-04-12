// Ollama bridge layer. Detects a running Ollama instance, discovers
// available models, and builds per-provider env/config overrides so
// existing providers (Claude, Codex) can target local models without
// any protocol translation.
//
// IMPORTANT: Switching between local and cloud models mid-session is
// unsupported. CLI conversation history contains backend-specific
// artifacts (e.g. Anthropic thinking-block cryptographic signatures)
// that are invalid when replayed against a different backend. The
// ProviderRegistry and frontend guard against this boundary crossing.

import { getOllamaUrl, isOllamaAutoDetect } from '../config.js';

export interface OllamaModel {
  name: string;
  parameterSize: string;
}

export interface OllamaClaudeEnv {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
}

export interface OllamaCodexSdkOptions {
  baseUrl: string;
  apiKey: string;
}

const DETECTION_TIMEOUT_MS = 3_000;
const REFRESH_INTERVAL_MS = 60_000;

export class OllamaBridge {
  #url: string;
  #available = false;
  #models = new Map<string, OllamaModel>();
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url?: string) {
    this.#url = url ?? getOllamaUrl();
  }

  get url(): string {
    return this.#url;
  }

  get available(): boolean {
    return this.#available;
  }

  /** Probes Ollama by fetching /api/tags with a short timeout. */
  async detect(): Promise<boolean> {
    if (!isOllamaAutoDetect()) {
      this.#available = false;
      return false;
    }
    try {
      const response = await fetch(`${this.#url}/api/tags`, {
        signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS),
      });
      this.#available = response.ok;
      if (this.#available) {
        this.#parseModels(await response.json());
      }
      return this.#available;
    } catch {
      this.#available = false;
      return false;
    }
  }

  /** Fetches and caches the model list from Ollama. */
  async refreshModels(): Promise<OllamaModel[]> {
    if (!this.#available) return [];
    try {
      const response = await fetch(`${this.#url}/api/tags`, {
        signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.#available = false;
        return [];
      }
      const data = await response.json();
      this.#parseModels(data);
      return this.getModels();
    } catch {
      this.#available = false;
      return [];
    }
  }

  /** Returns all discovered Ollama models. */
  getModels(): OllamaModel[] {
    return Array.from(this.#models.values());
  }

  /** Checks whether a model name belongs to Ollama. */
  isOllamaModel(model: string): boolean {
    return this.#models.has(model);
  }

  /** Env vars to inject when spawning Claude CLI against Ollama. */
  getClaudeEnvOverrides(): OllamaClaudeEnv {
    return {
      ANTHROPIC_BASE_URL: this.#url,
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
    };
  }

  /** SDK constructor options for Codex targeting Ollama. */
  getCodexSdkOptions(): OllamaCodexSdkOptions {
    return {
      baseUrl: `${this.#url}/v1`,
      apiKey: 'ollama',
    };
  }

  /** Starts periodic model refresh. */
  startRefreshTimer(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setInterval(() => {
      this.refreshModels().catch((err) => {
        console.warn('ollama: refresh error:', err.message);
      });
    }, REFRESH_INTERVAL_MS);
  }

  /** Stops periodic model refresh. */
  stopRefreshTimer(): void {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  #parseModels(data: any): void {
    this.#models.clear();
    const models = Array.isArray(data?.models) ? data.models : [];
    for (const m of models) {
      if (typeof m?.name !== 'string') continue;
      this.#models.set(m.name, {
        name: m.name,
        parameterSize: m.details?.parameter_size ?? '',
      });
    }
  }
}
