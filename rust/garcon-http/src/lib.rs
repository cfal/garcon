//! The controller's HTTP and WebSocket surface.
//!
//! Ports `server/controller/lib/http-*`, `server/controller/routes/`, and
//! `server/controller/ws/`, one module per TypeScript file.

pub mod app_title;
pub mod asset_cache;
pub mod compose_routes;
pub mod compression;
pub mod http_request;
pub mod http_route;
pub mod http_route_types;
pub mod json_route;
pub mod listener;
pub mod rate_limit;
pub mod route_table;
pub mod routes;
pub mod static_assets;
pub mod unported_routes;
