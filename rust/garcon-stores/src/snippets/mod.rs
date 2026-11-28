//! Durable snippet storage and its request validation.

type Result<T, E = Box<dyn std::error::Error>> = std::result::Result<T, E>;

pub mod errors;
pub mod service;
pub mod store;
