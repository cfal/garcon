use garcon_agents_common::cli_update::{
    bounded_command::output_lines,
    cli_version::{compare_cli_versions, is_cli_version, parse_cli_version},
    install_resolution::{homebrew_keg_from_command_path, npm_global_prefix_from_command_path},
    latest_version::{parse_homebrew_info_version, parse_npm_view_version},
};
use garcon_cases::{CaseError, replay, text, unknown};
use serde_json::json;

#[test]
fn cli_version_matches_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-version"),
        |name, args| {
            let first = text(name, args.first())?.expect("recorded string");
            Ok(match name {
                "parseCliVersion" => json!(parse_cli_version(first)),
                "isCliVersion" => json!(is_cli_version(first)),
                "compareCliVersions" => {
                    let right = text(name, args.get(1))?.expect("recorded string");
                    match compare_cli_versions(first, right) {
                        Some(result) if result.is_nan() => json!({"$":"number","value":"NaN"}),
                        result => json!(result),
                    }
                }
                _ => return Err(CaseError::unhandled(name)),
            })
        },
    );
}

#[test]
fn latest_version_matches_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/latest-version"),
        |name, args| {
            let output = text(name, args.first())?.expect("recorded output string");
            Ok(match name {
                "parseNpmViewVersion" => json!(parse_npm_view_version(output)),
                "parseHomebrewInfoVersion" => {
                    let cask = unknown(name, args.get(1))?
                        .as_bool()
                        .expect("recorded cask flag");
                    json!(parse_homebrew_info_version(output, cask))
                }
                _ => return Err(CaseError::unhandled(name)),
            })
        },
    );
}

#[test]
fn install_resolution_matches_recorded_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/cli-install-resolution"
        ),
        |name, args| {
            let path = text(name, args.first())?.expect("recorded path");
            Ok(match name {
                "npmGlobalPrefixFromCommandPath" => {
                    let package = text(name, args.get(1))?.expect("recorded package name");
                    json!(npm_global_prefix_from_command_path(path, package))
                }
                "homebrewKegFromCommandPath" => json!(homebrew_keg_from_command_path(path)),
                _ => return Err(CaseError::unhandled(name)),
            })
        },
    );
}

#[test]
fn output_lines_match_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-output-lines"),
        |name, args| {
            if name != "outputLines" {
                return Err(CaseError::unhandled(name));
            }
            Ok(json!(output_lines(
                text(name, args.first())?.expect("recorded output string")
            )))
        },
    );
}
