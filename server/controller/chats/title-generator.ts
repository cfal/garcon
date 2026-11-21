import { resolveTitleModelQuery, type TitleModelAgents, type TitleModelUse } from '../settings/title-model.js';
import { createLogger } from '../../common/log.js';
import { errorMessage } from '../../common/errors.js';
import { DomainError } from '../../common/domain-error.js';
import type { RecentTitleIconSource } from './recent-title-icons.js';

const logger = createLogger('chats:title-generator');
const TITLE_GENERATION_SOURCE_MAX_CHARS = 32_000;

interface TitleGenerationSettings {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean>;
}

interface TitleGenerationContext {
  chatId: string;
  agents: TitleModelAgents;
  settings: TitleGenerationSettings;
  recentTitleIcons: RecentTitleIconSource;
  signal?: AbortSignal;
}

interface GenerateChatTitleFromMessageInput extends TitleGenerationContext {
  message: string;
  messageSeq?: number;
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
Generate a concise, 2-5 word title with a leading emoji icon summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Prefer a specific subject-related emoji over a generic emoji.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
- Your entire response must consist solely of the title, without any introductory or concluding text.
- The output must be a single line without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the title, as this will cause direct parsing failure.
### Examples:
📈 Stock Market Trends
🍪 Perfect Chocolate Chip Recipe
🎵 Evolution of Music Streaming
🏠 Remote Work Productivity Tips
🩺 Artificial Intelligence in Healthcare
🎮 Video Game Development Insights
### Recently Used Emojis to Avoid When Another Accurate Emoji Is Available:
{RECENT_TITLE_ICONS}
### Chat History:
<chat_history>
{USER_PROMPT}
</chat_history>`;

function buildTitleGenerationPrompt(
  sourceText: string,
  recentTitleIcons: RecentTitleIconSource,
): string {
  const recentIcons = recentTitleIcons.getRecentIcons();
  return TITLE_GENERATION_PROMPT
    .replace(
      '{RECENT_TITLE_ICONS}',
      () => recentIcons.length > 0 ? recentIcons.join(' ') : 'None',
    )
    .replace('{USER_PROMPT}', () => sourceText);
}

function normalizeTitle(text: unknown): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function titleGenerationUnavailable(): TitleGenerationError {
  return new TitleGenerationError(
    'TITLE_GENERATION_UNAVAILABLE',
    'Title generation is unavailable because no generation model is configured or ready.',
    409,
    false,
  );
}

async function runTitleGeneration(
  { chatId, agents, settings, recentTitleIcons, signal }: TitleGenerationContext,
  sourceText: string,
  use: TitleModelUse,
): Promise<GenerateChatTitleResult | null> {
  const normalizedSource = (sourceText?.trim() ?? '').slice(0, TITLE_GENERATION_SOURCE_MAX_CHARS);
  if (!normalizedSource) return null;
  try {
    const ui = await settings.getUiSettings();
    const query = await resolveTitleModelQuery(agents, ui?.chatTitle, use, signal);
    if (!query) {
      if (use === 'automatic') return null;
      throw titleGenerationUnavailable();
    }
    if (use === 'automatic' && settings.getChatName(chatId)) return null;

    const prompt = buildTitleGenerationPrompt(normalizedSource, recentTitleIcons);
    const titleRaw = await agents.runSingleQuery(prompt, query);

    const title = normalizeTitle(titleRaw);
    if (!title) {
      if (use === 'automatic') return null;
      throw new TitleGenerationError(
        'TITLE_GENERATION_EMPTY',
        'Title generation returned an empty title.',
        422,
        true,
      );
    }

    if (use === 'automatic') {
      const persisted = await settings.setSessionNameIfAbsent(chatId, title);
      return persisted ? { chatId, title } : null;
    }
    await settings.setSessionName(chatId, title);
    return { chatId, title };
  } catch (error) {
    if (use === 'automatic') {
      logger.warn('chat-title: generation failed:', errorMessage(error));
      return null;
    }
    if (error instanceof TitleGenerationError) throw error;
    throw new TitleGenerationError('TITLE_GENERATION_FAILED', 'Title generation failed.', 502, true);
  }
}

export async function maybeGenerateChatTitle(input: TitleGenerationContext & { firstPrompt: string }): Promise<void> {
  await runTitleGeneration(input, input.firstPrompt, 'automatic');
}

export async function generateChatTitleFromMessage(input: GenerateChatTitleFromMessageInput): Promise<GenerateChatTitleResult> {
  const result = await runTitleGeneration(input, input.message, 'on-demand');
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
