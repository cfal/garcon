//! Ports `server/runtime/git/selected-file-commit.ts`.

use garcon_base::log::{Logger, create_logger};
use garcon_interface::resources::ExecutorResult;
use indexmap::IndexSet;

use super::pathspecs::literal_git_pathspec;
use super::run::{read_only_git_options, run_git, run_git_with_stdin};
use super::temporary_index::{
    TemporaryGitIndexEnvironment, create_temporary_git_index, remove_temporary_git_index,
};
use super::types::GitCommandOptions;

fn encode_pathspecs(pathspecs: &[String]) -> String {
    format!("{}\0", pathspecs.join("\0"))
}

async fn read_committed_pathspecs(project_path: &str) -> Option<Vec<String>> {
    match run_git(
        project_path,
        [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            "--root",
            "HEAD",
            "--",
        ]
        .map(str::to_owned)
        .into(),
        read_only_git_options(GitCommandOptions::default()),
    )
    .await
    {
        Ok(output) => Some(
            output
                .stdout
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(|path| format!(":(top,literal){path}"))
                .collect(),
        ),
        Err(_) => {
            create_logger("git:selected-file-commit").warn(
                "Selected-file commit succeeded but its committed paths could not be inspected",
            );
            None
        }
    }
}

async fn synchronize_committed_paths(project_path: &str, pathspec_input: String) -> bool {
    if run_git_with_stdin(
        project_path,
        [
            "reset",
            "--quiet",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
            "HEAD",
            "--",
        ]
        .map(str::to_owned)
        .into(),
        pathspec_input,
        GitCommandOptions::default(),
    )
    .await
    .is_ok()
    {
        return true;
    }
    create_logger("git:selected-file-commit")
        .warn("Selected-file commit succeeded but the real index could not be synchronized");
    false
}

pub struct SelectedFileCommitResult {
    pub output: String,
    pub index_synchronized: bool,
}

pub async fn commit_selected_files(
    project_path: &str,
    message: &str,
    files: &[String],
    environment: &TemporaryGitIndexEnvironment,
) -> ExecutorResult<SelectedFileCommitResult> {
    let pathspecs: Vec<_> = files
        .iter()
        .map(|path| literal_git_pathspec(path))
        .collect();
    let input = encode_pathspecs(&pathspecs);
    let temporary = create_temporary_git_index(project_path, None, environment).await?;
    let result = async {
        let options = GitCommandOptions {
            env: Some([("GIT_INDEX_FILE".into(), Some(temporary.as_str().into()))].into()),
            ..Default::default()
        };
        run_git_with_stdin(
            project_path,
            ["add", "--pathspec-from-file=-", "--pathspec-file-nul"]
                .map(str::to_owned)
                .into(),
            input.clone(),
            options.clone(),
        )
        .await?;
        let output = run_git_with_stdin(
            project_path,
            [
                "commit",
                "--only",
                "-m",
                message,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .map(str::to_owned)
            .into(),
            input,
            options,
        )
        .await?;
        let committed = read_committed_pathspecs(project_path).await;
        let inspected = committed.is_some();
        let to_sync = if let Some(committed) = committed {
            pathspecs
                .into_iter()
                .chain(committed)
                .collect::<IndexSet<_>>()
                .into_iter()
                .collect()
        } else {
            pathspecs
        };
        let synchronized =
            synchronize_committed_paths(project_path, encode_pathspecs(&to_sync)).await;
        Ok(SelectedFileCommitResult {
            output: output.stdout,
            index_synchronized: inspected && synchronized,
        })
    }
    .await;
    remove_temporary_git_index(&temporary).await;
    result
}
