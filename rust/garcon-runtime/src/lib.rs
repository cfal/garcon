//! Executor-local runtime services shared by Local and remote workers.

use std::ffi::OsString;
use std::rc::Rc;

pub mod agents;
mod cancellation;
pub mod files;
pub mod gh;
pub mod git;
pub mod projects;
pub mod providers;
pub mod terminals;

pub type ChildEnvironment = Rc<[(OsString, OsString)]>;
