//! A recording on disk: `cases.jsonl`, one case per line, and `manifest.json`
//! with the number of cases and the case file's SHA-256.

use std::fs;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

pub struct RecordedCase {
    pub id: String,
    pub function: String,
    pub args: Vec<Value>,
    pub result: Value,
}

pub struct Recording {
    pub module: String,
    pub cases: Vec<RecordedCase>,
}

fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{} not found; run `bun rust/parity/cli.ts unit record`",
                path.display()
            )
        } else {
            format!("{}: {error}", path.display())
        }
    })
}

fn short(digest: &str) -> &str {
    &digest[..digest.len().min(12)]
}

fn parse_case(line: &str) -> Result<RecordedCase, String> {
    let value: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let Some(entries) = value.as_object() else {
        return Err("a case is a JSON object".to_owned());
    };
    let field = |name: &str| entries.get(name);
    let id = match field("id") {
        Some(Value::String(id)) => id.clone(),
        _ => return Err("a case needs a string `id`".to_owned()),
    };
    let function = match field("fn") {
        Some(Value::String(function)) => function.clone(),
        _ => return Err(format!("case {id}: `fn` is not a string")),
    };
    let args = match field("args") {
        Some(Value::Array(args)) => args.clone(),
        _ => return Err(format!("case {id}: `args` is not an array")),
    };
    let Some(result) = field("result") else {
        return Err(format!("case {id}: no `result`"));
    };
    Ok(RecordedCase {
        id,
        function,
        args,
        result: result.clone(),
    })
}

/// Reads a recording and fails when the case file is not the one the manifest
/// was written for.
pub fn read(directory: &Path) -> Result<Recording, String> {
    let cases_path = directory.join("cases.jsonl");
    let cases = read_file(&cases_path)?;
    let manifest: Value = serde_json::from_slice(&read_file(&directory.join("manifest.json"))?)
        .map_err(|error| format!("{}: {error}", directory.join("manifest.json").display()))?;
    let digest: String = Sha256::digest(&cases)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let recorded = manifest
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest.json has no sha256".to_owned())?;
    if !digest.eq_ignore_ascii_case(recorded) {
        return Err(format!(
            "{} is not the recorded file (sha256 {}, manifest {}). A case file is never edited by hand; record again.",
            cases_path.display(),
            short(&digest),
            short(recorded),
        ));
    }
    let text =
        String::from_utf8(cases).map_err(|error| format!("{}: {error}", cases_path.display()))?;
    let mut parsed = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        parsed.push(
            parse_case(line)
                .map_err(|error| format!("{}:{}: {error}", cases_path.display(), index + 1))?,
        );
    }
    let module = manifest
        .get("module")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest.json has no module".to_owned())?
        .to_owned();
    let counted = manifest.get("cases").and_then(Value::as_u64);
    if counted != Some(parsed.len() as u64) {
        return Err(format!(
            "{}: {} cases, manifest {}",
            cases_path.display(),
            parsed.len(),
            counted.map_or_else(|| "?".to_owned(), |count| count.to_string())
        ));
    }
    Ok(Recording {
        module,
        cases: parsed,
    })
}
