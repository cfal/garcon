//! Append-only line logs the verification harnesses read: the fallback log
//! (`GARCON_RS_FALLBACK_LOG`) and the shadow log (`GARCON_RS_SHADOW_LOG`).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

pub struct LineLog(Mutex<File>);

impl LineLog {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self(Mutex::new(
            OpenOptions::new().create(true).append(true).open(path)?,
        )))
    }

    /// Appends `line` and a newline in one write, so concurrent lines never
    /// interleave.
    pub fn record(&self, line: &str) {
        let mut entry = String::with_capacity(line.len() + 1);
        entry.push_str(line);
        entry.push('\n');
        let _ = self
            .0
            .lock()
            .expect("line log lock")
            .write_all(entry.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_one_line_per_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        let log = LineLog::open(&path).unwrap();
        log.record("first");
        log.record("second");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    }
}
