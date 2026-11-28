//! Node system error codes for Rust I/O errors.

use std::io::{Error, ErrorKind};

pub(super) fn node_io_code(error: &Error) -> Option<&'static str> {
    match error.raw_os_error() {
        Some(raw) => raw_node_code(raw),
        None => match error.kind() {
            ErrorKind::NotFound => Some("ENOENT"),
            ErrorKind::PermissionDenied => Some("EACCES"),
            ErrorKind::AlreadyExists => Some("EEXIST"),
            ErrorKind::NotADirectory => Some("ENOTDIR"),
            ErrorKind::IsADirectory => Some("EISDIR"),
            ErrorKind::DirectoryNotEmpty => Some("ENOTEMPTY"),
            ErrorKind::InvalidInput => Some("EINVAL"),
            ErrorKind::ReadOnlyFilesystem => Some("EROFS"),
            ErrorKind::ResourceBusy => Some("EBUSY"),
            ErrorKind::NotConnected => Some("ENOTCONN"),
            ErrorKind::Interrupted => Some("EINTR"),
            ErrorKind::WouldBlock => Some("EAGAIN"),
            ErrorKind::BrokenPipe => Some("EPIPE"),
            ErrorKind::TimedOut => Some("ETIMEDOUT"),
            ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
            ErrorKind::ConnectionReset => Some("ECONNRESET"),
            ErrorKind::ConnectionAborted => Some("ECONNABORTED"),
            ErrorKind::AddrInUse => Some("EADDRINUSE"),
            ErrorKind::Unsupported => Some("ENOTSUP"),
            _ => None,
        },
    }
}

#[cfg(unix)]
fn raw_node_code(raw: i32) -> Option<&'static str> {
    Some(match raw {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EEXIST => "EEXIST",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EINVAL => "EINVAL",
        libc::EROFS => "EROFS",
        libc::EBUSY => "EBUSY",
        libc::ESRCH => "ESRCH",
        libc::ENOTCONN => "ENOTCONN",
        libc::ESTALE => "ESTALE",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EIO => "EIO",
        libc::ENOSPC => "ENOSPC",
        libc::ENOMEM => "ENOMEM",
        libc::ENOTSUP => "ENOTSUP",
        #[cfg(target_vendor = "apple")]
        libc::EOPNOTSUPP => "EOPNOTSUPP",
        libc::EXDEV => "EXDEV",
        libc::EBADF => "EBADF",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::EFBIG => "EFBIG",
        libc::EINTR => "EINTR",
        libc::EAGAIN => "EAGAIN",
        libc::EPIPE => "EPIPE",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ECONNRESET => "ECONNRESET",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::EADDRINUSE => "EADDRINUSE",
        _ => return None,
    })
}

#[cfg(windows)]
fn raw_node_code(raw: i32) -> Option<&'static str> {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Networking::WinSock::{
        WSAEACCES, WSAEADDRINUSE, WSAECONNABORTED, WSAECONNREFUSED, WSAECONNRESET, WSAEINVAL,
        WSAENOTCONN, WSAEOPNOTSUPP, WSAETIMEDOUT, WSAEWOULDBLOCK,
    };

    // Bun 1.4.3's init_win32_error maps GetLastError codes before exposing .code.
    // https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/errno/windows_errno.rs#L642
    let raw = raw as u32;
    let win32 = if (raw >> 16) == 0x8007 {
        raw & 0xffff
    } else {
        raw
    };
    let network = match win32 as i32 {
        WSAEACCES => Some("EACCES"),
        WSAENOTCONN => Some("ENOTCONN"),
        WSAEINVAL => Some("EINVAL"),
        WSAEOPNOTSUPP => Some("ENOTSUP"),
        WSAEWOULDBLOCK => Some("EAGAIN"),
        WSAETIMEDOUT => Some("ETIMEDOUT"),
        WSAECONNREFUSED => Some("ECONNREFUSED"),
        WSAECONNRESET => Some("ECONNRESET"),
        WSAECONNABORTED => Some("ECONNABORTED"),
        WSAEADDRINUSE => Some("EADDRINUSE"),
        _ => None,
    };
    network.or_else(|| {
        Some(match win32 {
            ERROR_FILE_NOT_FOUND
            | ERROR_PATH_NOT_FOUND
            | ERROR_INVALID_NAME
            | ERROR_INVALID_DRIVE
            | ERROR_BAD_PATHNAME
            | ERROR_ENVVAR_NOT_FOUND
            | ERROR_INVALID_REPARSE_DATA
            | ERROR_MOD_NOT_FOUND => "ENOENT",
            ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => "EPERM",
            ERROR_NOACCESS | ERROR_CANT_ACCESS_FILE | ERROR_ELEVATION_REQUIRED => "EACCES",
            ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => "EEXIST",
            ERROR_DIRECTORY => "ENOTDIR",
            ERROR_INVALID_FUNCTION => "EISDIR",
            ERROR_CANT_RESOLVE_FILENAME => "ELOOP",
            ERROR_FILENAME_EXCED_RANGE => "ENAMETOOLONG",
            ERROR_INVALID_PARAMETER
            | ERROR_INSUFFICIENT_BUFFER
            | ERROR_INVALID_DATA
            | ERROR_SYMLINK_NOT_SUPPORTED => "EINVAL",
            ERROR_WRITE_PROTECT => "EROFS",
            ERROR_LOCK_VIOLATION
            | ERROR_PIPE_BUSY
            | ERROR_SHARING_VIOLATION
            | ERROR_DELETE_PENDING => "EBUSY",
            ERROR_NOT_CONNECTED => "ENOTCONN",
            ERROR_DIR_NOT_EMPTY => "ENOTEMPTY",
            ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => "ENOSPC",
            ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY => "ENOMEM",
            ERROR_NOT_SUPPORTED => "ENOTSUP",
            ERROR_NOT_SAME_DEVICE => "EXDEV",
            ERROR_INVALID_HANDLE | ERROR_INVALID_FLAGS => "EBADF",
            ERROR_TOO_MANY_OPEN_FILES => "EMFILE",
            ERROR_BROKEN_PIPE | ERROR_BAD_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED => {
                "EPIPE"
            }
            ERROR_SEM_TIMEOUT => "ETIMEDOUT",
            ERROR_CONNECTION_REFUSED => "ECONNREFUSED",
            ERROR_NETNAME_DELETED => "ECONNRESET",
            ERROR_CONNECTION_ABORTED => "ECONNABORTED",
            ERROR_ADDRESS_ALREADY_ASSOCIATED => "EADDRINUSE",
            ERROR_OPERATION_ABORTED => "ECANCELED",
            ERROR_GEN_FAILURE | ERROR_CRC | ERROR_IO_DEVICE => "EIO",
            _ => return None,
        })
    })
}
