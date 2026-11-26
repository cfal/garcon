//! In-memory cache of web build files and their compressed encodings.
//!
//! The original reads every asset from disk and compresses it again on every
//! request; for the largest application chunk that costs tens of milliseconds
//! of CPU per request. Built assets are content-addressed and change only when
//! the build changes, so the front door keeps each file and each encoding it
//! has produced, keyed by path, size, and modification time. A rebuilt file has
//! a new version and replaces its entry. Memory is bounded by `budget`; files
//! that do not fit are served uncached.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use bytes::Bytes;

use crate::compression::Encoding;

/// Identifies one version of a file on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVersion {
    pub path: PathBuf,
    pub len: u64,
    pub modified: Option<SystemTime>,
}

impl FileVersion {
    pub fn of(path: PathBuf, metadata: &std::fs::Metadata) -> Self {
        Self {
            path,
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

struct Entry {
    version: FileVersion,
    contents: Bytes,
    encodings: Vec<(Encoding, Bytes)>,
}

impl Entry {
    fn size(&self) -> usize {
        self.contents.len()
            + self
                .encodings
                .iter()
                .map(|(_, body)| body.len())
                .sum::<usize>()
    }
}

#[derive(Default)]
struct Entries {
    by_path: HashMap<PathBuf, Entry>,
    used: usize,
}

pub struct AssetCache {
    entries: Mutex<Entries>,
    budget: usize,
}

impl AssetCache {
    pub fn new(budget: usize) -> Self {
        Self {
            entries: Mutex::new(Entries::default()),
            budget,
        }
    }

    pub fn contents(&self, version: &FileVersion) -> Option<Bytes> {
        let entries = self.entries.lock().expect("asset cache lock");
        entries
            .by_path
            .get(&version.path)
            .filter(|entry| entry.version == *version)
            .map(|entry| entry.contents.clone())
    }

    pub fn store_contents(&self, version: &FileVersion, contents: &Bytes) {
        let mut entries = self.entries.lock().expect("asset cache lock");
        if let Some(stale) = entries.by_path.remove(&version.path) {
            entries.used -= stale.size();
        }
        if entries.used + contents.len() > self.budget {
            return;
        }
        entries.used += contents.len();
        entries.by_path.insert(
            version.path.clone(),
            Entry {
                version: version.clone(),
                contents: contents.clone(),
                encodings: Vec::new(),
            },
        );
    }

    /// Returns `body` in `encoding`, compressing it only the first time a
    /// cached file version is requested in that encoding.
    pub fn encode(
        &self,
        version: Option<&FileVersion>,
        encoding: Encoding,
        body: &Bytes,
    ) -> std::io::Result<Bytes> {
        let Some(version) = version else {
            return encoding.compress(body);
        };
        {
            let entries = self.entries.lock().expect("asset cache lock");
            if let Some(entry) = entries
                .by_path
                .get(&version.path)
                .filter(|entry| entry.version == *version)
                && let Some((_, encoded)) = entry
                    .encodings
                    .iter()
                    .find(|(cached, _)| *cached == encoding)
            {
                return Ok(encoded.clone());
            }
        }
        // Compresses outside the lock so other requests are not held up.
        let encoded = encoding.compress(body)?;
        let mut entries = self.entries.lock().expect("asset cache lock");
        let Entries { by_path, used } = &mut *entries;
        if *used + encoded.len() <= self.budget
            && let Some(entry) = by_path
                .get_mut(&version.path)
                .filter(|entry| entry.version == *version)
            && !entry
                .encodings
                .iter()
                .any(|(cached, _)| *cached == encoding)
        {
            *used += encoded.len();
            entry.encodings.push((encoding, encoded.clone()));
        }
        Ok(encoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(len: u64) -> FileVersion {
        FileVersion {
            path: PathBuf::from("/build/app.js"),
            len,
            modified: None,
        }
    }

    #[test]
    fn serves_a_version_until_the_file_changes() {
        let cache = AssetCache::new(1 << 20);
        cache.store_contents(&version(5), &Bytes::from_static(b"first"));
        assert_eq!(
            cache.contents(&version(5)),
            Some(Bytes::from_static(b"first"))
        );
        assert_eq!(cache.contents(&version(6)), None);
        cache.store_contents(&version(6), &Bytes::from_static(b"second"));
        assert_eq!(cache.contents(&version(5)), None);
        assert_eq!(
            cache.contents(&version(6)),
            Some(Bytes::from_static(b"second"))
        );
    }

    #[test]
    fn compresses_each_encoding_once_per_version() {
        let cache = AssetCache::new(1 << 20);
        let body = Bytes::from(vec![b'a'; 10_000]);
        cache.store_contents(&version(10_000), &body);
        let first = cache
            .encode(Some(&version(10_000)), Encoding::Gzip, &body)
            .unwrap();
        let second = cache
            .encode(Some(&version(10_000)), Encoding::Gzip, &body)
            .unwrap();
        assert_eq!(
            first.as_ptr(),
            second.as_ptr(),
            "the second request reuses the cached encoding"
        );
        assert_eq!(cache.entries.lock().unwrap().used, body.len() + first.len());
    }

    #[test]
    fn serves_files_beyond_its_budget_uncached() {
        let cache = AssetCache::new(4);
        cache.store_contents(&version(5), &Bytes::from_static(b"large"));
        assert_eq!(cache.contents(&version(5)), None);
        let encoded = cache
            .encode(
                Some(&version(5)),
                Encoding::Gzip,
                &Bytes::from_static(b"large"),
            )
            .unwrap();
        assert!(!encoded.is_empty());
        assert_eq!(cache.entries.lock().unwrap().used, 0);
    }
}
