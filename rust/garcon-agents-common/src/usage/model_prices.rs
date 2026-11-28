use std::sync::LazyLock;

use garcon_js::Number;
use indexmap::IndexMap;
use serde::Serialize;

pub const USAGE_PRICING_AS_OF: &str = "2026-11-20";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRates {
    pub input: Number,
    pub output: Number,
    pub cache_read: Number,
    pub cache_write: Number,
    #[serde(rename = "cacheWrite1h")]
    pub cache_write_1h: Number,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub rates: TokenRates,
    pub fast_multiplier: Option<Number>,
    pub flex_multiplier: Option<Number>,
    pub long_context: Option<LongContextPrice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ultrafast_multiplier: Option<Number>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongContextPrice {
    pub prompt_tokens_above: Number,
    pub rates: TokenRates,
}

#[derive(Default)]
struct PriceOptions {
    fast: Option<Number>,
    flex: Option<Number>,
    long_context: Option<LongContextPrice>,
}

fn anthropic_rates(input: f64, output: f64, cache_read: f64) -> TokenRates {
    TokenRates {
        input: Number(input),
        output: Number(output),
        cache_read: Number(cache_read),
        cache_write: Number(input * 1.25),
        cache_write_1h: Number(input * 2.0),
    }
}

fn anthropic(input: f64, output: f64, cache_read: f64, options: PriceOptions) -> ModelPrice {
    ModelPrice {
        rates: anthropic_rates(input, output, cache_read),
        fast_multiplier: options.fast,
        flex_multiplier: None,
        long_context: options.long_context,
        ultrafast_multiplier: None,
    }
}

fn open_ai_rates(input: f64, output: f64, cache_read: f64, cache_write: Option<f64>) -> TokenRates {
    let cache_write = Number(cache_write.unwrap_or(input));
    TokenRates {
        input: Number(input),
        output: Number(output),
        cache_read: Number(cache_read),
        cache_write,
        cache_write_1h: cache_write,
    }
}

fn open_ai(rates: TokenRates, options: PriceOptions) -> ModelPrice {
    ModelPrice {
        rates,
        fast_multiplier: options.fast,
        flex_multiplier: options.flex,
        long_context: options.long_context,
        ultrafast_multiplier: None,
    }
}

fn open_ai_long_context(rates: TokenRates) -> LongContextPrice {
    LongContextPrice {
        prompt_tokens_above: Number(272_000.0),
        rates: TokenRates {
            input: Number(rates.input.0 * 2.0),
            output: Number(rates.output.0 * 1.5),
            cache_read: Number(rates.cache_read.0 * 2.0),
            cache_write: Number(rates.cache_write.0 * 2.0),
            cache_write_1h: Number(rates.cache_write_1h.0 * 2.0),
        },
    }
}

fn open_ai_with_long_context(rates: TokenRates, fast: f64) -> ModelPrice {
    open_ai(
        rates,
        PriceOptions {
            fast: Some(Number(fast)),
            flex: Some(Number(0.5)),
            long_context: Some(open_ai_long_context(rates)),
        },
    )
}

fn ultrafast_model(rates: TokenRates, flex: Option<f64>) -> ModelPrice {
    ModelPrice {
        ultrafast_multiplier: Some(Number(6.0)),
        ..open_ai(
            rates,
            PriceOptions {
                fast: Some(Number(2.0)),
                flex: flex.map(Number),
                long_context: Some(open_ai_long_context(rates)),
            },
        )
    }
}

pub static MODEL_PRICES: LazyLock<IndexMap<&'static str, ModelPrice>> = LazyLock::new(|| {
    let claude = |input, output, read| anthropic(input, output, read, PriceOptions::default());
    let claude_fast = |input, output, read| {
        anthropic(
            input,
            output,
            read,
            PriceOptions {
                fast: Some(Number(2.0)),
                ..Default::default()
            },
        )
    };
    let gpt = |input, output, read| {
        open_ai(
            open_ai_rates(input, output, read, None),
            PriceOptions::default(),
        )
    };
    let gpt_fast = |input, output, read| {
        open_ai(
            open_ai_rates(input, output, read, None),
            PriceOptions {
                fast: Some(Number(2.0)),
                ..Default::default()
            },
        )
    };
    let gpt_long = |input, output, read, write| {
        open_ai_with_long_context(open_ai_rates(input, output, read, Some(write)), 2.0)
    };
    IndexMap::from([
        ("claude-fable-5-1", claude(10.0, 50.0, 0.25)),
        ("claude-mythos-5-1", claude(10.0, 50.0, 0.25)),
        ("claude-fable-5", claude(10.0, 50.0, 1.0)),
        ("claude-mythos-5", claude(10.0, 50.0, 1.0)),
        ("claude-mythos-preview", claude(10.0, 50.0, 1.0)),
        ("claude-opus-5-5", claude_fast(4.0, 20.0, 0.2)),
        ("claude-opus-5", claude_fast(5.0, 25.0, 0.5)),
        ("claude-opus-4-8", claude_fast(5.0, 25.0, 0.5)),
        ("claude-opus-4-7", claude(5.0, 25.0, 0.5)),
        ("claude-opus-4-6", claude(5.0, 25.0, 0.5)),
        ("claude-opus-4-5", claude(5.0, 25.0, 0.5)),
        ("claude-opus-4-1", claude(15.0, 75.0, 1.5)),
        ("claude-opus-4", claude(15.0, 75.0, 1.5)),
        ("claude-opus-4-0", claude(15.0, 75.0, 1.5)),
        ("claude-sonnet-5-5", claude(2.0, 10.0, 0.1)),
        ("claude-sonnet-5", claude(2.0, 10.0, 0.2)),
        ("claude-sonnet-4-6", claude(3.0, 15.0, 0.3)),
        ("claude-sonnet-4-5", claude(3.0, 15.0, 0.3)),
        ("claude-sonnet-4", claude(3.0, 15.0, 0.3)),
        ("claude-sonnet-4-0", claude(3.0, 15.0, 0.3)),
        (
            "claude-haiku-5-5",
            anthropic(
                0.1,
                0.5,
                0.01,
                PriceOptions {
                    long_context: Some(LongContextPrice {
                        prompt_tokens_above: Number(100_000.0),
                        rates: anthropic_rates(0.5, 2.5, 0.05),
                    }),
                    ..Default::default()
                },
            ),
        ),
        ("claude-haiku-4-5", claude(1.0, 5.0, 0.1)),
        (
            "gpt-6.2-astra",
            ultrafast_model(open_ai_rates(8.0, 40.0, 0.4, Some(10.0)), None),
        ),
        (
            "gpt-6.2-sol",
            ultrafast_model(open_ai_rates(2.0, 10.0, 0.1, Some(2.5)), None),
        ),
        (
            "gpt-6-astra",
            ultrafast_model(open_ai_rates(10.0, 50.0, 1.0, Some(12.5)), Some(0.5)),
        ),
        ("gpt-6-sol", gpt_long(2.0, 10.0, 0.2, 2.5)),
        ("gpt-6-luna", gpt_long(0.1, 0.5, 0.01, 0.125)),
        (
            "gpt-6.1-sol",
            ultrafast_model(open_ai_rates(2.0, 10.0, 0.1, Some(2.5)), Some(0.5)),
        ),
        ("gpt-6.1-terra", gpt_long(1.0, 5.0, 0.05, 1.25)),
        ("gpt-5.6", gpt_long(4.0, 20.0, 0.4, 5.0)),
        ("gpt-5.6-sol", gpt_long(4.0, 20.0, 0.4, 5.0)),
        ("gpt-5.6-terra", gpt_long(2.0, 12.0, 0.2, 2.5)),
        ("gpt-5.6-luna", gpt_long(0.2, 1.2, 0.02, 0.25)),
        (
            "gpt-5.5",
            open_ai_with_long_context(open_ai_rates(5.0, 30.0, 0.5, None), 2.5),
        ),
        (
            "gpt-5.4",
            open_ai_with_long_context(open_ai_rates(2.5, 15.0, 0.25, None), 2.0),
        ),
        (
            "gpt-5.4-mini",
            open_ai(
                open_ai_rates(0.75, 4.5, 0.075, None),
                PriceOptions {
                    fast: Some(Number(2.0)),
                    flex: Some(Number(0.5)),
                    long_context: None,
                },
            ),
        ),
        ("gpt-5.4-nano", gpt(0.2, 1.25, 0.02)),
        ("gpt-5.3-codex", gpt_fast(1.75, 14.0, 0.175)),
        ("gpt-5.2", gpt_fast(1.75, 14.0, 0.175)),
        ("gpt-5.2-codex", gpt(1.75, 14.0, 0.175)),
        ("gpt-5.1", gpt(1.25, 10.0, 0.125)),
        ("gpt-5.1-codex", gpt(1.25, 10.0, 0.125)),
        ("gpt-5.1-codex-max", gpt(1.25, 10.0, 0.125)),
        ("gpt-5.1-codex-mini", gpt(0.25, 2.0, 0.025)),
        ("gpt-5", gpt_fast(1.25, 10.0, 0.125)),
        ("gpt-5-codex", gpt(1.25, 10.0, 0.125)),
        ("gpt-5-mini", gpt(0.25, 2.0, 0.025)),
        ("gpt-5-nano", gpt(0.05, 0.4, 0.005)),
    ])
});
