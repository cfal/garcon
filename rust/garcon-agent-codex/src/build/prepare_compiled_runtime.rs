use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

use garcon_interface::resources::ExecutorResult;

const CATALOG_NAME: &str = "codex-model-catalog.json";
const CATALOG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../server-agents/codex/src/agents/codex/app-server/codex-model-catalog.json",
));

pub struct CompiledCodexModelCatalog {
    path: PathBuf,
    directory: Option<tempfile::TempDir>,
}

impl CompiledCodexModelCatalog {
    pub async fn prepare() -> ExecutorResult<Self> {
        Ok(tokio::task::spawn_blocking(|| -> std::io::Result<Self> {
            let directory = tempfile::Builder::new()
                .prefix("garcon-codex-model-catalog-")
                .tempdir()?;
            let path = directory.path().join(CATALOG_NAME);
            let mut file = OpenOptions::new();
            file.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                file.mode(0o600);
            }
            file.open(&path)?.write_all(CATALOG)?;
            Ok(Self {
                path,
                directory: Some(directory),
            })
        })
        .await??)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn close(mut self) -> ExecutorResult<()> {
        if let Some(directory) = self.directory.take() {
            tokio::task::spawn_blocking(|| directory.close()).await??;
        }
        Ok(())
    }
}

impl Drop for CompiledCodexModelCatalog {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(move || drop(directory));
            } else {
                drop(directory);
            }
        }
    }
}
