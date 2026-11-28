//! Ports `server/runtime/git/untracked-patch.ts`.

use std::cell::RefCell;

use garcon_interface::resources::ExecutorResult;

use super::pathspecs::exact_git_pathspecs;
use super::run::{read_only_git_options, run_git_traced_shared};
use super::temporary_index::{
    TemporaryGitIndexEnvironment, create_temporary_git_index, remove_temporary_git_index,
};
use super::types::{GitCommandOptions, GitCommandTrace};

pub async fn load_untracked_patches(
    project_path: &str,
    files: &[String],
    context_lines: usize,
    options: GitCommandOptions,
    trace: Option<&RefCell<Vec<GitCommandTrace>>>,
    environment: &TemporaryGitIndexEnvironment,
) -> ExecutorResult<String> {
    let temporary =
        create_temporary_git_index(project_path, options.signal.clone(), environment).await?;
    let result = async {
        let mut options = read_only_git_options(options);
        options
            .env
            .get_or_insert_with(Default::default)
            .insert("GIT_INDEX_FILE".into(), Some(temporary.as_str().into()));
        let pathspecs = exact_git_pathspecs(files);
        let args = ["add", "-N", "--"]
            .map(str::to_owned)
            .into_iter()
            .chain(pathspecs.iter().cloned())
            .collect();
        run_git_traced_shared(project_path, args, trace, options.clone()).await?;
        let mut args: Vec<_> = [
            "diff",
            "--patch-with-raw",
            "-z",
            "--no-renames",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ]
        .map(str::to_owned)
        .into();
        args.extend([format!("-U{context_lines}"), "--".into()]);
        args.extend(pathspecs);
        let output = run_git_traced_shared(project_path, args, trace, options).await?;
        Ok(output.stdout)
    }
    .await;
    remove_temporary_git_index(&temporary).await;
    result
}

#[cfg(test)]
mod tests {
    use garcon_contract::git::GitReviewBodyState;
    use tokio::task::LocalSet;

    use super::*;
    use crate::git::git_fixture::GitFixture;
    use crate::git::review_patch::{create_review_patch_body, split_patches_from_raw_diff};

    #[tokio::test]
    async fn preserves_newline_semantics_without_modifying_the_real_index() {
        LocalSet::new()
            .run_until(async {
                let repo = GitFixture::with_commit().await;
                let before = repo.run(&["ls-files", "--stage"]).await;
                let project = repo.path().to_str().unwrap();
                let files = ["added.txt".to_owned()];
                let environment = TemporaryGitIndexEnvironment::default();
                for (content, lines) in [
                    ("", 0),
                    ("one", 1),
                    ("one\n", 1),
                    ("one\n\n", 2),
                    ("one\ntwo\n", 2),
                ] {
                    tokio::fs::write(repo.path().join("added.txt"), content)
                        .await
                        .unwrap();
                    let raw = load_untracked_patches(
                        project,
                        &files,
                        3,
                        Default::default(),
                        None,
                        &environment,
                    )
                    .await
                    .unwrap();
                    let file = split_patches_from_raw_diff(&raw)
                        .unwrap()
                        .shift_remove(&files[0])
                        .unwrap();
                    let body = create_review_patch_body(
                        &files[0],
                        "synthetic-fingerprint",
                        file.patch,
                        false,
                    );
                    assert_eq!(body.body_state, GitReviewBodyState::Loaded);
                    assert_eq!(
                        body.rendered_row_count.0,
                        if lines == 0 {
                            0.0
                        } else {
                            f64::from(lines + 1)
                        }
                    );
                    let patch = body.patch.unwrap();
                    assert_eq!(
                        patch.contains("\\ No newline at end of file"),
                        !content.is_empty() && !content.ends_with('\n')
                    );
                    if lines > 0 {
                        let range = if lines == 1 {
                            "1".into()
                        } else {
                            format!("1,{lines}")
                        };
                        assert!(patch.contains(&format!("@@ -0,0 +{range} @@")));
                    }
                    assert_eq!(repo.run(&["ls-files", "--stage"]).await, before);
                }
            })
            .await;
    }
}
