//! Ports `server-agents/opencode/src/agents/opencode/session-identity-plugin.ts`
//! and the pre-main module that prepares the plugin for a compiled build.

use std::cell::RefCell;
use std::error::Error;
use std::io::Write;
use std::path::{Path, PathBuf};

use uuid::Uuid;

/// The plugin OpenCode loads, which gives each shell invocation its session
/// identity. It stays JavaScript because it runs inside OpenCode.
pub const GARCON_SESSION_IDENTITY_PLUGIN: &str = include_str!("garcon-session-identity.mjs");

const PLUGIN_DIRECTORY_PREFIX: &str = "garcon-opencode-session-identity-";
const PLUGIN_FILE_NAME: &str = "garcon-session-identity.mjs";

thread_local! {
    static PLUGIN_DIRECTORY: RefCell<Option<PluginDirectory>> = const { RefCell::new(None) };
}

struct PluginDirectory(PathBuf);

impl Drop for PluginDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `pathToFileURL(pluginPath).href` for the plugin OpenCode loads.
///
/// The original reads the checked-in plugin, or the copy its pre-main module
/// wrote into a private temporary directory at process start, and fails when
/// the file is missing. A compiled binary holds nothing beside its code, so
/// this writes the embedded copy the first time the URL is asked for.
pub fn resolve_session_identity_plugin_url() -> Result<String, Box<dyn Error>> {
    let directory = PLUGIN_DIRECTORY.with(|directory| {
        directory
            .borrow()
            .as_ref()
            .map(|directory| directory.0.clone())
    });
    let directory = match directory {
        Some(directory) => directory,
        None => write_plugin()?,
    };
    let plugin_path = directory.join(PLUGIN_FILE_NAME);
    if !plugin_path.is_file() {
        return Err(missing_plugin(&plugin_path));
    }
    Ok(path_to_file_url(&plugin_path.to_string_lossy()))
}

fn missing_plugin(plugin_path: &Path) -> Box<dyn Error> {
    crate::js::error(
        "Error",
        format!(
            "Garcon's bundled OpenCode session identity plugin is missing: {}",
            plugin_path.display()
        ),
    )
}

// Writes the plugin into a new private directory of the temporary directory.
fn write_plugin() -> Result<PathBuf, Box<dyn Error>> {
    let directory = create_private_directory()?;
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(directory.join(PLUGIN_FILE_NAME))?;
        output.write_all(GARCON_SESSION_IDENTITY_PLUGIN.as_bytes())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error.into());
    }
    PLUGIN_DIRECTORY.with(|stored| *stored.borrow_mut() = Some(PluginDirectory(directory.clone())));
    Ok(directory)
}

// A directory that exists for this process alone, as `mkdtemp` makes one.
#[cfg(unix)]
fn create_private_directory() -> Result<PathBuf, Box<dyn Error>> {
    use std::os::unix::fs::DirBuilderExt;

    for _ in 0..3 {
        let directory = temporary_directory().join(format!(
            "{PLUGIN_DIRECTORY_PREFIX}{}",
            Uuid::new_v4().simple()
        ));
        match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(crate::js::error(
        "Error",
        "Could not create a private directory for the OpenCode session identity plugin",
    ))
}

#[cfg(windows)]
fn create_private_directory() -> Result<PathBuf, Box<dyn Error>> {
    let directory = temporary_directory().join(format!(
        "{PLUGIN_DIRECTORY_PREFIX}{}",
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir(&directory)?;
    Ok(directory)
}

// `os.tmpdir()`: the first of TMPDIR, TMP, and TEMP that is set to a
// non-blank value.
fn temporary_directory() -> PathBuf {
    for name in ["TMPDIR", "TMP", "TEMP"] {
        if let Some(value) = std::env::var_os(name)
            && !value.is_empty()
        {
            return PathBuf::from(value);
        }
    }
    std::env::temp_dir()
}

// `pathToFileURL(path).href`: the absolute path as a `file:` URL whose
// pathname keeps what the URL path set leaves alone.
#[cfg(unix)]
pub fn path_to_file_url(path: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    let resolved = garcon_js::path::posix::resolve(&cwd, &[path]);
    let mut url = String::from("file://");
    for byte in resolved.bytes() {
        match byte {
            b'%' => url.push_str("%25"),
            b'\\' => url.push_str("%5C"),
            b'\n' => url.push_str("%0A"),
            b'\r' => url.push_str("%0D"),
            b'\t' => url.push_str("%09"),
            // Bun also encodes brackets, caret, pipe, and tilde in file URL paths.
            0x00..=0x20
            | 0x22
            | 0x23
            | 0x3C
            | 0x3E
            | 0x3F
            | 0x5B
            | 0x5D
            | 0x5E
            | 0x60
            | 0x7B..=0xFF => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                url.push('%');
                url.push(HEX[usize::from(byte >> 4)] as char);
                url.push(HEX[usize::from(byte & 0x0F)] as char);
            }
            _ => url.push(byte as char),
        }
    }
    url
}

// Bun.which and the plugin path were probed on POSIX alone; a Windows path
// becomes the URL Windows tools expect, with its drive in the pathname.
#[cfg(windows)]
pub fn path_to_file_url(path: &str) -> String {
    let resolved = garcon_js::path::win32::resolve(
        &std::env::current_dir()
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .unwrap_or_default(),
        &[path],
    );
    let (host, rest) = match resolved.split_once(r"\\") {
        Some((host, rest)) if !host.is_empty() => (host, rest),
        _ => ("", resolved.as_str()),
    };
    let mut url = format!("file://{host}/");
    for byte in rest.bytes() {
        match byte {
            b'\\' => url.push('/'),
            0x00..=0x20
            | 0x22
            | 0x23
            | 0x25
            | 0x3C
            | 0x3E
            | 0x3F
            | 0x5B
            | 0x5D
            | 0x5E
            | 0x60
            | 0x7B..=0xFF => {
                url.push_str(&format!("%{byte:02X}"));
            }
            _ => url.push(byte as char),
        }
    }
    url
}
