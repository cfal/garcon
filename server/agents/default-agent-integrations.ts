import ClaudeAgentIntegration from '@garcon/server-agent-claude';
import CodexAgentIntegration from '@garcon/server-agent-codex';
import CursorAgentIntegration from '@garcon/server-agent-cursor';
import OpenCodeAgentIntegration from '@garcon/server-agent-opencode';
import AmpAgentIntegration from '@garcon/server-agent-amp';
import FactoryAgentIntegration from '@garcon/server-agent-factory';
import PiAgentIntegration from '@garcon/server-agent-pi';
import DirectOpenAiCompatibleIntegration from '@garcon/server-agent-direct-openai-compatible';
import DirectOpenAiResponsesCompatibleIntegration from '@garcon/server-agent-direct-openai-responses-compatible';
import DirectAnthropicCompatibleIntegration from '@garcon/server-agent-direct-anthropic-compatible';
import type { AgentIntegrationClass } from '@garcon/server-agent-interface';

export const defaultAgentIntegrations = [
  ClaudeAgentIntegration,
  CodexAgentIntegration,
  DirectOpenAiResponsesCompatibleIntegration,
  DirectOpenAiCompatibleIntegration,
  DirectAnthropicCompatibleIntegration,
  OpenCodeAgentIntegration,
  AmpAgentIntegration,
  CursorAgentIntegration,
  FactoryAgentIntegration,
  PiAgentIntegration,
] satisfies readonly AgentIntegrationClass[];
