//! Ports `server/runtime/git/review-document-registry.ts`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use garcon_base::errors::NamedError;
use garcon_contract::git::{
    GitCommitFileStatus, GitCommitFileSummary, GitFileReviewCategory, GitReviewBodyState,
    GitReviewFilePatchBody, GitReviewFileSummary, GitReviewLimitReason, GitReviewMode,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Clock, Number, SystemClock};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::git_domain_error::GitDomainError;
use super::working_path_token::GitWorkingPathToken;

const DEFAULT_IDLE_TTL_MS: i64 = 10 * 60 * 1000;
const DEFAULT_MAX_IDLE_DOCUMENTS: usize = 32;
const DEFAULT_MAX_TOTAL_DOCUMENTS: usize = 64;
const DEFAULT_MAX_BODY_BYTES: f64 = 128.0 * 1024.0 * 1024.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitReviewDocumentSource {
    Workbench {
        mode: GitReviewMode,
        staged_base_hash: String,
        fingerprint: String,
    },
    Commit {
        base_hash: String,
        target_hash: String,
    },
    ComparisonRevisions {
        effective_from_hash: String,
        to_hash: String,
    },
    ComparisonWorkingTree {
        effective_from_hash: String,
        fingerprint: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RegisteredGitReviewChange {
    Workbench {
        index_status: String,
        work_tree_status: String,
    },
    TreeDiff {
        status: GitCommitFileStatus,
        raw_status: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredGitReviewFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub change: RegisteredGitReviewChange,
    pub category: GitFileReviewCategory,
    pub additions: Number,
    pub deletions: Number,
    pub estimated_rows: Number,
    pub body_state: GitReviewBodyState,
    pub body_fingerprint: String,
    pub is_binary: bool,
    pub is_too_large: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reason: Option<GitReviewLimitReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_message: Option<String>,
}

fn truthy_text(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_owned)
}

pub fn registered_workbench_file(file: &GitReviewFileSummary) -> RegisteredGitReviewFile {
    RegisteredGitReviewFile {
        path: file.path.clone(),
        original_path: truthy_text(file.original_path.as_deref()),
        change: RegisteredGitReviewChange::Workbench {
            index_status: file.index_status.clone(),
            work_tree_status: file.work_tree_status.clone(),
        },
        category: file.category,
        additions: file.additions,
        deletions: file.deletions,
        estimated_rows: file.estimated_rows,
        body_state: file.body_state,
        body_fingerprint: file.body_fingerprint.clone(),
        is_binary: file.is_binary,
        is_too_large: file.is_too_large,
        limit_reason: file.limit_reason,
        limit_message: truthy_text(file.limit_message.as_deref()),
    }
}

pub fn registered_tree_diff_file(file: &GitCommitFileSummary) -> RegisteredGitReviewFile {
    RegisteredGitReviewFile {
        path: file.path.clone(),
        original_path: truthy_text(file.original_path.as_deref()),
        change: RegisteredGitReviewChange::TreeDiff {
            status: file.status,
            raw_status: file.raw_status.clone(),
        },
        category: file.category,
        additions: file.additions,
        deletions: file.deletions,
        estimated_rows: file.estimated_rows,
        body_state: file.body_state,
        body_fingerprint: file.body_fingerprint.clone(),
        is_binary: file.is_binary,
        is_too_large: file.is_too_large,
        limit_reason: file.limit_reason,
        limit_message: truthy_text(file.limit_message.as_deref()),
    }
}

pub struct RegisterGitReviewDocumentInput {
    pub source_cache_key: String,
    pub project_path: String,
    pub repo_root: String,
    pub context: usize,
    pub source: GitReviewDocumentSource,
    pub files: Vec<RegisteredGitReviewFile>,
    pub working_path_tokens: IndexMap<String, GitWorkingPathToken>,
}

pub struct RegisteredGitReviewDocument {
    pub id: String,
    pub generation: usize,
    pub source_cache_key: String,
    pub project_path: String,
    pub repo_root: String,
    pub context: usize,
    pub source: GitReviewDocumentSource,
    pub files_by_path: IndexMap<String, RegisteredGitReviewFile>,
    pub working_path_tokens: IndexMap<String, GitWorkingPathToken>,
    pub created_at: i64,
    last_accessed_at: Cell<i64>,
    lease_count: Cell<usize>,
    superseded: Cell<bool>,
    cache: RefCell<BodyCache>,
}

#[derive(Default)]
struct BodyCache {
    patch_digests: IndexMap<String, String>,
    bodies: IndexMap<String, GitReviewFilePatchBody>,
    body_bytes: f64,
}

impl RegisteredGitReviewDocument {
    pub fn patch_digest(&self, path: &str) -> Option<String> {
        self.cache.borrow().patch_digests.get(path).cloned()
    }
}

pub struct GitReviewDocumentRegistryOptions {
    pub clock: Rc<dyn Clock>,
    pub next_id: Rc<dyn Fn() -> String>,
    pub idle_ttl_ms: i64,
    pub max_idle_documents: usize,
    pub max_total_documents: usize,
    pub max_body_bytes: f64,
}

impl Default for GitReviewDocumentRegistryOptions {
    fn default() -> Self {
        Self {
            clock: Rc::new(SystemClock),
            next_id: Rc::new(|| uuid::Uuid::new_v4().to_string()),
            idle_ttl_ms: DEFAULT_IDLE_TTL_MS,
            max_idle_documents: DEFAULT_MAX_IDLE_DOCUMENTS,
            max_total_documents: DEFAULT_MAX_TOTAL_DOCUMENTS,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        }
    }
}

#[derive(Default)]
struct RegistryState {
    documents: IndexMap<String, Rc<RegisteredGitReviewDocument>>,
    latest_by_registration: IndexMap<String, String>,
    total_body_bytes: f64,
}

#[derive(Default)]
pub struct GitReviewDocumentRegistry {
    state: RefCell<RegistryState>,
    options: GitReviewDocumentRegistryOptions,
}

pub struct GitReviewDocumentLease {
    pub document: Rc<RegisteredGitReviewDocument>,
    registry: Rc<GitReviewDocumentRegistry>,
    released: Cell<bool>,
}

fn serialized(value: &impl Serialize) -> String {
    // INFALLIBLE: the source and summary types contain no external serializer and no cyclic values.
    serde_json::to_string(value).expect("serializable review metadata")
}

fn content_key<'a>(
    project_path: &str,
    repo_root: &str,
    source_cache_key: &str,
    context: usize,
    source: &GitReviewDocumentSource,
    files: impl IntoIterator<Item = &'a RegisteredGitReviewFile>,
) -> String {
    let mut parts = vec![
        project_path.to_owned(),
        repo_root.to_owned(),
        source_cache_key.to_owned(),
        context.to_string(),
        serialized(source),
    ];
    parts.extend(files.into_iter().map(serialized));
    parts.join("\x1f")
}

fn registration_key(project_path: &str, source_cache_key: &str) -> String {
    format!("{project_path}\x1f{source_cache_key}")
}

impl GitReviewDocumentRegistry {
    pub fn new(options: GitReviewDocumentRegistryOptions) -> Self {
        Self {
            state: RefCell::default(),
            options,
        }
    }

    pub fn register(
        &self,
        input: RegisterGitReviewDocumentInput,
    ) -> Result<Rc<RegisteredGitReviewDocument>, GitDomainError> {
        let mut state = self.state.borrow_mut();
        self.prune(&mut state);
        let key = registration_key(&input.project_path, &input.source_cache_key);
        let previous = state
            .latest_by_registration
            .get(&key)
            .and_then(|id| state.documents.get(id))
            .cloned();
        let next_content_key = content_key(
            &input.project_path,
            &input.repo_root,
            &input.source_cache_key,
            input.context,
            &input.source,
            &input.files,
        );
        if let Some(previous) = &previous
            && !previous.superseded.get()
            && content_key(
                &previous.project_path,
                &previous.repo_root,
                &previous.source_cache_key,
                previous.context,
                &previous.source,
                previous.files_by_path.values(),
            ) == next_content_key
        {
            previous.last_accessed_at.set(self.options.clock.now_ms());
            return Ok(previous.clone());
        }

        if state.documents.len() >= self.options.max_total_documents {
            let overflow = state.documents.len() - self.options.max_total_documents + 1;
            state.evict_idle(overflow);
        }
        if state.documents.len() >= self.options.max_total_documents {
            return Err(GitDomainError::new(
                "SERVICE_BUSY",
                "Too many active Git review documents. Try again shortly.",
            ));
        }

        if let Some(previous) = &previous {
            previous.superseded.set(true);
        }
        let now = self.options.clock.now_ms();
        let document = Rc::new(RegisteredGitReviewDocument {
            id: (self.options.next_id)(),
            generation: previous.map_or(1, |previous| previous.generation + 1),
            source_cache_key: input.source_cache_key,
            project_path: input.project_path,
            repo_root: input.repo_root,
            context: input.context,
            source: input.source,
            files_by_path: input
                .files
                .into_iter()
                .map(|file| (file.path.clone(), file))
                .collect(),
            working_path_tokens: input.working_path_tokens,
            created_at: now,
            last_accessed_at: Cell::new(now),
            lease_count: Cell::new(0),
            superseded: Cell::new(false),
            cache: RefCell::default(),
        });
        state
            .documents
            .insert(document.id.clone(), document.clone());
        state
            .latest_by_registration
            .insert(key, document.id.clone());
        self.prune(&mut state);
        Ok(document)
    }

    pub fn acquire(
        self: &Rc<Self>,
        project_path: &str,
        document_id: &str,
    ) -> Option<GitReviewDocumentLease> {
        let mut state = self.state.borrow_mut();
        self.prune(&mut state);
        let document = state.documents.get(document_id)?;
        if document.superseded.get() || document.project_path != project_path {
            return None;
        }
        document.lease_count.set(document.lease_count.get() + 1);
        document.last_accessed_at.set(self.options.clock.now_ms());
        Some(GitReviewDocumentLease {
            document: document.clone(),
            registry: self.clone(),
            released: Cell::new(false),
        })
    }

    fn prune(&self, state: &mut RegistryState) {
        let expiry = i128::from(self.options.clock.now_ms()) - i128::from(self.options.idle_ttl_ms);
        let mut expired = Vec::new();
        let mut idle_count = 0;
        for document in state
            .documents
            .values()
            .filter(|document| document.lease_count.get() == 0)
        {
            if document.superseded.get() || i128::from(document.last_accessed_at.get()) < expiry {
                expired.push(document.clone());
            } else {
                idle_count += 1;
            }
        }
        for expired in expired {
            state.delete_document(&expired);
        }
        if idle_count > self.options.max_idle_documents {
            state.evict_idle(idle_count - self.options.max_idle_documents);
        }
        state.prune_bodies(self.options.max_body_bytes);
    }
}

impl GitReviewDocumentLease {
    pub fn get_body(&self, path: &str) -> Option<GitReviewFilePatchBody> {
        self.document.cache.borrow().bodies.get(path).cloned()
    }

    pub fn set_bodies(&self, bodies: &mut [GitReviewFilePatchBody]) -> ExecutorResult<()> {
        let document = &self.document;
        let mut state = self.registry.state.borrow_mut();
        if !state.documents.contains_key(&document.id) || document.superseded.get() {
            return Ok(());
        }
        {
            let mut cache = document.cache.borrow_mut();
            for body in bodies.iter_mut() {
                let file = document.files_by_path.get(&body.path);
                if file.is_none_or(|file| file.body_fingerprint != body.body_fingerprint) {
                    return Err(NamedError {
                        name: "Error".into(),
                        message: format!(
                            "Refusing to cache an invalid review body for {}.",
                            body.path
                        ),
                        code: None,
                    }
                    .into());
                }
                if let Some(patch) = &body.patch {
                    let digest = format!("{:x}", Sha256::digest(patch));
                    if cache
                        .patch_digests
                        .get(&body.path)
                        .is_some_and(|previous| previous != &digest)
                    {
                        document.superseded.set(true);
                        return Err(GitDomainError::new(
                            "STALE_DOCUMENT",
                            "The displayed patch changed. Refresh and select it again.",
                        )
                        .into());
                    }
                    body.patch_digest = Some(digest);
                }
            }
            for body in bodies {
                if let Some(digest) = body
                    .patch_digest
                    .as_ref()
                    .filter(|digest| !digest.is_empty())
                {
                    cache
                        .patch_digests
                        .insert(body.path.clone(), digest.clone());
                }
                if let Some(previous) = cache.bodies.shift_remove(&body.path) {
                    cache.body_bytes -= previous.patch_bytes.0;
                    state.total_body_bytes -= previous.patch_bytes.0;
                }
                cache.bodies.insert(body.path.clone(), body.clone());
                cache.body_bytes += body.patch_bytes.0;
                state.total_body_bytes += body.patch_bytes.0;
            }
        }
        state.prune_bodies(self.registry.options.max_body_bytes);
        Ok(())
    }

    pub fn release(&self) {
        if self.released.replace(true) {
            return;
        }
        let document = &self.document;
        document
            .lease_count
            .set(document.lease_count.get().saturating_sub(1));
        document
            .last_accessed_at
            .set(self.registry.options.clock.now_ms());
        self.registry.prune(&mut self.registry.state.borrow_mut());
    }
}

impl Drop for GitReviewDocumentLease {
    fn drop(&mut self) {
        self.release();
    }
}

impl RegistryState {
    fn idle_candidates(
        &self,
        filter: impl Fn(&RegisteredGitReviewDocument) -> bool,
    ) -> Vec<Rc<RegisteredGitReviewDocument>> {
        let mut candidates: Vec<_> = self
            .documents
            .values()
            .filter(|document| document.lease_count.get() == 0 && filter(document))
            .cloned()
            .collect();
        candidates.sort_by_key(|document| document.last_accessed_at.get());
        candidates
    }

    fn prune_bodies(&mut self, max_body_bytes: f64) {
        if self.total_body_bytes <= max_body_bytes {
            return;
        }
        for document in self.idle_candidates(|document| !document.cache.borrow().bodies.is_empty())
        {
            let mut cache = document.cache.borrow_mut();
            while let Some((_, body)) = cache.bodies.shift_remove_index(0) {
                cache.body_bytes -= body.patch_bytes.0;
                self.total_body_bytes -= body.patch_bytes.0;
                if self.total_body_bytes <= max_body_bytes {
                    return;
                }
            }
        }
    }

    fn evict_idle(&mut self, count: usize) {
        for candidate in self.idle_candidates(|_| true).into_iter().take(count) {
            self.delete_document(&candidate);
        }
    }

    fn delete_document(&mut self, document: &RegisteredGitReviewDocument) {
        self.documents.shift_remove(&document.id);
        let key = registration_key(&document.project_path, &document.source_cache_key);
        if self.latest_by_registration.get(&key) == Some(&document.id) {
            self.latest_by_registration.shift_remove(&key);
        }
        self.total_body_bytes -= document.cache.borrow().body_bytes;
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, unknown};
    use garcon_js::ManualClock;
    use std::path::PathBuf;

    use super::*;

    fn registration(key: &str) -> RegisterGitReviewDocumentInput {
        RegisterGitReviewDocumentInput {
            source_cache_key: key.into(),
            project_path: "/repo".into(),
            repo_root: "/repo".into(),
            context: 3,
            source: GitReviewDocumentSource::ComparisonRevisions {
                effective_from_hash: "base".into(),
                to_hash: "target".into(),
            },
            files: vec![RegisteredGitReviewFile {
                path: "src/file.ts".into(),
                original_path: None,
                change: RegisteredGitReviewChange::TreeDiff {
                    status: GitCommitFileStatus::Modified,
                    raw_status: "M".into(),
                },
                category: GitFileReviewCategory::Normal,
                additions: Number(1.0),
                deletions: Number(1.0),
                estimated_rows: Number(3.0),
                body_state: GitReviewBodyState::Unloaded,
                body_fingerprint: "fingerprint:src/file.ts".into(),
                is_binary: false,
                is_too_large: false,
                limit_reason: None,
                limit_message: None,
            }],
            working_path_tokens: IndexMap::new(),
        }
    }

    fn patch_body(path: &str) -> GitReviewFilePatchBody {
        GitReviewFilePatchBody {
            path: path.into(),
            patch_digest: Some(
                "282a2db76b7b6a37366d552d1d46808d923519b79e25291603bb4556d8960e4e".into(),
            ),
            body_fingerprint: format!("fingerprint:{path}"),
            body_state: GitReviewBodyState::Loaded,
            category: GitFileReviewCategory::Normal,
            is_binary: false,
            is_too_large: false,
            rendered_row_count: Number(2.0),
            patch_bytes: Number(20.0),
            patch: Some("@@ -1 +1 @@\n-old\n+new\n".into()),
            limit_reason: None,
            limit_message: None,
            error: None,
        }
    }

    fn registry(options: GitReviewDocumentRegistryOptions) -> Rc<GitReviewDocumentRegistry> {
        let id = Cell::new(0u32);
        Rc::new(GitReviewDocumentRegistry::new(
            GitReviewDocumentRegistryOptions {
                next_id: Rc::new(move || {
                    id.set(id.get() + 1);
                    format!("fixture-{}", id.get())
                }),
                ..options
            },
        ))
    }

    #[test]
    fn recorded_review_document_registry_matches() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/cases/git/review-document-registry");
        replay(directory, |function, args| {
            let value = unknown(function, args.first())?.into_owned();
            let bad_input = |error: serde_json::Error| CaseError::undeliverable(error.to_string());
            let result = match function {
                "registeredWorkbenchFile" => {
                    registered_workbench_file(&serde_json::from_value(value).map_err(bad_input)?)
                }
                "registeredTreeDiffFile" => {
                    registered_tree_diff_file(&serde_json::from_value(value).map_err(bad_input)?)
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            garcon_js::json::from_str(&serialized(&result))
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        });
    }

    #[test]
    fn supersedes_changed_metadata_without_carrying_bodies_or_digests_forward() {
        let changes: [fn(&mut RegisteredGitReviewFile); 4] = [
            |file| {
                file.additions = Number(2.0);
                file.estimated_rows = Number(4.0);
            },
            |file| {
                file.change = RegisteredGitReviewChange::TreeDiff {
                    status: GitCommitFileStatus::Added,
                    raw_status: "A".into(),
                };
            },
            |file| {
                file.is_binary = true;
                file.body_state = GitReviewBodyState::Binary;
            },
            |file| {
                file.is_too_large = true;
                file.body_state = GitReviewBodyState::TooLarge;
                file.limit_reason = Some(GitReviewLimitReason::FileTooManyBytes);
                file.limit_message = Some("Too large.".into());
            },
        ];
        for change in changes {
            let registry = registry(Default::default());
            let first = registry.register(registration("source")).unwrap();
            assert_eq!(
                registry.register(registration("source")).unwrap().id,
                first.id
            );
            let lease = registry.acquire("/repo", &first.id).unwrap();
            lease.set_bodies(&mut [patch_body("src/file.ts")]).unwrap();
            assert!(first.patch_digest("src/file.ts").is_some());
            let mut registration = registration("source");
            change(&mut registration.files[0]);
            let changed = registry.register(registration).unwrap();
            assert_ne!(changed.id, first.id);
            assert_eq!(changed.generation, 2);
            assert!(changed.patch_digest("src/file.ts").is_none());
            assert!(registry.acquire("/repo", &first.id).is_none());
            let replacement = registry.acquire("/repo", &changed.id).unwrap();
            assert!(replacement.get_body("src/file.ts").is_none());
        }
    }

    #[test]
    fn keeps_a_leased_document_alive_through_expiry_and_the_hard_limit() {
        let clock = Rc::new(ManualClock::new(0));
        let registry = registry(GitReviewDocumentRegistryOptions {
            clock: clock.clone(),
            idle_ttl_ms: 10,
            max_idle_documents: 1,
            max_total_documents: 1,
            ..Default::default()
        });
        let first = registry.register(registration("first")).unwrap();
        let first_lease = registry.acquire("/repo", &first.id).unwrap();
        clock.set(20);
        let second_lease = registry.acquire("/repo", &first.id).unwrap();
        let error = registry.register(registration("second")).err().unwrap();
        assert_eq!(error.code, "SERVICE_BUSY");
        second_lease.release();
        first_lease.release();
        clock.set(40);
        assert!(registry.acquire("/repo", &first.id).is_none());
        assert!(registry.register(registration("second")).is_ok());
    }

    #[test]
    fn isolates_projects_and_rejects_the_entire_invalid_body_batch() {
        let registry = registry(Default::default());
        let first = registry.register(registration("source")).unwrap();
        assert!(registry.acquire("/other", &first.id).is_none());
        let second = registry
            .register(RegisterGitReviewDocumentInput {
                project_path: "/repo/subdirectory".into(),
                ..registration("source")
            })
            .unwrap();
        assert_ne!(first.id, second.id);
        assert!(registry.acquire("/repo/subdirectory", &second.id).is_some());
        let lease = registry.acquire("/repo", &first.id).unwrap();
        let invalid = GitReviewFilePatchBody {
            body_fingerprint: "wrong".into(),
            ..patch_body("src/file.ts")
        };
        for body in [patch_body("other.ts"), invalid] {
            let error = lease
                .set_bodies(&mut [patch_body("src/file.ts"), body])
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Refusing to cache an invalid review body")
            );
            assert!(lease.get_body("src/file.ts").is_none());
        }
        lease.set_bodies(&mut [patch_body("src/file.ts")]).unwrap();
        assert_eq!(
            lease.get_body("src/file.ts"),
            Some(patch_body("src/file.ts"))
        );
    }

    #[test]
    fn drops_older_idle_bodies_when_over_budget_and_keeps_their_digests() {
        let registry = registry(GitReviewDocumentRegistryOptions {
            max_body_bytes: 20.0,
            ..Default::default()
        });
        let first = registry.register(registration("first")).unwrap();
        let lease = registry.acquire("/repo", &first.id).unwrap();
        lease.set_bodies(&mut [patch_body("src/file.ts")]).unwrap();
        lease.release();
        let second = registry.register(registration("second")).unwrap();
        let second = registry.acquire("/repo", &second.id).unwrap();
        second.set_bodies(&mut [patch_body("src/file.ts")]).unwrap();
        let first = registry.acquire("/repo", &first.id).unwrap();
        assert!(first.get_body("src/file.ts").is_none());
        assert!(first.document.patch_digest("src/file.ts").is_some());
        assert_eq!(
            second.get_body("src/file.ts"),
            Some(patch_body("src/file.ts"))
        );
        let changed = GitReviewFilePatchBody {
            patch: Some("changed\n".into()),
            ..patch_body("src/file.ts")
        };
        let error = first.set_bodies(&mut [changed]).unwrap_err();
        assert_eq!(
            error.downcast::<GitDomainError>().unwrap().code,
            "STALE_DOCUMENT"
        );
    }

    #[test]
    fn evicts_the_least_recently_used_idle_document() {
        let clock = Rc::new(ManualClock::new(0));
        let registry = registry(GitReviewDocumentRegistryOptions {
            clock: clock.clone(),
            max_idle_documents: 2,
            ..Default::default()
        });
        let first = registry.register(registration("first")).unwrap();
        clock.advance(1);
        let second = registry.register(registration("second")).unwrap();
        clock.advance(1);
        registry.acquire("/repo", &second.id).unwrap().release();
        clock.advance(1);
        let third = registry.register(registration("third")).unwrap();
        assert!(registry.acquire("/repo", &first.id).is_none());
        assert!(registry.acquire("/repo", &second.id).is_some());
        assert!(registry.acquire("/repo", &third.id).is_some());
    }
}
