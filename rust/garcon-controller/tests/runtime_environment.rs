use std::env::{self, var, var_os};
use std::process::Command;

#[path = "../src/server/runtime_environment.rs"]
mod runtime_environment;

const CONFIG_DIR: &str = "/fixture/controller-config";

fn main() {
    let exe = env::current_exe().unwrap();
    match env::args().nth(1).as_deref() {
        Some("--install") => {
            // SAFETY: this standalone test uses no runtime or test harness threads.
            unsafe { runtime_environment::install(CONFIG_DIR) };
            assert!(
                Command::new(exe)
                    .arg("--observe")
                    .status()
                    .unwrap()
                    .success()
            );
        }
        Some("--observe") => {
            for key in [
                "GARCON_CLI_RUNTIME",
                "GARCON_WORKSPACE",
                "GARCON_WORKSPACE_DIR",
            ] {
                assert!(var_os(key).is_none(), "child inherited {key}");
            }
            assert_eq!(var("GARCON_CONFIG_DIR").as_deref(), Ok(CONFIG_DIR));
            assert_eq!(var("GARCON_RUNTIME").as_deref(), Ok("controller"));
            assert_eq!(
                var("GARCON_PROJECT_BASE_DIR").as_deref(),
                Ok("fixture-project")
            );
        }
        _ => {
            let result = Command::new(exe)
                .arg("--install")
                .env("GARCON_CLI_RUNTIME", "executor")
                .env("GARCON_WORKSPACE", "fixture-workspace")
                .env("GARCON_WORKSPACE_DIR", "fixture-workspace-dir")
                .env("GARCON_CONFIG_DIR", "fixture-inherited-config")
                .env("GARCON_RUNTIME", "worker")
                .env("GARCON_PROJECT_BASE_DIR", "fixture-project")
                .status()
                .unwrap();
            assert!(result.success());
            println!("controller child discovery environment: 1/1 passed");
        }
    }
}
