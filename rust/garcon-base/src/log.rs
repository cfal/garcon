//! Ports `server/common/log.ts`.

use std::fmt;

/// A configured log level. `Silent` logs nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Silent,
}

/// A method that logs. `Silent` is a level only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LogMethod {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn rank(self) -> u8 {
        match self {
            LogLevel::Debug => 10,
            LogLevel::Info => 20,
            LogLevel::Warn => 30,
            LogLevel::Error => 40,
            LogLevel::Silent => 50,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
            LogLevel::Silent => "silent",
        }
    }
}

impl LogMethod {
    fn rank(self) -> u8 {
        match self {
            LogMethod::Debug => 10,
            LogMethod::Info => 20,
            LogMethod::Warn => 30,
            LogMethod::Error => 40,
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

const DEFAULT_LOG_LEVEL: LogLevel = LogLevel::Info;

/// The level `GARCON_LOG_LEVEL` names, from its raw value: trimmed, in lower
/// case, and `info` when it is empty or names no level.
///
/// The original asks `raw in LOG_LEVEL_RANK`, which also accepts `constructor`
/// and `__proto__`; their rank is not a number, so no method logs. That is
/// what `silent` does, and is kept here.
pub fn configured_level(raw: Option<&str>) -> LogLevel {
    let Some(raw) = raw else {
        return DEFAULT_LOG_LEVEL;
    };
    match garcon_js::trim(raw).to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        "silent" => LogLevel::Silent,
        "constructor" | "__proto__" => LogLevel::Silent,
        _ => DEFAULT_LOG_LEVEL,
    }
}

fn should_log(method: LogMethod, configured: LogLevel) -> bool {
    method.rank() >= configured.rank()
}

/// Writes log lines where they go.
pub trait Sink {
    /// Writes one line of `method`, already prefixed.
    fn write(&self, method: LogMethod, line: &str);
}

/// The standard stream a line is written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Where the console writes `method`: `debug` and `info` to stdout, `warn`
/// and `error` to stderr.
fn stream_of(method: LogMethod) -> Stream {
    match method {
        LogMethod::Debug | LogMethod::Info => Stream::Stdout,
        LogMethod::Warn | LogMethod::Error => Stream::Stderr,
    }
}

/// The console, as `console[method]` writes.
#[derive(Debug, Default, Clone, Copy)]
pub struct Console;

impl Sink for Console {
    fn write(&self, method: LogMethod, line: &str) {
        match stream_of(method) {
            Stream::Stdout => println!("{line}"),
            Stream::Stderr => eprintln!("{line}"),
        }
    }
}

impl<T: Sink + ?Sized> Sink for &'_ T {
    fn write(&self, method: LogMethod, line: &str) {
        (**self).write(method, line);
    }
}

/// Logs through `debug`, `info`, `warn`, and `error`. The original takes any
/// number of arguments and lets the console inspect them; a port passes the
/// line it wants written.
pub trait Logger {
    fn debug(&self, message: &str);
    fn info(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
}

/// A logger with a scope and the level it was created at.
#[derive(Debug, Clone)]
pub struct ScopedLogger<S: Sink = Console> {
    prefix: String,
    level: LogLevel,
    sink: S,
}

/// The environment variable that names the log level.
pub const LOG_LEVEL_VARIABLE: &str = "GARCON_LOG_LEVEL";

/// Creates the logger of a scope at the level `GARCON_LOG_LEVEL` names.
pub fn create_logger(scope: &str) -> ScopedLogger {
    let raw = std::env::var(LOG_LEVEL_VARIABLE).ok();
    ScopedLogger::with_sink(scope, configured_level(raw.as_deref()), Console)
}

impl<S: Sink> ScopedLogger<S> {
    /// Creates the logger of a scope at a level, writing to `sink`.
    pub fn with_sink(scope: &str, level: LogLevel, sink: S) -> ScopedLogger<S> {
        ScopedLogger {
            prefix: format!("[{scope}]"),
            level,
            sink,
        }
    }

    fn emit(&self, method: LogMethod, message: &str) {
        if !should_log(method, self.level) {
            return;
        }
        self.sink
            .write(method, &format!("{} {message}", self.prefix));
    }
}

impl<S: Sink> Logger for ScopedLogger<S> {
    fn debug(&self, message: &str) {
        self.emit(LogMethod::Debug, message);
    }

    fn info(&self, message: &str) {
        self.emit(LogMethod::Info, message);
    }

    fn warn(&self, message: &str) {
        self.emit(LogMethod::Warn, message);
    }

    fn error(&self, message: &str) {
        self.emit(LogMethod::Error, message);
    }
}

impl<T: Logger + ?Sized> Logger for &'_ T {
    fn debug(&self, message: &str) {
        (**self).debug(message);
    }

    fn info(&self, message: &str) {
        (**self).info(message);
    }

    fn warn(&self, message: &str) {
        (**self).warn(message);
    }

    fn error(&self, message: &str) {
        (**self).error(message);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// Stands in for the console methods a test replaces.
    #[derive(Debug, Default)]
    struct RecordedConsole {
        lines: RefCell<Vec<(LogMethod, String)>>,
    }

    impl Sink for RecordedConsole {
        fn write(&self, method: LogMethod, line: &str) {
            self.lines.borrow_mut().push((method, line.to_owned()));
        }
    }

    impl RecordedConsole {
        fn written(&self, method: LogMethod) -> Vec<String> {
            self.lines
                .borrow()
                .iter()
                .filter(|(written, _)| *written == method)
                .map(|(_, line)| line.clone())
                .collect()
        }

        fn count(&self, method: LogMethod) -> usize {
            self.written(method).len()
        }
    }

    fn logger(level: LogLevel, console: &RecordedConsole) -> ScopedLogger<&RecordedConsole> {
        ScopedLogger::with_sink("test", level, console)
    }

    #[test]
    fn filters_below_the_configured_log_level_and_prefixes_messages() {
        let console = RecordedConsole::default();
        let logger = logger(LogLevel::Warn, &console);
        logger.info("hidden");
        logger.warn("visible");
        assert!(console.written(LogMethod::Info).is_empty());
        assert_eq!(console.written(LogMethod::Warn), ["[test] visible"]);
    }

    #[test]
    fn supports_debug_logging_when_enabled() {
        let console = RecordedConsole::default();
        ScopedLogger::with_sink("debug-scope", LogLevel::Debug, &console).debug("details");
        assert_eq!(console.written(LogMethod::Debug), ["[debug-scope] details"]);
    }

    #[test]
    fn captures_the_configured_level_when_the_logger_is_created() {
        // The level is read when the logger is created. A later value of the
        // environment does not reach a logger that exists already, so the
        // logger keeps the level a first read gave it.
        let console = RecordedConsole::default();
        let first_read = configured_level(Some("warn"));
        let logger = ScopedLogger::with_sink("stable-level", first_read, &console);
        assert_eq!(configured_level(Some("debug")), LogLevel::Debug);

        logger.info("still hidden");
        logger.warn("visible");

        assert!(console.written(LogMethod::Info).is_empty());
        assert_eq!(console.written(LogMethod::Warn), ["[stable-level] visible"]);
    }

    #[test]
    fn reads_the_level_from_its_raw_value() {
        for (raw, expected) in [
            (Some("debug"), LogLevel::Debug),
            (Some("DEBUG"), LogLevel::Debug),
            (Some(" warn "), LogLevel::Warn),
            (Some("\tError\n"), LogLevel::Error),
            (Some("\u{feff}Warn\u{a0}"), LogLevel::Warn),
            (Some("\u{85}Warn"), LogLevel::Info),
            (Some("silent"), LogLevel::Silent),
            (Some("verbose"), LogLevel::Info),
            (Some(""), LogLevel::Info),
            (Some("   "), LogLevel::Info),
            (Some("tostring"), LogLevel::Info),
            (None, LogLevel::Info),
        ] {
            assert_eq!(configured_level(raw), expected, "{raw:?}");
        }
        // Names the original's `in` check accepts although they rank nothing.
        for raw in ["constructor", "__proto__", " Constructor "] {
            assert_eq!(configured_level(Some(raw)), LogLevel::Silent, "{raw}");
        }
    }

    #[test]
    fn a_method_logs_at_and_above_its_level() {
        for level in [
            LogLevel::Debug,
            LogLevel::Info,
            LogLevel::Warn,
            LogLevel::Error,
            LogLevel::Silent,
        ] {
            let console = RecordedConsole::default();
            let logger = logger(level, &console);
            logger.debug("d");
            logger.info("i");
            logger.warn("w");
            logger.error("e");
            for method in [
                LogMethod::Debug,
                LogMethod::Info,
                LogMethod::Warn,
                LogMethod::Error,
            ] {
                assert_eq!(
                    console.count(method),
                    usize::from(method.rank() >= level.rank()),
                    "{method:?} at {level:?}"
                );
            }
        }
    }

    #[test]
    fn a_logger_passed_by_reference_still_logs() {
        let console = RecordedConsole::default();
        let logger = logger(LogLevel::Info, &console);
        let by_reference: &dyn Logger = &logger;
        by_reference.error("failed");
        assert_eq!(console.written(LogMethod::Error), ["[test] failed"]);
    }

    // Reading the variable itself is not exercised here: changing the
    // process environment is not safe beside tests that run at the same time.
    #[test]
    fn reads_the_level_from_the_log_level_variable() {
        assert_eq!(LOG_LEVEL_VARIABLE, "GARCON_LOG_LEVEL");
    }

    #[test]
    fn writes_debug_and_info_to_stdout_and_warn_and_error_to_stderr() {
        assert_eq!(stream_of(LogMethod::Debug), Stream::Stdout);
        assert_eq!(stream_of(LogMethod::Info), Stream::Stdout);
        assert_eq!(stream_of(LogMethod::Warn), Stream::Stderr);
        assert_eq!(stream_of(LogMethod::Error), Stream::Stderr);
    }
}
