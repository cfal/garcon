import { createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { SharedModelOption } from '@garcon/common/models';
import { piModelToOption } from './pi-model-option.js';

function diagnosticMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (record.error instanceof Error) return record.error.message;
    if (record.error !== undefined) return String(record.error);
  }
  return String(value);
}

interface PiDiagnosticServices {
  diagnostics?: unknown[];
  modelRuntime?: { getError?: () => unknown };
  settingsManager?: { drainErrors?: () => unknown[] };
}

function collectPiDiscoveryDiagnostics(services: PiDiagnosticServices): string[] {
  const diagnostics: string[] = [];
  const modelRuntimeError = typeof services?.modelRuntime?.getError === 'function'
    ? services.modelRuntime.getError()
    : undefined;
  if (modelRuntimeError) diagnostics.push(`model runtime: ${diagnosticMessage(modelRuntimeError)}`);
  if (Array.isArray(services?.diagnostics)) {
    for (const diagnostic of services.diagnostics) {
      const message = diagnosticMessage(diagnostic);
      if (message) diagnostics.push(message);
    }
  }
  const settingsErrors = typeof services?.settingsManager?.drainErrors === 'function'
    ? services.settingsManager.drainErrors()
    : [];
  for (const error of settingsErrors) diagnostics.push(`settings: ${diagnosticMessage(error)}`);
  return diagnostics;
}

export async function readPiModelsFromSdk(signal: AbortSignal): Promise<SharedModelOption[]> {
  signal.throwIfAborted();
  const services = await createAgentSessionServices({ cwd: process.cwd(), agentDir: getAgentDir() });
  signal.throwIfAborted();
  const available = await services.modelRuntime.getAvailable();
  signal.throwIfAborted();
  const models = available.map(piModelToOption).filter((model): model is SharedModelOption => model !== null);
  const diagnostics = collectPiDiscoveryDiagnostics(services);
  if (models.length === 0 && diagnostics.length > 0) throw new Error(diagnostics.join('; '));
  return models;
}
