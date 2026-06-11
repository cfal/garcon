// Automatic chat title generation. Runs a one-shot LLM query to
// produce a concise title from the first user prompt, then persists
// via setSessionName (which emits 'session-name-changed' for broadcast).
import { resolveGenerationContext } from '../settings/generation-config-source.ts';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';

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

function normalizeTitle(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// agents: AgentRegistry (for runSingleQuery)
// settings: SettingsStore (for getUiSettings, getChatName, setSessionName)
export async function maybeGenerateChatTitle({ chatId, projectPath, firstPrompt, agents, settings }) {
  if (!firstPrompt?.trim()) return;

  const ui = await settings.getUiSettings();
  const generationContext = await resolveGenerationContext(agents);
  const cfg = resolveEffectiveGenerationConfig({
    persisted: ui?.chatTitle,
    ...generationContext,
  });
  if (!cfg.enabled) return;

  const existing = settings.getChatName(chatId);
  if (existing) return;

  const agentId = cfg.agentId || 'claude';
  const model = cfg.model;
  const prompt = TITLE_GENERATION_PROMPT.replace('{USER_PROMPT}', firstPrompt.trim());

  try {
    const titleRaw = await agents.runSingleQuery(prompt, {
      agentId,
      model,
      cwd: projectPath,
      projectPath,
      permissionMode: 'default',
      thinkingMode: 'none',
      apiProviderId: cfg.apiProviderId,
      modelEndpointId: cfg.modelEndpointId,
      modelProtocol: cfg.modelProtocol,
    });

    const title = normalizeTitle(titleRaw);
    if (!title) return;

    await settings.setSessionName(chatId, title);
  } catch (error) {
    console.warn('chat-title: generation failed:', error.message);
  }
}
