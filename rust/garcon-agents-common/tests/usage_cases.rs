use garcon_agents_common::usage::{
    model_prices::MODEL_PRICES,
    usage_aggregator::UsageAggregator,
    usage_pricing::{lookup_model_price, price_table_key, price_usage_record},
    usage_record::{
        NativeUsageTokenTotals, UsageRecord, UsageSpeed, merge_usage_copies, parse_timestamp_ms,
        token_count,
    },
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::usage::UsageReadRequest;
use garcon_interface::errors::AgentIntegrationError;
use garcon_js::{Number, date_parse::date_parse, json::from_slice};
use serde::Serialize;
use serde_json::{Value, json};

fn wire<T: Serialize>(value: T) -> Value {
    from_slice(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn record(function: &str, arg: Option<&Value>) -> Result<UsageRecord, CaseError> {
    let mut value = unknown(function, arg)?.into_owned();
    let timestamp_ms = value["timestampMs"]
        .as_f64()
        .expect("recorded usage timestamp");
    value["timestampMs"] = Value::from(timestamp_ms as i64);
    Ok(serde_json::from_value(value).expect("recorded usage record"))
}

#[test]
fn usage_pricing_matches_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-pricing"),
        |function, args| {
            Ok(match function {
                "priceTableKey" => wire(price_table_key(
                    text(function, args.first())?.expect("recorded model"),
                )),
                "lookupModelPrice" => wire(lookup_model_price(
                    text(function, args.first())?.expect("recorded model"),
                )),
                "priceUsageRecord" => wire(price_usage_record(&record(function, args.first())?)),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn usage_records_match_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-record"),
        |function, args| {
            Ok(match function {
                "tokenCount" => wire(Number(token_count(
                    unknown(function, args.first())?.as_ref(),
                ))),
                "parseTimestampMs" => wire(parse_timestamp_ms(
                    unknown(function, args.first())?.as_ref(),
                )),
                "mergeUsageCopies" => wire(merge_usage_copies(
                    &record(function, args.first())?,
                    &record(function, args.get(1))?,
                )),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn published_rates_are_non_negative_and_finite() {
    use garcon_agents_common::usage::model_prices::TokenRates;
    for (model, price) in MODEL_PRICES.iter() {
        let tiers = [Some(price.rates), price.long_context.map(|tier| tier.rates)];
        for TokenRates {
            input,
            output,
            cache_read,
            cache_write,
            cache_write_1h,
        } in tiers.into_iter().flatten()
        {
            for value in [input, output, cache_read, cache_write, cache_write_1h] {
                assert!(value.0.is_finite() && value.0 >= 0.0, "{model}");
            }
            assert!(cache_read.0 <= input.0, "{model}");
        }
    }
}

#[test]
fn model_price_table_matches_recording() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/usage-model-prices"
        ),
        |function, _| {
            if function != "modelPrices" {
                return Err(CaseError::unhandled(function));
            }
            Ok(wire(&*MODEL_PRICES))
        },
    );
}

#[test]
fn usage_aggregate_counts_match_the_wire_boundary() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-aggregation"),
        |function, args| {
            if function != "aggregateUsage" {
                return Err(CaseError::unhandled(function));
            }
            let model = text(function, args.first())?.expect("recorded model");
            let counts: Vec<[f64; 2]> =
                serde_json::from_value(unknown(function, args.get(1))?.into_owned()).unwrap();
            let mut usage = UsageAggregator::new(UsageReadRequest {
                since_day: "2026-10-01".into(),
                until_day: "2026-10-31".into(),
                time_zone: "UTC".into(),
            })
            .unwrap();
            for [input, output] in counts {
                usage.add(&UsageRecord {
                    timestamp_ms: date_parse("2026-10-10T00:00:00Z").unwrap(),
                    model: model.into(),
                    session_id: "session".into(),
                    totals: NativeUsageTokenTotals {
                        uncached_input_tokens: Number(input),
                        cached_input_tokens: Number(0.0),
                        cache_write_tokens: Number(0.0),
                        output_tokens: Number(output),
                        reasoning_tokens: Number(0.0),
                    },
                    cache_write_1h_tokens: Number(0.0),
                    speed: UsageSpeed::Standard,
                    dedupe_key: None,
                });
            }
            Ok(
                match runtime.block_on(async {
                    usage
                        .finish(&mut EventLoopSteps::new("usage-aggregation-test"), None)
                        .await
                }) {
                    Ok(result) => wire(result),
                    Err(error) => {
                        let error = error
                            .downcast_ref::<AgentIntegrationError>()
                            .expect("typed usage report error");
                        json!({"$":"error","name":"AgentIntegrationError","message":error.message,
                    "properties":{"code":error.code.as_str(),"retryable":error.retryable}})
                    }
                },
            )
        },
    );
}
