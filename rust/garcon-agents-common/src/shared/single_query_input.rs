//! Ports `server-agents/common/src/shared/single-query-input.ts`.

use std::error::Error;

use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;

/// Writes the prompt to a child's stdin and ends it. A failure is captured,
/// so drained output and the exit status take precedence over EPIPE.
pub async fn capture_single_query_input_failure(
    stdin: Option<&mut ChildStdin>,
    input: Option<&str>,
    provider: &str,
) -> Option<Box<dyn Error>> {
    let input = input?;
    let written = match stdin {
        None => Err(format!("{provider} process stdin is unavailable").into()),
        Some(stdin) => {
            async {
                stdin.write_all(input.as_bytes()).await?;
                stdin.shutdown().await?;
                Ok::<(), Box<dyn Error>>(())
            }
            .await
        }
    };
    written.err()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::process::Stdio;

    #[cfg(unix)]
    use tokio::process::Command;

    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn without_input_nothing_is_written() {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        assert!(
            capture_single_query_input_failure(stdin.as_mut(), None, "Pi")
                .await
                .is_none()
        );
        drop(stdin);
        child.wait().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn writes_the_input_and_ends_the_stream() {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();

        assert!(
            capture_single_query_input_failure(stdin.as_mut(), Some("prompt\n"), "Pi")
                .await
                .is_none()
        );
        drop(stdin);

        let output = child.wait_with_output().await.unwrap();
        assert_eq!(output.stdout, b"prompt\n");
    }

    #[tokio::test]
    async fn a_child_without_a_piped_stdin_is_reported() {
        let error = capture_single_query_input_failure(None, Some("prompt"), "Pi")
            .await
            .unwrap();
        assert_eq!(error.to_string(), "Pi process stdin is unavailable");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_write_is_captured() {
        // The reader exits without reading, so a large write fails with EPIPE.
        let mut child = Command::new("sh")
            .args(["-c", "exec 0<&-; exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        let input = "x".repeat(1024 * 1024);

        let error = capture_single_query_input_failure(stdin.as_mut(), Some(&input), "Pi").await;

        assert!(error.is_some(), "writing to a closed stdin must fail");
    }
}
