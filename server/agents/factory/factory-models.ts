import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FACTORY_MODELS, type SharedModelOption } from "../../../common/models.js";
import { getFactoryBinary } from "../../config.js";

const FACTORY_HOME = path.join(os.homedir(), '.factory');
const FACTORY_SETTINGS_PATHS = [
  path.join(FACTORY_HOME, 'settings.json'),
  path.join(FACTORY_HOME, 'settings.local.json'),
];
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

interface FactoryCustomModel {
  displayName?: string;
  id?: string;
  model?: string;
  name?: string;
  noImageSupport?: boolean;
  supportsImages?: boolean;
}

const STATIC_IMAGE_SUPPORT = new Map(
  FACTORY_MODELS.OPTIONS.map((entry) => [entry.value, Boolean(entry.supportsImages)]),
);

let cachedCatalog: FactoryModelCatalog | null = null;
let cachedAt = 0;
let inflightCatalog: Promise<FactoryModelCatalog> | null = null;

function slugifyFactoryDisplayName(displayName: string): string {
  return displayName.trim().replace(/\s+/g, '-');
}

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

async function readFactoryHelpOutput(): Promise<string> {
  const factoryBinary = getFactoryBinary();
  const proc = Bun.spawn([factoryBinary, 'exec', '--help'], {
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
  let section: 'models' | 'details' | null = null;

  for (const line of lines) {
    if (line.startsWith('Available Models:')) {
      section = 'models';
      continue;
    }
    if (line.startsWith('Model details:')) {
      section = 'details';
      continue;
    }

    if (section === 'models') {
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

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readFactoryCustomModels(): Promise<FactoryCustomModel[]> {
  const configs = await Promise.all(FACTORY_SETTINGS_PATHS.map((filePath) => readJsonFile(filePath)));
  const result: FactoryCustomModel[] = [];

  for (const config of configs) {
    const customModels = config?.customModels;
    if (!Array.isArray(customModels)) continue;
    for (const entry of customModels) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      result.push(entry as FactoryCustomModel);
    }
  }

  return result;
}

function mergeFactoryModels(
  helpCatalog: FactoryHelpCatalog,
  customModels: FactoryCustomModel[],
): FactoryModelCatalog {
  const options: SharedModelOption[] = [];
  const metadata: Record<string, FactoryModelMetadata> = {};

  for (const option of helpCatalog.options) {
    const supportsImages = STATIC_IMAGE_SUPPORT.get(option.value) ?? false;
    options.push({ ...option, supportsImages });
    metadata[option.value] = {
      supportsImages,
      reasoningEfforts: helpCatalog.reasoningByLabel[option.label] ?? [],
    };
  }

  customModels.forEach((entry, index) => {
    const displayName = String(entry.displayName || entry.name || entry.id || entry.model || `Custom Model ${index + 1}`).trim();
    if (!displayName) return;

    const value = `custom:${slugifyFactoryDisplayName(displayName)}-${index}`;
    const supportsImages = typeof entry.supportsImages === 'boolean'
      ? entry.supportsImages
      : entry.noImageSupport === true
        ? false
        : true;

    if (!options.some((option) => option.value === value)) {
      options.push({ value, label: displayName, supportsImages });
    }
    metadata[value] = {
      supportsImages,
    };
  });

  const defaultModel = options.some((option) => option.value === helpCatalog.defaultModel)
    ? helpCatalog.defaultModel
    : FACTORY_MODELS.DEFAULT;

  return { defaultModel, metadata, options };
}

async function loadFactoryModelCatalog(): Promise<FactoryModelCatalog> {
  try {
    const [helpOutput, customModels] = await Promise.all([
      readFactoryHelpOutput(),
      readFactoryCustomModels(),
    ]);
    return mergeFactoryModels(parseFactoryHelpOutput(helpOutput), customModels);
  } catch {
    return buildFallbackCatalog();
  }
}

export async function getFactoryModelCatalog(forceRefresh = false): Promise<FactoryModelCatalog> {
  const now = Date.now();
  if (!forceRefresh && cachedCatalog && now - cachedAt < MODEL_CACHE_TTL_MS) {
    return cachedCatalog;
  }
  if (!forceRefresh && inflightCatalog) {
    return inflightCatalog;
  }

  inflightCatalog = loadFactoryModelCatalog().then((catalog) => {
    cachedCatalog = catalog;
    cachedAt = Date.now();
    inflightCatalog = null;
    return catalog;
  }).catch((error) => {
    inflightCatalog = null;
    throw error;
  });

  return inflightCatalog;
}

export async function getFactoryModels(forceRefresh = false): Promise<SharedModelOption[]> {
  const catalog = await getFactoryModelCatalog(forceRefresh);
  return catalog.options;
}

export async function getFactoryDefaultModel(forceRefresh = false): Promise<string> {
  const catalog = await getFactoryModelCatalog(forceRefresh);
  return catalog.defaultModel;
}

export async function getFactoryModelMetadata(model: string): Promise<FactoryModelMetadata | null> {
  if (!model) return null;
  const catalog = await getFactoryModelCatalog();
  return catalog.metadata[model] ?? null;
}
