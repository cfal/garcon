// Built-in list prices in USD per million tokens. Anthropic rates follow
// https://platform.claude.com/docs/en/about-claude/pricing; OpenAI rates follow
// LiteLLM's model_prices_and_context_window.json. Both were read on this date.
// Models missing here are reported as unpriced, never as free.
export const USAGE_PRICING_AS_OF = '2026-10-27';

export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  // Five-minute cache writes; OpenAI has a single cache-write rate.
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
}

export interface ModelPrice {
  readonly rates: TokenRates;
  // Anthropic fast mode and OpenAI priority processing bill every category at this multiple.
  readonly fastMultiplier: number | null;
  // A request whose prompt, including cache reads and writes, exceeds the threshold bills at these rates.
  readonly longContext: { readonly promptTokensAbove: number; readonly rates: TokenRates } | null;
}

interface PriceOptions {
  readonly fast?: number;
  readonly longContext?: { readonly promptTokensAbove: number; readonly rates: TokenRates };
}

// Anthropic writes cost 1.25x input for five minutes and 2x for one hour; cache reads vary by model.
function anthropicRates(input: number, output: number, cacheRead: number): TokenRates {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 };
}

function anthropic(input: number, output: number, cacheRead: number, options: PriceOptions = {}): ModelPrice {
  return {
    rates: anthropicRates(input, output, cacheRead),
    fastMultiplier: options.fast ?? null,
    longContext: options.longContext ?? null,
  };
}

// OpenAI bills cache writes at input price unless the model lists a separate rate.
function openAiRates(input: number, output: number, cacheRead: number, cacheWrite = input): TokenRates {
  return { input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite };
}

function openAi(rates: TokenRates, options: PriceOptions = {}): ModelPrice {
  return { rates, fastMultiplier: options.fast ?? null, longContext: options.longContext ?? null };
}

// Codex models above 272K prompt tokens bill 2x input and cache, 1.5x output.
function openAiLongContext(rates: TokenRates): PriceOptions['longContext'] {
  return {
    promptTokensAbove: 272_000,
    rates: {
      input: rates.input * 2,
      output: rates.output * 1.5,
      cacheRead: rates.cacheRead * 2,
      cacheWrite: rates.cacheWrite * 2,
      cacheWrite1h: rates.cacheWrite1h * 2,
    },
  };
}

function openAiWithLongContext(rates: TokenRates, fast: number): ModelPrice {
  return openAi(rates, { fast, longContext: openAiLongContext(rates) });
}

export const MODEL_PRICES: ReadonlyMap<string, ModelPrice> = new Map<string, ModelPrice>([
  ['claude-fable-5-1', anthropic(10, 50, 0.25)],
  ['claude-mythos-5-1', anthropic(10, 50, 0.25)],
  ['claude-fable-5', anthropic(10, 50, 1)],
  ['claude-mythos-5', anthropic(10, 50, 1)],
  ['claude-mythos-preview', anthropic(10, 50, 1)],
  ['claude-opus-5-5', anthropic(4, 20, 0.2, { fast: 2 })],
  ['claude-opus-5', anthropic(5, 25, 0.5, { fast: 2 })],
  ['claude-opus-4-8', anthropic(5, 25, 0.5, { fast: 2 })],
  ['claude-opus-4-7', anthropic(5, 25, 0.5)],
  ['claude-opus-4-6', anthropic(5, 25, 0.5)],
  ['claude-opus-4-5', anthropic(5, 25, 0.5)],
  ['claude-opus-4-1', anthropic(15, 75, 1.5)],
  ['claude-opus-4', anthropic(15, 75, 1.5)],
  ['claude-opus-4-0', anthropic(15, 75, 1.5)],
  ['claude-sonnet-5-5', anthropic(2, 10, 0.1)],
  ['claude-sonnet-5', anthropic(2, 10, 0.2)],
  ['claude-sonnet-4-6', anthropic(3, 15, 0.3)],
  ['claude-sonnet-4-5', anthropic(3, 15, 0.3)],
  ['claude-sonnet-4', anthropic(3, 15, 0.3)],
  ['claude-sonnet-4-0', anthropic(3, 15, 0.3)],
  ['claude-haiku-5-5', anthropic(0.1, 0.5, 0.01, {
    longContext: { promptTokensAbove: 100_000, rates: anthropicRates(0.5, 2.5, 0.05) },
  })],
  ['claude-haiku-4-5', anthropic(1, 5, 0.1)],
  ['gpt-6-astra', openAiWithLongContext(openAiRates(10, 50, 1, 12.5), 2)],
  ['gpt-6-sol', openAiWithLongContext(openAiRates(2, 10, 0.2, 2.5), 2)],
  ['gpt-6-luna', openAiWithLongContext(openAiRates(0.1, 0.5, 0.01, 0.125), 2)],
  ['gpt-6.1-sol', openAiWithLongContext(openAiRates(2, 10, 0.1, 2.5), 2)],
  ['gpt-6.1-terra', openAiWithLongContext(openAiRates(1, 5, 0.05, 1.25), 2)],
  ['gpt-5.6', openAiWithLongContext(openAiRates(4, 20, 0.4, 5), 2)],
  ['gpt-5.6-sol', openAiWithLongContext(openAiRates(4, 20, 0.4, 5), 2)],
  ['gpt-5.6-terra', openAiWithLongContext(openAiRates(2, 12, 0.2, 2.5), 2)],
  ['gpt-5.6-luna', openAiWithLongContext(openAiRates(0.2, 1.2, 0.02, 0.25), 2)],
  ['gpt-5.5', openAiWithLongContext(openAiRates(5, 30, 0.5), 2.5)],
  ['gpt-5.4', openAiWithLongContext(openAiRates(2.5, 15, 0.25), 2)],
  ['gpt-5.4-mini', openAi(openAiRates(0.75, 4.5, 0.075), { fast: 2 })],
  ['gpt-5.4-nano', openAi(openAiRates(0.2, 1.25, 0.02))],
  ['gpt-5.3-codex', openAi(openAiRates(1.75, 14, 0.175), { fast: 2 })],
  ['gpt-5.2', openAi(openAiRates(1.75, 14, 0.175), { fast: 2 })],
  ['gpt-5.2-codex', openAi(openAiRates(1.75, 14, 0.175))],
  ['gpt-5.1', openAi(openAiRates(1.25, 10, 0.125))],
  ['gpt-5.1-codex', openAi(openAiRates(1.25, 10, 0.125))],
  ['gpt-5.1-codex-max', openAi(openAiRates(1.25, 10, 0.125))],
  ['gpt-5.1-codex-mini', openAi(openAiRates(0.25, 2, 0.025))],
  ['gpt-5', openAi(openAiRates(1.25, 10, 0.125), { fast: 2 })],
  ['gpt-5-codex', openAi(openAiRates(1.25, 10, 0.125))],
  ['gpt-5-mini', openAi(openAiRates(0.25, 2, 0.025))],
  ['gpt-5-nano', openAi(openAiRates(0.05, 0.4, 0.005))],
]);
