use garcon_base::errors::NamedError;
use tokio_util::sync::CancellationToken;

pub(crate) fn abort_error(message: &str) -> NamedError {
    NamedError {
        name: "AbortError".to_owned(),
        message: message.to_owned(),
        code: None,
    }
}

pub(crate) fn check_cancelled(signal: Option<&CancellationToken>) -> Result<(), NamedError> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        Err(abort_error("The operation was aborted."))
    } else {
        Ok(())
    }
}
