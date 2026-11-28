#[path = "history_loader/legacy.rs"]
mod legacy;

#[cfg(unix)]
#[path = "history_loader/paginated.rs"]
mod paginated;
