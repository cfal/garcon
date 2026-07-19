import { FACTORY_MODELS, type SharedModelOption } from '@garcon/common/models';
import type { FactoryConfig } from '../../config.js';
import { buildFactoryCliEnv } from './factory-env.js';
import { inferFactoryModelSupportsImages } from './factory-model-id.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export interface FactoryModelMetadata {
  supportsImages: boolean;
  reasoningEfforts?: string[];
}

export interface FactoryModelCatalog {
  defaultModel: string;
  metadata: Record<string, FactoryModelMetadata>;
  options: SharedModelOption[];
}

interface FactoryHelpCatalog {
  defaultModel: string;
  options: Array<{ value: string; label: string }>;
  reasoningByLabel: Record<string, string[]>;
}

const STATIC_IMAGE_SUPPORT = new Map(
  FACTORY_MODELS.OPTIONS.map((entry) => [entry.value, Boolean(entry.supportsImages)]),
);

function buildFallbackCatalog(): FactoryModelCatalog {
  return {
    defaultModel: FACTORY_MODELS.DEFAULT,
    metadata: Object.fromEntries(
      FACTORY_MODELS.OPTIONS.map((entry) => [
        entry.value,
        { supportsImages: Boolean(entry.supportsImages) },
      ]),
    ),
    options: [...FACTORY_MODELS.OPTIONS],
  };
}

async function readFactoryHelpOutput(config: FactoryConfig): Promise<string> {
  const factoryBinary = config.binary();
  const proc = Bun.spawn([factoryBinary, 'exec', '--help'], {
    // Discovery stays non-airgapped so Droid includes Factory-hosted models.
    // Airgap mode only lists custom models in current Droid releases.
    env: buildFactoryCliEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Factory help failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }

  return stdout;
}

function parseFactoryHelpOutput(raw: string): FactoryHelpCatalog {
  const lines = raw.split('\n');
  const options: Array<{ value: string; label: string }> = [];
  const reasoningByLabel: Record<string, string[]> = {};
  let defaultModel = FACTORY_MODELS.DEFAULT;
  let section: 'models' | 'customModels' | 'details' | null = null;

  for (const line of lines) {
    if (line.startsWith('Available Models:')) {
      section = 'models';
      continue;
    }
    if (line.startsWith('Custom Models:')) {
      section = 'customModels';
      continue;
    }
    if (line.startsWith('Model details:')) {
      section = 'details';
      continue;
    }

    if (section === 'models' || section === 'customModels') {
      const match = line.match(/^\s{2}(\S+)\s{2,}(.+?)\s*$/);
      if (!match) {
        if (options.length > 0 && !line.trim()) {
          section = null;
        }
        continue;
      }

      const value = match[1];
      const rawLabel = match[2];
      const label = rawLabel.replace(/\s+\(default\)\s*$/i, '').trim();
      if (/\(default\)\s*$/i.test(rawLabel)) {
        defaultModel = value;
      }
      options.push({ value, label });
      continue;
    }

    if (section === 'details') {
      const match = line.match(/^\s{2}- (.+?): supports reasoning: (Yes|No); supported: \[(.*?)\]; default: (.+)\s*$/);
      if (!match) {
        if (Object.keys(reasoningByLabel).length > 0 && !line.trim()) {
          section = null;
        }
        continue;
      }

      const label = match[1].trim();
      const supported = match[3].trim();
      reasoningByLabel[label] = supported
        ? supported.split(',').map((entry) => entry.trim()).filter(Boolean)
        : [];
    }
  }

  return {
    defaultModel,
    options: options.length > 0 ? options : FACTORY_MODELS.OPTIONS.map(({ value, label }) => ({ value, label })),
    reasoningByLabel,
  };
}

function mergeFactoryModels(helpCatalog: FactoryHelpCatalog): FactoryModelCatalog {
  const options: SharedModelOption[] = [];
  const metadata: Record<string, FactoryModelMetadata> = {};

  for (const option of helpCatalog.options) {
    const supportsImages = STATIC_IMAGE_SUPPORT.get(option.value)
      ?? inferFactoryModelSupportsImages(option.value);
    options.push({ ...option, supportsImages });
    metadata[option.value] = {
      supportsImages,
      reasoningEfforts: helpCatalog.reasoningByLabel[option.label] ?? [],
    };
  }

  const defaultModel = options.some((option) => option.value === helpCatalog.defaultModel)
    ? helpCatalog.defaultModel
    : FACTORY_MODELS.DEFAULT;

  return { defaultModel, metadata, options };
}

async function loadFactoryModelCatalog(config: FactoryConfig): Promise<FactoryModelCatalog> {
  try {
    const helpOutput = await readFactoryHelpOutput(config);
    return mergeFactoryModels(parseFactoryHelpOutput(helpOutput));
  } catch {
    return buildFallbackCatalog();
  }
}

export class FactoryModelCatalogService {
  #cachedCatalog: FactoryModelCatalog | null = null;
  #cachedAt = 0;
  #inflightCatalog: Promise<FactoryModelCatalog> | null = null;

  constructor(private readonly config: FactoryConfig) {}

  async getCatalog(forceRefresh = false): Promise<FactoryModelCatalog> {
    const now = Date.now();
    if (!forceRefresh && this.#cachedCatalog && now - this.#cachedAt < MODEL_CACHE_TTL_MS) {
      return this.#cachedCatalog;
    }
    if (!forceRefresh && this.#inflightCatalog) return this.#inflightCatalog;

    this.#inflightCatalog = loadFactoryModelCatalog(this.config).then((catalog) => {
      this.#cachedCatalog = catalog;
      this.#cachedAt = Date.now();
      this.#inflightCatalog = null;
      return catalog;
    }).catch((error) => {
      this.#inflightCatalog = null;
      throw error;
    });
    return this.#inflightCatalog;
  }

  async getModels(forceRefresh = false): Promise<SharedModelOption[]> {
    return (await this.getCatalog(forceRefresh)).options;
  }

  async getDefaultModel(forceRefresh = false): Promise<string> {
    return (await this.getCatalog(forceRefresh)).defaultModel;
  }

  async getModelMetadata(model: string): Promise<FactoryModelMetadata | null> {
    if (!model) return null;
    return (await this.getCatalog()).metadata[model] ?? null;
  }
}
