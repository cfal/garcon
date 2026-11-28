//! In-memory cache of web build files and their compressed encodings.
//!
//! The original reads every asset from disk and compresses it again on every
//! request; for the largest application chunk that costs tens of milliseconds
//! of CPU per request. Built assets are content-addressed and change only when
//! the build changes, so the front door keeps each file and each encoding it
//! has produced, keyed by path, size, and modification time. A rebuilt file has
//! a new version and replaces its entry. Memory is bounded by `budget`: the
//! least recently used entries make room for new ones, so files of an earlier
//! build that are no longer requested do not hold the budget, and files larger
//! than the whole budget are served uncached.

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
    last_used: u64,
}

impl Entry {
    fn encoded(&self, encoding: Encoding) -> Option<&Bytes> {
        self.encodings
            .iter()
            .find(|(cached, _)| *cached == encoding)
            .map(|(_, body)| body)
    }

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
    /// Advances on every hit and insertion to order entries by recency.
    clock: u64,
}

impl Entries {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Returns the current version's entry, marking it used.
    fn current(&mut self, version: &FileVersion) -> Option<&mut Entry> {
        let now = self.tick();
        let entry = self
            .by_path
            .get_mut(&version.path)
            .filter(|entry| entry.version == *version)?;
        entry.last_used = now;
        Some(entry)
    }

    /// Evicts least recently used entries other than `keep` until `needed`
    /// more bytes fit in `budget`. Returns whether they fit.
    fn make_room(&mut self, needed: usize, budget: usize, keep: &PathBuf) -> bool {
        while self.used + needed > budget {
            let Some(oldest) = self
                .by_path
                .iter()
                .filter(|(path, _)| *path != keep)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone())
            else {
                return false;
            };
            if let Some(evicted) = self.by_path.remove(&oldest) {
                self.used -= evicted.size();
            }
        }
        true
    }
}

pub struct AssetCache {
    entries: Mutex<Entries>,
    budget: usize,
}

/// Compresses without stalling the async workers on the multi-threaded runtime.
pub fn compress_off_runtime(encoding: Encoding, body: &Bytes) -> std::io::Result<Bytes> {
    let multi_thread = tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
    if multi_thread {
        tokio::task::block_in_place(|| encoding.compress(body))
    } else {
        encoding.compress(body)
    }
}

impl AssetCache {
    pub fn new(budget: usize) -> Self {
        Self {
            entries: Mutex::new(Entries::default()),
            budget,
        }
    }

    pub fn contents(&self, version: &FileVersion) -> Option<Bytes> {
        let mut entries = self.entries.lock().expect("asset cache lock");
        entries.current(version).map(|entry| entry.contents.clone())
    }

    pub fn store_contents(&self, version: &FileVersion, contents: &Bytes) {
        let mut entries = self.entries.lock().expect("asset cache lock");
        if let Some(stale) = entries.by_path.remove(&version.path) {
            entries.used -= stale.size();
        }
        if !entries.make_room(contents.len(), self.budget, &version.path) {
            return;
        }
        entries.used += contents.len();
        let last_used = entries.tick();
        entries.by_path.insert(
            version.path.clone(),
            Entry {
                version: version.clone(),
                contents: contents.clone(),
                encodings: Vec::new(),
                last_used,
            },
        );
    }

    /// Returns `body` in `encoding`, compressing it only the first time a
    /// cached file version is requested in that encoding.
    pub fn encode(
        &self,
        version: &FileVersion,
        encoding: Encoding,
        body: &Bytes,
    ) -> std::io::Result<Bytes> {
        if let Some(encoded) = self
            .entries
            .lock()
            .expect("asset cache lock")
            .current(version)
            .and_then(|entry| entry.encoded(encoding).cloned())
        {
            return Ok(encoded);
        }
        // Compresses outside the lock so other requests are not held up.
        let encoded = compress_off_runtime(encoding, body)?;
        let mut entries = self.entries.lock().expect("asset cache lock");
        let cacheable = entries
            .current(version)
            .is_some_and(|entry| entry.encoded(encoding).is_none());
        if cacheable && entries.make_room(encoded.len(), self.budget, &version.path) {
            entries.used += encoded.len();
            if let Some(entry) = entries.by_path.get_mut(&version.path) {
                entry.encodings.push((encoding, encoded.clone()));
            }
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
            .encode(&version(10_000), Encoding::Gzip, &body)
            .unwrap();
        let second = cache
            .encode(&version(10_000), Encoding::Gzip, &body)
            .unwrap();
        assert_eq!(
            first.as_ptr(),
            second.as_ptr(),
            "the second request reuses the cached encoding"
        );
        assert_eq!(cache.entries.lock().unwrap().used, body.len() + first.len());
    }

    #[test]
    fn evicts_the_least_recently_used_file_to_cache_a_new_one() {
        let file = |name: &str| FileVersion {
            path: PathBuf::from(name),
            len: 4,
            modified: None,
        };
        let cache = AssetCache::new(8);
        cache.store_contents(&file("/old-build.js"), &Bytes::from_static(b"old!"));
        cache.store_contents(&file("/kept.js"), &Bytes::from_static(b"kept"));
        assert!(cache.contents(&file("/kept.js")).is_some());
        cache.store_contents(&file("/new-build.js"), &Bytes::from_static(b"new!"));
        assert_eq!(cache.contents(&file("/old-build.js")), None);
        assert!(cache.contents(&file("/kept.js")).is_some());
        assert!(cache.contents(&file("/new-build.js")).is_some());
        assert_eq!(cache.entries.lock().unwrap().used, 8);
    }

    #[test]
    fn serves_files_beyond_its_budget_uncached() {
        let cache = AssetCache::new(4);
        cache.store_contents(&version(5), &Bytes::from_static(b"large"));
        assert_eq!(cache.contents(&version(5)), None);
        let encoded = cache
            .encode(&version(5), Encoding::Gzip, &Bytes::from_static(b"large"))
            .unwrap();
        assert!(!encoded.is_empty());
        assert_eq!(cache.entries.lock().unwrap().used, 0);
    }
}
