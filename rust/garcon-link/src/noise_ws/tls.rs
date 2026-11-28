//! TLS for the adapters, the Rust form of the TLS Bun provides itself: rustls
//! with default trust, with an explicit authority bundle in its place, or
//! as an unverified outer layer.

use std::sync::Arc;

use garcon_base::tls_roots::{client_config_builder, verified_client_config};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring::default_provider;
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
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
        let config = match self {
            Self::Verified => verified_client_config().map_err(|_| TlsSetup)?,
            Self::Unverified => client_config_builder()
                .map_err(|_| TlsSetup)?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(Unverified::new()))
                .with_no_client_auth(),
            Self::Authorities(pem) => client_config_builder()
                .map_err(|_| TlsSetup)?
                .with_root_certificates(explicit_roots(pem)?)
                .with_no_client_auth(),
        };
        Ok(Connector::Rustls(Arc::new(config)))
    }
}

fn explicit_roots(pem: &[u8]) -> Result<RootCertStore, TlsSetup> {
    // An explicit `ca` replaces all default trust sources.
    let certificates = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| TlsSetup)?;
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(certificates);
    if roots.is_empty() {
        return Err(TlsSetup);
    }
    Ok(roots)
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
