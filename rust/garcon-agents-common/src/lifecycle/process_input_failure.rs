//! Ports `server-agents/common/src/lifecycle/process-input-failure.ts`.

use std::future::Future;
use std::time::Duration;

const EXIT_STATUS_GRACE_MS: u64 = 100;

/// Returns the exit code a child reports within a short grace period after
/// its input failed, or `None` when it has not exited or its exit is lost.
/// Bun can reject a pipe write before publishing exit; a live child closing
/// stdin must not stall rollback.
pub async fn exit_code_after_input_failure<E>(
    exited: impl Future<Output = Result<i32, E>>,
) -> Option<i32> {
    match tokio::time::timeout(Duration::from_millis(EXIT_STATUS_GRACE_MS), exited).await {
        Ok(Ok(exit_code)) => Some(exit_code),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn returns_before_a_live_child_that_closed_stdin_exits() {
        use std::{io, process::Stdio};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            process::Command,
        };

        let mut child = Command::new("sh")
            .args(["-c", "exec 0<&-; printf '!'; exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        assert_eq!(stdout.read_u8().await.unwrap(), b'!');
        let error = child
            .stdin
            .take()
            .unwrap()
            .write_all(b"prompt")
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);

        assert_eq!(
            exit_code_after_input_failure(async {
                child.wait().await.map(|status| status.code().unwrap())
            })
            .await,
            None
        );
        assert!(child.try_wait().unwrap().is_none());
        child.kill().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn reports_the_exit_code_of_a_child_that_exits_within_the_grace_period() {
        assert_eq!(
            exit_code_after_input_failure(async { Ok::<_, ()>(7) }).await,
            Some(7)
        );
        let delay = Duration::from_millis(EXIT_STATUS_GRACE_MS - 1);
        assert_eq!(
            exit_code_after_input_failure(async {
                tokio::time::sleep(delay).await;
                Ok::<_, ()>(0)
            })
            .await,
            Some(0)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_child_still_running_or_lost_reports_no_exit_code() {
        assert_eq!(
            exit_code_after_input_failure(std::future::pending::<Result<i32, ()>>()).await,
            None
        );
        assert_eq!(exit_code_after_input_failure(async { Err(()) }).await, None);
        assert_eq!(
            exit_code_after_input_failure(async {
                tokio::time::sleep(Duration::from_millis(EXIT_STATUS_GRACE_MS + 1)).await;
                Ok::<_, ()>(3)
            })
            .await,
            None
        );
    }
}
