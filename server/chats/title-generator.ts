// Automatic chat title generation. Runs a one-shot LLM query to
// produce a concise title from the first user prompt, then persists
// via setSessionName (which emits 'session-name-changed' for broadcast).
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.ts';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import { DEFAULT_AGENT_ID, type AgentCatalogEntry } from '../../common/agents.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';
import { DomainError } from '../lib/domain-error.js';
import type { ThinkingMode } from '../../common/chat-modes.js';
import {
  createGenerationRequestSignal,
  GENERATION_PROVIDER_TIMEOUT_MS,
} from '../settings/generation-limits.js';

const logger = createLogger('chats:title-generator');

interface TitleGenerationAgents {
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
    getAgentReadinessMap(authByAgent?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  getAgentCatalog?(): Promise<{ agents?: AgentCatalogEntry[] }>;
  runSingleQuery(prompt: string, options: {
    agentId: string;
    model: string;
    cwd: string;
    projectPath: string;
    permissionMode: 'default';
    thinkingMode: ThinkingMode;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
      modelProtocol?: ApiProtocol | null;
      timeoutMs?: number;
      signal?: AbortSignal;
  }): Promise<string>;
}

interface TitleGenerationSettings {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
}

interface MaybeGenerateChatTitleInput {
  chatId: string;
  projectPath: string;
  firstPrompt: string;
  agents: TitleGenerationAgents;
    settings: TitleGenerationSettings;
    signal?: AbortSignal;
}

interface GenerateChatTitleFromMessageInput {
  chatId: string;
  projectPath: string;
  message: string;
  messageSeq?: number;
  agents: TitleGenerationAgents;
    settings: TitleGenerationSettings;
    signal?: AbortSignal;
}

interface RunTitleGenerationInput {
  chatId: string;
  projectPath: string;
  sourceText: string;
  agents: TitleGenerationAgents;
  settings: TitleGenerationSettings;
  requireEnabled: boolean;
  skipExistingTitle: boolean;
    swallowErrors: boolean;
    signal?: AbortSignal;
}

export interface GenerateChatTitleResult {
  chatId: string;
  title: string;
}

export class TitleGenerationError extends DomainError {
  constructor(
    code: 'TITLE_GENERATION_UNAVAILABLE' | 'TITLE_GENERATION_EMPTY' | 'TITLE_GENERATION_FAILED',
    message: string,
    status = 500,
    retryable = false,
  ) {
    super(code, message, status, retryable);
    this.name = 'TitleGenerationError';
  }
}

// Modified from Open WebUI
const TITLE_GENERATION_PROMPT = `### Task:
Generate a concise, 2-5 word title with an emoji summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
- Your entire response must consist solely of the title, without any introductory or concluding text.
- The output must be a single line without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the title, as this will cause direct parsing failure.
### Output:
your concise title here
### Examples:
Stock Market Trends
Perfect Chocolate Chip Recipe
Evolution of Music Streaming
Remote Work Productivity Tips
Artificial Intelligence in Healthcare
Video Game Development Insights
### Chat History:
<chat_history>
{USER_PROMPT}
</chat_history>`;

function normalizeTitle(text: unknown): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function generationSettingsWithoutEnabled(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { enabled: _enabled, ...rest } = value;
  return rest;
}

function hasExplicitGenerationTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.agentId === 'string'
    || typeof value.model === 'string'
    || typeof value.apiProviderId === 'string'
    || typeof value.modelEndpointId === 'string';
}

function titleGenerationUnavailable(): TitleGenerationError {
  return new TitleGenerationError(
    'TITLE_GENERATION_UNAVAILABLE',
    'Title generation is unavailable because no generation model is configured or ready.',
    409,
    false,
  );
}

async function runTitleGeneration({
  chatId,
  projectPath,
  sourceText,
  agents,
  settings,
  requireEnabled,
  skipExistingTitle,
    swallowErrors,
    signal,
  }: RunTitleGenerationInput): Promise<GenerateChatTitleResult | null> {
    const normalizedSource = sourceText?.trim() ?? '';
    if (!normalizedSource) return null;
    const generationSignal = createGenerationRequestSignal(signal);

  try {
    const ui = await settings.getUiSettings();
      const persisted = ui?.chatTitle;
      const generationContext = await resolveGenerationContextForSelection(
        agents,
        persisted,
        generationSignal,
      );
    const cfg = resolveEffectiveGenerationConfig({
      persisted: requireEnabled ? persisted : generationSettingsWithoutEnabled(persisted),
      ...generationContext,
    });

    if (requireEnabled && !cfg.enabled) return null;
    if (!requireEnabled && !cfg.enabled && !hasExplicitGenerationTarget(persisted)) {
      throw titleGenerationUnavailable();
    }
    if (!cfg.agentId || !cfg.model) throw titleGenerationUnavailable();
    if (skipExistingTitle && settings.getChatName(chatId)) return null;

    const prompt = TITLE_GENERATION_PROMPT.replace('{USER_PROMPT}', normalizedSource);
    const titleRaw = await agents.runSingleQuery(prompt, {
      agentId: cfg.agentId || DEFAULT_AGENT_ID,
      model: cfg.model,
      cwd: projectPath,
      projectPath,
      permissionMode: 'default',
      thinkingMode: cfg.thinkingMode,
      apiProviderId: cfg.apiProviderId,
      modelEndpointId: cfg.modelEndpointId,
        modelProtocol: cfg.modelProtocol,
        timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
        signal: generationSignal,
    });

    const title = normalizeTitle(titleRaw);
    if (!title) {
      if (swallowErrors) return null;
      throw new TitleGenerationError(
        'TITLE_GENERATION_EMPTY',
        'Title generation returned an empty title.',
        422,
        true,
      );
    }

    await settings.setSessionName(chatId, title);
    return { chatId, title };
  } catch (error) {
    if (error instanceof TitleGenerationError) {
      if (!swallowErrors) throw error;
      logger.warn('chat-title: generation failed:', errorMessage(error));
      return null;
    }
    if (!swallowErrors) {
      throw new TitleGenerationError(
        'TITLE_GENERATION_FAILED',
        'Title generation failed.',
        502,
        true,
      );
    }
    logger.warn('chat-title: generation failed:', errorMessage(error));
    return null;
  }
}

export async function maybeGenerateChatTitle(input: MaybeGenerateChatTitleInput): Promise<void> {
  await runTitleGeneration({
    chatId: input.chatId,
    projectPath: input.projectPath,
    sourceText: input.firstPrompt,
    agents: input.agents,
    settings: input.settings,
    requireEnabled: true,
    skipExistingTitle: true,
      swallowErrors: true,
      signal: input.signal,
  });
}

export async function generateChatTitleFromMessage({
  chatId,
  projectPath,
  message,
  agents,
    settings,
    signal,
  }: GenerateChatTitleFromMessageInput): Promise<GenerateChatTitleResult> {
  const result = await runTitleGeneration({
    chatId,
    projectPath,
    sourceText: message,
    agents,
    settings,
    requireEnabled: false,
    skipExistingTitle: false,
      swallowErrors: false,
      signal,
  });

  if (!result) {
    throw new TitleGenerationError(
      'TITLE_GENERATION_EMPTY',
      'Title generation needs a non-empty message.',
      400,
      false,
    );
  }

  return result;
}
