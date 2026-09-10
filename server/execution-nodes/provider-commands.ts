import type { SlashCommand } from '../../common/slash-commands.js';

export interface ProviderCommandsRequest {
  readonly projectPath: string;
}

export interface ProviderCommandsService {
  discover(request: ProviderCommandsRequest, signal: AbortSignal): Promise<readonly SlashCommand[]>;
}
