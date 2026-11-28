pub mod commit_history;
pub mod comparison;
pub mod comparison_errors;
pub mod conflicts;
pub mod diff_engine;
pub mod diff_file_list;
pub mod discard;
pub mod file_history;
pub mod git_domain_error;
pub mod git_error_classifier;
pub mod git_service;
pub mod log_records;
pub mod operation_context;
pub mod pathspecs;
pub mod porcelain_status;
pub mod push_branch;
pub mod quick_summary;
pub mod ref_validation;
pub mod repository_coordination;
pub mod review_diff_batch;
pub mod review_document_registry;
pub mod review_document_service;
pub mod review_patch;
pub mod review_performance;
pub mod run;
pub mod runtime;
pub mod selected_file_commit;
pub mod service_errors;
pub mod stashes;
pub mod status;
pub mod temporary_index;
pub mod types;
pub mod untracked_patch;
pub mod working_path_token;
pub mod working_tree_comparison;
pub mod working_tree_observation;
pub mod worktree_admin;
pub mod worktree_layout;
pub mod worktree_porcelain;
pub mod worktree_record;
pub mod worktrees;

#[cfg(test)]
mod comparison_tests;
#[cfg(test)]
mod diff_engine_tests;
#[cfg(test)]
#[path = "../../tests/support/git_fixture.rs"]
mod git_fixture;
#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod read_tests;
#[cfg(test)]
mod review_bodies_tests;
#[cfg(all(test, unix))]
mod run_tests;
#[cfg(test)]
mod runtime_tests;
