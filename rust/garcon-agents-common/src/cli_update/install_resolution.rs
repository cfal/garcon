use std::{path::Path, rc::Rc, sync::LazyLock, time::Duration};

use garcon_contract::agent_cli_update::AgentCliInstallMethod as Method;
use regress::Regex;
use serde::Serialize;

use super::{
    cli_probe::{find_executable, is_executable_file, probe_cli_version},
    cli_version::compare_cli_versions,
    installer_environment::Environment,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCommandPaths {
    pub resolved: String,
    pub real: String,
}

pub type NativeInstallerEnvironment = Rc<dyn Fn(&CliCommandPaths) -> Environment>;

pub struct NativeCliInstaller {
    pub owns_command_path: Rc<dyn Fn(&str) -> bool>,
    pub args: Vec<String>,
    pub env: Option<NativeInstallerEnvironment>,
}

pub struct CliInstallDefinition {
    pub package_name: String,
    pub native: NativeCliInstaller,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliUpdateAction {
    pub executable: String,
    pub args: Vec<String>,
    pub env: Environment,
    pub lock_key: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LatestVersionSource {
    None,
    Native,
    Npm,
    Homebrew {
        brew: String,
        name: String,
        cask: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliInstallation {
    pub method: Method,
    pub paths: Option<CliCommandPaths>,
    pub update: Option<CliUpdateAction>,
    pub manual_command: Option<String>,
    pub latest_version: LatestVersionSource,
}

pub struct CliInstallContext<'a> {
    pub command: &'a str,
    pub env: &'a Environment,
    pub platform: &'a str,
}

const TOOL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn resolve_cli_installation(
    definition: &CliInstallDefinition,
    context: CliInstallContext<'_>,
) -> CliInstallation {
    let paths = resolve_command_paths(context.command, context.env).await;
    let mut installation = CliInstallation {
        method: if paths.is_some() {
            Method::Unmanaged
        } else {
            Method::Missing
        },
        paths,
        update: None,
        manual_command: None,
        latest_version: LatestVersionSource::Npm,
    };
    let Some(paths) = &installation.paths else {
        return installation;
    };
    let normalized = [
        normalize_command_path(&paths.resolved),
        normalize_command_path(&paths.real),
    ];
    if normalized
        .iter()
        .any(|path| is_nix_store_path(path) || is_mise_path(path))
    {
        return installation;
    }
    let package = &definition.package_name;
    let npm_prefix = npm_global_prefix_from_command_path(&paths.real, package);
    if normalized
        .iter()
        .any(|path| (definition.native.owns_command_path)(path))
        && npm_prefix.is_none()
    {
        installation.method = Method::Native;
        installation.update = Some(update_action(
            &paths.resolved,
            &paths.resolved,
            definition.native.args.clone(),
            definition
                .native
                .env
                .as_ref()
                .map_or_else(Environment::new, |env| env(paths)),
            format!("native:{}", normalize_command_path(&paths.real)),
            context.platform,
        ));
        installation.latest_version = LatestVersionSource::Native;
    } else if normalized.iter().any(|path| is_bun_global_path(path)) {
        package_manager_installation(
            &mut installation,
            (Method::Bun, "bun"),
            vec!["i".into(), "-g".into(), format!("{package}@latest")],
            "bun-global".into(),
            &context,
        );
    } else if normalized.iter().any(|path| is_pnpm_global_path(path)) {
        let mut args = vec!["add".into(), "-g".into()];
        if let Some(pnpm) = find_executable("pnpm", context.env)
            && let Some(version) = probe_cli_version(&pnpm, context.env, TOOL_PROBE_TIMEOUT).await
            && compare_cli_versions(&version, "10.4.0").is_some_and(|order| order >= 0.0)
        {
            args.push(format!("--allow-build={package}"));
        }
        args.push(format!("{package}@latest"));
        package_manager_installation(
            &mut installation,
            (Method::Pnpm, "pnpm"),
            args,
            "pnpm-global".into(),
            &context,
        );
    } else if normalized.iter().any(|path| is_yarn_global_path(path)) {
        package_manager_installation(
            &mut installation,
            (Method::Yarn, "yarn"),
            vec!["global".into(), "add".into(), format!("{package}@latest")],
            "yarn-global".into(),
            &context,
        );
    } else if let Some(prefix) = npm_prefix {
        let lock = format!("npm-global:{}", normalize_command_path(&prefix));
        package_manager_installation(
            &mut installation,
            (Method::Npm, "npm"),
            vec![
                "install".into(),
                "-g".into(),
                "--prefix".into(),
                prefix,
                format!("--allow-scripts={package}"),
                format!("{package}@latest"),
            ],
            lock,
            &context,
        );
    } else if let Some(keg) = homebrew_keg_from_command_path(&paths.real) {
        homebrew_installation(&mut installation, keg, &context).await;
    }
    installation
}

fn package_manager_installation(
    installation: &mut CliInstallation,
    (method, tool): (Method, &str),
    args: Vec<String>,
    lock_key: String,
    context: &CliInstallContext<'_>,
) {
    let executable = find_executable(tool, context.env);
    let action = update_action(
        executable.as_deref().unwrap_or(tool),
        tool,
        args,
        Environment::new(),
        lock_key,
        context.platform,
    );
    installation.method = method;
    if executable.is_some() {
        installation.update = Some(action);
    } else {
        installation.manual_command = Some(action.command);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HomebrewKeg {
    pub prefix: String,
    pub name: String,
    pub cask: bool,
}

async fn homebrew_installation(
    installation: &mut CliInstallation,
    keg: HomebrewKeg,
    context: &CliInstallContext<'_>,
) {
    let keg_brew = Path::new(&keg.prefix).join("bin").join("brew");
    let brew = if tokio::fs::metadata(&keg_brew).await.is_ok() && is_executable_file(&keg_brew) {
        Some(keg_brew.to_string_lossy().into_owned())
    } else {
        find_executable("brew", context.env)
    };
    let mut args = vec!["upgrade".into()];
    if keg.cask {
        args.push("--cask".into());
    }
    args.push(keg.name.clone());
    let action = update_action(
        brew.as_deref().unwrap_or("brew"),
        "brew",
        args,
        Environment::new(),
        "homebrew".into(),
        context.platform,
    );
    installation.method = Method::Homebrew;
    if let Some(brew) = brew {
        installation.update = Some(action);
        installation.latest_version = LatestVersionSource::Homebrew {
            brew,
            name: keg.name,
            cask: keg.cask,
        };
    } else {
        installation.manual_command = Some(action.command);
    }
}

fn update_action(
    executable: &str,
    display_executable: &str,
    args: Vec<String>,
    env: Environment,
    lock_key: String,
    platform: &str,
) -> CliUpdateAction {
    let command = std::iter::once(quote_executable(display_executable, platform))
        .chain(args.iter().map(|arg| quote_shell_word(arg, platform)))
        .collect::<Vec<_>>()
        .join(" ");
    CliUpdateAction {
        executable: executable.into(),
        args,
        env,
        lock_key,
        command,
    }
}

fn normalize_command_path(command_path: &str) -> String {
    command_path.replace('\\', "/").to_lowercase()
}

async fn resolve_command_paths(command: &str, env: &Environment) -> Option<CliCommandPaths> {
    let resolved = find_executable(command, env)?;
    let real = tokio::fs::canonicalize(&resolved).await.ok()?;
    Some(CliCommandPaths {
        resolved,
        real: display_real_path(&real),
    })
}

pub(super) fn display_real_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = path.strip_prefix(r"\\?\") {
            return drive.into();
        }
    }
    path.into_owned()
}

fn is_nix_store_path(path: &str) -> bool {
    path.starts_with("/nix/store/")
}

fn is_mise_path(path: &str) -> bool {
    path.contains("/mise/shims/")
        || (path.contains("/mise/installs/") && !path.contains("/mise/installs/node/"))
}

fn is_bun_global_path(path: &str) -> bool {
    path.contains("/.bun/bin/") || path.contains("/.bun/install/global/")
}

fn is_pnpm_global_path(path: &str) -> bool {
    [
        "/.local/share/pnpm/",
        "/library/pnpm/",
        "/appdata/local/pnpm/",
        "/pnpm/global/",
    ]
    .iter()
    .any(|segment| path.contains(segment))
}

fn is_yarn_global_path(path: &str) -> bool {
    path.contains("/yarn/global/node_modules/") || path.contains("/yarn/data/global/node_modules/")
}

pub fn npm_global_prefix_from_command_path(
    real_command_path: &str,
    package_name: &str,
) -> Option<String> {
    static MISE: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"/mise/installs/([^/]+)/[^/]+$").expect("mise path pattern")
    });
    let slash_path = real_command_path.replace('\\', "/");
    let normalized = slash_path.to_lowercase();
    let package_index = normalized.rfind(&format!(
        "/lib/node_modules/{}/",
        package_name.to_lowercase()
    ))?;
    let prefix = &normalized[..package_index];
    if prefix.contains("/node_modules/") {
        return None;
    }
    if let Some(found) = MISE.find(prefix).and_then(|m| m.group(1))
        && &prefix[found] != "node"
    {
        return None;
    }
    let units = prefix.encode_utf16().count();
    Some(if units == 0 {
        "/".into()
    } else {
        String::from_utf16_lossy(&slash_path.encode_utf16().take(units).collect::<Vec<_>>())
    })
}

pub fn homebrew_keg_from_command_path(real_command_path: &str) -> Option<HomebrewKeg> {
    static KEG: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags(r"^(.*)/(Cellar|Caskroom)/([^/]+)/[^/]+/", "i")
            .expect("Homebrew keg pattern")
    });
    let path = real_command_path.replace('\\', "/");
    let matched = KEG.find(&path)?;
    let prefix = &path[matched.group(1)?];
    Some(HomebrewKeg {
        prefix: if prefix.is_empty() { "/" } else { prefix }.into(),
        name: path[matched.group(3)?].into(),
        cask: path[matched.group(2)?].eq_ignore_ascii_case("caskroom"),
    })
}

fn quote_shell_word(word: &str, platform: &str) -> String {
    let windows = platform == "win32";
    if !word.is_empty()
        && word.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b'.' | b'/' | b':' | b'@' | b'=' | b'-')
                || (windows && b == b'\\')
        })
    {
        return word.into();
    }
    if windows {
        let mut quoted = String::from("'");
        for ch in word.chars() {
            if matches!(ch, '\'' | '\u{2018}' | '\u{2019}') {
                quoted.push(ch);
            }
            quoted.push(ch);
        }
        quoted.push('\'');
        quoted
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn quote_executable(executable: &str, platform: &str) -> String {
    let quoted = quote_shell_word(executable, platform);
    if platform == "win32" && quoted != executable {
        format!("& {quoted}")
    } else {
        quoted
    }
}
