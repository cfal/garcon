//! Keeps the controller and the executor separate crate graphs (ADR-022).

use std::path::Path;
use std::process::Command;

use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    /// Contracts and primitives either side may use.
    Shared,
    Executor,
    Controller,
    /// The CLI: an HTTP client of the controller.
    Client,
    /// Binaries and tools that compose both sides.
    Composition,
}

fn role(package: &str) -> Option<Role> {
    match package {
        "garcon-base" | "garcon-cases" | "garcon-contract" | "garcon-link" => Some(Role::Shared),
        "garcon-executor" | "garcon-runtime" | "garcon-agents-common" => Some(Role::Executor),
        "garcon-controller" | "garcon-stores" | "garcon-ledger" | "garcon-search"
        | "garcon-chats" | "garcon-execution" | "garcon-http" => Some(Role::Controller),
        "garcon-cli" => Some(Role::Client),
        "garcon-server" | "garcon-bench" => Some(Role::Composition),
        name if name.starts_with("garcon-agent-") => Some(Role::Executor),
        _ => None,
    }
}

fn may_depend_on(from: Role, to: Role) -> bool {
    match from {
        Role::Composition => true,
        Role::Shared | Role::Client => to == Role::Shared,
        Role::Executor => matches!(to, Role::Shared | Role::Executor),
        Role::Controller => matches!(to, Role::Shared | Role::Controller),
    }
}

fn workspace_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the crate lives in the workspace")
}

fn metadata() -> Value {
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--manifest-path",
        ])
        .arg(workspace_root().join("Cargo.toml"))
        .output()
        .expect("cargo metadata runs");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("cargo metadata prints JSON")
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

#[test]
fn every_workspace_crate_has_a_role_and_respects_it() {
    let metadata = metadata();
    let members = strings(&metadata["workspace_members"]);
    let name_of = |id: &str| -> Option<&str> {
        metadata["packages"]
            .as_array()?
            .iter()
            .find(|package| package["id"] == id)?["name"]
            .as_str()
    };
    let mut violations = Vec::new();
    for node in metadata["resolve"]["nodes"]
        .as_array()
        .expect("resolved dependency graph")
    {
        let id = node["id"].as_str().expect("node id");
        if !members.contains(&id) {
            continue;
        }
        let name = name_of(id).expect("workspace member is a package");
        let Some(from) = role(name) else {
            violations.push(format!(
                "{name} has no role; classify it in workspace_structure.rs"
            ));
            continue;
        };
        for dependency in strings(&node["dependencies"]) {
            if !members.contains(&dependency) {
                continue;
            }
            let dependency = name_of(dependency).expect("workspace member is a package");
            if let Some(to) = role(dependency)
                && !may_depend_on(from, to)
            {
                violations.push(format!(
                    "{name} ({from:?}) depends on {dependency} ({to:?})"
                ));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "ADR-022 violations:\n{}",
        violations.join("\n")
    );
}

/// The single-role binaries of ADR-023. The controller's appears with its crate.
const THIN_MAINS: [&str; 2] = [
    "garcon-executor/src/main.rs",
    "garcon-controller/src/main.rs",
];

#[test]
fn single_role_binaries_stay_thin_mains() {
    for path in THIN_MAINS {
        let Ok(main) = std::fs::read_to_string(workspace_root().join(path)) else {
            continue;
        };
        let code_lines = main
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with("//"))
            .count();
        assert!(
            code_lines <= 5,
            "{path} has {code_lines} lines of code; startup belongs in the library"
        );
    }
    assert!(
        workspace_root().join(THIN_MAINS[0]).is_file(),
        "the executor binary is missing"
    );
}
