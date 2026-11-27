//! Executor startup arguments. Ports `server/remote/worker-cli.ts`.

use std::process::ExitCode;

/// Runs the executor with the arguments that follow the program name or the
/// `executor` subcommand.
pub fn run(arguments: Vec<String>) -> ExitCode {
    let _ = arguments;
    eprintln!("The native executor is not ported yet (rust/MAP.md, unit worker).");
    ExitCode::FAILURE
}
