//! Bun-compatible default client trust shared by HTTPS and WSS.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use rustls::crypto::ring::default_provider;
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, ConfigBuilder, Error, RootCertStore, WantsVerifier};
use rustls_pki_types::pem::PemObject;

use crate::log::{Logger, create_logger};

pub fn client_config_builder() -> Result<ConfigBuilder<ClientConfig, WantsVerifier>, Error> {
    ClientConfig::builder_with_provider(Arc::new(default_provider()))
        .with_safe_default_protocol_versions()
}

pub fn verified_client_config() -> Result<ClientConfig, Error> {
    static DEFAULT: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    let builder = client_config_builder()?;
    let roots = DEFAULT.get_or_init(|| Arc::new(default_roots())).clone();
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

fn default_roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    // Bun adds OpenSSL's default paths even without NODE_USE_SYSTEM_CA.
    let file = env::var_os("SSL_CERT_FILE").unwrap_or_else(|| "/etc/ssl/cert.pem".into());
    let _ = add_pem_file(&mut roots, Path::new(&file));
    let directories = env::var_os("SSL_CERT_DIR").unwrap_or_else(|| "/etc/ssl/certs".into());
    for directory in env::split_paths(&directories) {
        if let Ok(entries) = fs::read_dir(directory) {
            for entry in entries.flatten() {
                if is_hashed_certificate(&entry.file_name().to_string_lossy())
                    && entry.path().is_file()
                {
                    let _ = add_pem_file(&mut roots, &entry.path());
                }
            }
        }
    }

    if let Some(extra) = env::var_os("NODE_EXTRA_CA_CERTS").filter(|path| !path.is_empty()) {
        let extra = PathBuf::from(extra);
        if let Err(error) = add_pem_file(&mut roots, &extra) {
            create_logger("tls-roots").warn(&format!(
                "Ignoring extra certificates from {}: {error}",
                extra.display()
            ));
        }
    }
    roots
}

fn is_hashed_certificate(name: &str) -> bool {
    name.split_once('.').is_some_and(|(hash, index)| {
        hash.len() == 8
            && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            && !index.is_empty()
            && index.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn add_pem_file(roots: &mut RootCertStore, path: &Path) -> std::io::Result<()> {
    let certificates = CertificateDer::pem_file_iter(path)
        .and_then(|certificates| certificates.collect::<Result<Vec<_>, _>>())
        .map_err(std::io::Error::other)?;
    let mut file_roots = RootCertStore::empty();
    let (added, ignored) = file_roots.add_parsable_certificates(certificates);
    if added == 0 || ignored != 0 {
        return Err(std::io::Error::other("invalid CA certificate bundle"));
    }
    roots.extend(file_roots.roots);
    Ok(())
}
