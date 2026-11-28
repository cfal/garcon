//! TLS for the adapters, the Rust form of the TLS Bun provides itself: rustls
//! with default trust, with an explicit authority bundle in its place, or
//! as an unverified outer layer.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use garcon_base::log::{Logger, create_logger};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring::default_provider;
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::pem::PemObject;
use tokio_tungstenite::Connector;

/// How a `wss:` dial verifies the outer TLS layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientTls {
    Verified,
    Unverified,
    Authorities(Vec<u8>),
}

/// A trust bundle that does not hold one usable certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TlsSetup;

impl ClientTls {
    pub fn new(ca: Option<&[u8]>, allow_unverified: bool) -> Self {
        if allow_unverified {
            return Self::Unverified;
        }
        match ca {
            Some(pem) => Self::Authorities(pem.to_vec()),
            None => Self::Verified,
        }
    }

    pub fn connector(&self) -> Result<Connector, TlsSetup> {
        let builder = ClientConfig::builder_with_provider(Arc::new(default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| TlsSetup)?;
        let config = if *self == Self::Unverified {
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(Unverified::new()))
                .with_no_client_auth()
        } else {
            builder
                .with_root_certificates(self.roots()?)
                .with_no_client_auth()
        };
        Ok(Connector::Rustls(Arc::new(config)))
    }

    fn roots(&self) -> Result<Arc<RootCertStore>, TlsSetup> {
        let Self::Authorities(pem) = self else {
            static DEFAULT: OnceLock<Arc<RootCertStore>> = OnceLock::new();
            return Ok(Arc::clone(
                DEFAULT.get_or_init(|| Arc::new(default_roots())),
            ));
        };
        // An explicit `ca` replaces all default trust sources.
        let certificates = CertificateDer::pem_slice_iter(pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| TlsSetup)?;
        let mut roots = RootCertStore::empty();
        roots.add_parsable_certificates(certificates);
        if roots.is_empty() {
            return Err(TlsSetup);
        }
        Ok(Arc::new(roots))
    }
}

fn default_roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    // Bun's WebSocket store includes the OpenSSL default paths even without
    // NODE_USE_SYSTEM_CA. Each environment override replaces just its path.
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
            create_logger("noise-ws").warn(&format!(
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

/// `rejectUnauthorized: false`: any certificate chain and host is accepted.
/// Noise authentication stays mandatory on top.
#[derive(Debug)]
struct Unverified {
    algorithms: WebPkiSupportedAlgorithms,
}

impl Unverified {
    fn new() -> Self {
        Self {
            algorithms: default_provider().signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for Unverified {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
