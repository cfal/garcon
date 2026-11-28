use std::{cell::RefCell, collections::HashMap, sync::LazyLock};

use garcon_contract::usage::UsageCategoryCost;
use garcon_js::{Number, trim};
use regress::Regex;
use serde::Serialize;

use super::{
    model_prices::{MODEL_PRICES, ModelPrice},
    usage_record::{UsageRecord, UsageSpeed},
};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricedUsage {
    pub cost_usd: Number,
    pub category_cost_usd: UsageCategoryCost,
    pub cache_savings_usd: Number,
}

thread_local! {
    static RESOLVED_PRICES: RefCell<HashMap<String, Option<&'static ModelPrice>>> = RefCell::new(HashMap::new());
}

pub fn price_table_key(model: &str) -> String {
    static SUFFIXES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
        // INFALLIBLE: These fixed ECMAScript expressions are valid.
        [r"-v\d+(?::\d+)?$", r"-\d{8}$", r"-\d{4}-\d{2}-\d{2}$"]
            .map(|pattern| Regex::with_flags(pattern, "u").expect("version suffix pattern"))
    });
    static CLAUDE_DOTTED: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags(r"(\d)\.(\d)", "u").expect("dotted Claude version pattern")
    });
    let key = trim(model).to_lowercase();
    let key = key.rsplit_once('/').map_or(key.as_str(), |(_, name)| name);
    let key = key.split_once('[').map_or(key, |(name, _)| name);
    let mut key = key.split_once("anthropic.").map_or(key, |(_, name)| name);
    for pattern in SUFFIXES.iter() {
        if let Some(suffix) = pattern.find(key) {
            key = &key[..suffix.start()];
        }
    }
    if !key.starts_with("claude-") {
        return key.into();
    }
    let mut result = key.to_owned();
    for matched in CLAUDE_DOTTED.find_iter(key) {
        let dot = matched.start() + 1;
        result.replace_range(dot..dot + 1, "-");
    }
    result
}

pub fn lookup_model_price(model: &str) -> Option<&'static ModelPrice> {
    RESOLVED_PRICES.with_borrow_mut(|prices| {
        if let Some(price) = prices.get(model) {
            return *price;
        }
        let price = MODEL_PRICES.get(price_table_key(model).as_str());
        if prices.len() >= 1024 {
            prices.clear();
        }
        prices.insert(model.to_owned(), price);
        price
    })
}

fn speed_multiplier(price: &ModelPrice, speed: UsageSpeed) -> Option<f64> {
    match speed {
        UsageSpeed::Standard => Some(1.0),
        UsageSpeed::Fast => Some(price.fast_multiplier.map_or(1.0, |value| value.0)),
        UsageSpeed::Flex => Some(price.flex_multiplier.map_or(1.0, |value| value.0)),
        UsageSpeed::Ultrafast => price.ultrafast_multiplier.map(|value| value.0),
        UsageSpeed::Unknown => None,
    }
}

pub fn price_usage_record(record: &UsageRecord) -> Option<PricedUsage> {
    if record.speed == UsageSpeed::Unknown {
        return None;
    }
    let price = lookup_model_price(&record.model)?;
    let multiplier = speed_multiplier(price, record.speed)?;
    let uncached_input_tokens = record.totals.uncached_input_tokens.0;
    let cached_input_tokens = record.totals.cached_input_tokens.0;
    let cache_write_tokens = record.totals.cache_write_tokens.0;
    let output_tokens = record.totals.output_tokens.0;
    let prompt_tokens = uncached_input_tokens + cached_input_tokens + cache_write_tokens;
    let rates = price
        .long_context
        .filter(|context| prompt_tokens > context.prompt_tokens_above.0)
        .map_or(price.rates, |context| context.rates);
    let scale = multiplier / 1_000_000.0;
    let write_1h = record.cache_write_1h_tokens.0.min(cache_write_tokens);
    let category_cost_usd = UsageCategoryCost {
        input: Number(uncached_input_tokens * rates.input.0 * scale),
        cache_read: Number(cached_input_tokens * rates.cache_read.0 * scale),
        cache_write: Number(
            ((cache_write_tokens - write_1h) * rates.cache_write.0
                + write_1h * rates.cache_write_1h.0)
                * scale,
        ),
        output: Number(output_tokens * rates.output.0 * scale),
    };
    Some(PricedUsage {
        cost_usd: Number(
            category_cost_usd.input.0
                + category_cost_usd.cache_read.0
                + category_cost_usd.cache_write.0
                + category_cost_usd.output.0,
        ),
        category_cost_usd,
        cache_savings_usd: Number(
            cached_input_tokens * (rates.input.0 - rates.cache_read.0) * scale,
        ),
    })
}
