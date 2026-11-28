use garcon_base::executor_path::{to_executor_path, to_native_path};
use garcon_cases::{CaseError, replay, text};
use serde_json::{Value, json};

#[test]
fn executor_path_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/executor-path"
        ),
        |function, args| {
            let path =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            let separator = args.get(1).and_then(Value::as_str);
            match function {
                "toExecutorPath" => Ok(json!(to_executor_path(path, separator))),
                "toNativePath" => Ok(json!(to_native_path(path, separator))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
    assert_eq!(stats.passed, stats.total);
}
