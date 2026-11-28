use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

use garcon_base::{event_loop::EventLoopSteps, log::Logger};

use crate::{directories::private_directory_builder, sqlite_operations::LedgerResult};

use super::{LOGGER, TranscriptLedgerStore, is_chat_directory_name, validate_chat_directory_name};

const TRASH_DIRECTORY: &str = ".trash";

impl TranscriptLedgerStore {
    /// Runs at startup before chat mutations are admitted. `None` means the
    /// registry did not load from disk, not that it loaded an empty chat list.
    pub async fn remove_unregistered_chat_directories(
        &self,
        registered_chat_ids: Option<&HashSet<String>>,
    ) -> LedgerResult<Vec<String>> {
        let root = PathBuf::from(&self.state.borrow().connections.root_directory);
        let mut entries = match tokio::fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let Some(registered) = registered_chat_ids else {
            if entries.next_entry().await?.is_some() {
                return Err("Missing chats.json with existing transcript ledgers; restore the registry before starting Garcon".into());
            }
            return Ok(Vec::new());
        };

        let result = async {
            let mut removed = Vec::new();
            let mut steps = EventLoopSteps::new("ledger orphan cleanup");
            let mut candidates = Vec::new();
            while let Some(entry) = entries.next_entry().await? {
                let basename = entry.file_name();
                if let Some(name) = basename.to_str()
                    && is_chat_directory_name(name)
                    && !registered.contains(name)
                {
                    candidates.push(name.to_owned());
                }
                steps.next().await;
            }
            for name in candidates {
                let path = root.join(&name);
                if let Some(kind) = entry_type(&path)? {
                    if kind.is_dir() {
                        self.move_chat_to_trash(&root, &name)?;
                        removed.push(name);
                    } else if kind.is_symlink() {
                        ignore_missing(unlink_non_directory(&path, kind))?;
                        removed.push(name);
                    }
                }
                steps.next().await;
            }
            Ok(removed)
        }
        .await;
        // One blocking sweep also picks up directories left by an interrupted deletion.
        tokio::task::spawn_blocking(move || sweep_trash(&root.join(TRASH_DIRECTORY)));
        result
    }

    pub fn delete_chat(&self, chat_id: &str) -> LedgerResult<()> {
        validate_chat_directory_name(chat_id)?;
        let root = PathBuf::from(&self.state.borrow().connections.root_directory);
        if let Some(target) = self.move_chat_to_trash(&root, chat_id)? {
            tokio::task::spawn_blocking(move || remove_deleted(&target));
        }
        Ok(())
    }

    fn move_chat_to_trash(&self, root: &Path, chat_id: &str) -> LedgerResult<Option<PathBuf>> {
        self.close_chat(chat_id)?;
        {
            let mut state = self.state.borrow_mut();
            state.connections.open_failures.shift_remove(chat_id);
            state.fences.delete(chat_id);
        }
        let trash = root.join(TRASH_DIRECTORY);
        match entry_type(&trash)? {
            Some(kind) if kind.is_dir() => {}
            other => {
                if let Some(kind) = other {
                    ignore_missing(unlink_non_directory(&trash, kind))?;
                }
                private_directory_builder().create(&trash)?;
            }
        }
        let target = trash.join(format!("{chat_id}-{}", uuid::Uuid::new_v4()));
        match fs::rename(root.join(chat_id), &target) {
            Ok(()) => Ok(Some(target)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}

fn sweep_trash(trash: &Path) {
    if let Ok(Some(kind)) = entry_type(trash)
        && kind.is_dir()
        && let Ok(entries) = fs::read_dir(trash)
    {
        for entry in entries.flatten() {
            remove_deleted(&entry.path());
        }
    }
}

fn remove_deleted(path: &Path) {
    let result = entry_type(path).and_then(|kind| match kind {
        Some(kind) if kind.is_dir() => fs::remove_dir_all(path),
        Some(kind) => unlink_non_directory(path, kind),
        None => Ok(()),
    });
    if let Err(error) = ignore_missing(result) {
        LOGGER.warn(&format!(
            "Deleted transcript ledger removal failed; it is retried on the next start: {error}"
        ));
    }
}

fn entry_type(path: &Path) -> io::Result<Option<fs::FileType>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata.file_type())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn unlink_non_directory(path: &Path, _kind: fs::FileType) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if _kind.is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    result.or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        }
    })
}
