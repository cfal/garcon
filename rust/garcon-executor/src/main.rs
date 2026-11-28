//! Controller-free executor binary (ADR-022). Startup lives in the library.

fn main() -> std::process::ExitCode {
    garcon_executor::cli::run(std::env::args().skip(1).collect())
}
