// Shared contract for slash-command autocomplete in the chat composer.
// Commands are discovered per agent and project; see the server discovery
// path (e.g. server/agents/claude/slash-command-discovery.ts) for sources.

export type SlashCommandSource = 'command' | 'skill';

export interface SlashCommand {
  // The command token without the leading slash, e.g. "compact" or "dogfood".
  name: string;
  source: SlashCommandSource;
}

export interface SlashCommandsResponse {
  commands: SlashCommand[];
}
