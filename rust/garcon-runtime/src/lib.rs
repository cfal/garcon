//! Executor-local runtime services shared by Local and remote workers.

use std::ffi::OsString;
use std::rc::Rc;

mod cancellation;
pub mod files;
pub mod git;
pub mod projects;
pub mod terminals;

pub type ChildEnvironment = Rc<[(OsString, OsString)]>;
