// Provider adapter interface. Defines the contract for all execution
// provider adapters so the registry can route operations without
// per-provider branching.

import type { ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from './types.js';

export interface ProviderAdapter {
  id: string;
  label: string;
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  isRunning(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  runSingleQuery?(prompt: string, options?: Record<string, unknown>): Promise<string>;
  loadMessages?(session: unknown): Promise<unknown[]>;
  getPreview?(session: unknown): Promise<unknown>;
  startPurgeTimer?(): ReturnType<typeof setInterval>;
  shutdown?(): void;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}
