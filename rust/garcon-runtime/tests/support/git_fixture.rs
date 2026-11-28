//! Disposable real repositories, as in the original repository-fixture.js.

use std::path::Path;
use std::process::Stdio;

use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub struct GitFixture {
    root: TempDir,
}

impl GitFixture {
    pub fn empty() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
        }
    }

    pub async fn with_commit() -> Self {
        let fixture = Self::empty();
        fixture.run(&["init", "-b", "main"]).await;
        fixture
            .run(&["config", "user.email", "test@example.invalid"])
            .await;
        fixture.run(&["config", "user.name", "Test User"]).await;
        tokio::fs::write(fixture.path().join("a.txt"), "one\n")
            .await
            .unwrap();
        fixture.run(&["add", "a.txt"]).await;
        fixture.run(&["commit", "-m", "initial"]).await;
        fixture
    }

    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub async fn run(&self, args: &[&str]) -> String {
        self.git(args, None).await
    }

    pub async fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> String {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(self.path())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.path().join("fixture.gitconfig"))
            .env("GIT_TEMPLATE_DIR", "")
            .env("GIT_AUTHOR_DATE", "2026-01-02T03:04:05Z")
            .env("GIT_COMMITTER_DATE", "2026-01-02T03:04:05Z")
            .env("LC_ALL", "C")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        if let Some(bytes) = stdin {
            let mut writer = child.stdin.take().unwrap();
            writer.write_all(bytes).await.unwrap();
        }
        let result = child.wait_with_output().await.unwrap();
        assert!(
            result.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout).into_owned()
    }
}
