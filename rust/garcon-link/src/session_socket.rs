//! Ports `server/remote/transport/session-socket.ts`.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};

use crate::message_session::{MessageContinuityError, SessionError, SessionSocket};
use crate::noise_ws::{NoiseConnection, NoiseMessage};

pub const SESSION_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const FRAGMENT_BYTES: usize = 32 * 1024;
pub const SESSION_SOCKET_BUFFER_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Session socket is not writable")]
struct NotWritable;

#[derive(Default)]
struct State {
    received: Vec<u8>,
    sending: Option<String>,
    offset: usize,
    retry: Option<JoinHandle<()>>,
}

type Disconnect = Rc<dyn Fn()>;
type WriteFailed = Rc<dyn Fn(SessionError)>;

struct Frames {
    socket: Rc<NoiseConnection>,
    disconnect: Disconnect,
    write_failed: Option<WriteFailed>,
    state: RefCell<State>,
}

pub struct SessionSocketFrames(Rc<Frames>);

impl SessionSocketFrames {
    pub fn new(
        socket: Rc<NoiseConnection>,
        disconnect: Disconnect,
        write_failed: Option<WriteFailed>,
    ) -> Self {
        Self(Rc::new(Frames {
            socket,
            disconnect,
            write_failed,
            state: RefCell::default(),
        }))
    }

    pub fn receive(&self, fragment: &[u8]) -> Result<Option<String>, MessageContinuityError> {
        receive_fragment(&mut self.0.state.borrow_mut().received, fragment)
    }

    pub fn dispose(&self) {
        self.0.dispose();
    }
}

impl SessionSocket for SessionSocketFrames {
    fn can_send(&self, _bytes: usize) -> bool {
        self.0.state.borrow().sending.is_none()
            && self.0.socket.buffered_amount() < SESSION_SOCKET_BUFFER_BYTES
    }

    fn send(&self, encoded: String) -> Result<(), SessionError> {
        if !self.can_send(encoded.len()) {
            return Err(Rc::new(NotWritable));
        }
        if encoded.len() > SESSION_MESSAGE_BYTES {
            return Err(Rc::new(MessageContinuityError(
                "Message exceeds frame budget",
            )));
        }
        {
            let mut state = self.0.state.borrow_mut();
            state.sending = Some(encoded);
            state.offset = 0;
        }
        self.0.flush();
        Ok(())
    }

    fn close(&self) {
        self.dispose();
        (self.0.disconnect)();
    }
}

fn receive_fragment(
    received: &mut Vec<u8>,
    fragment: &[u8],
) -> Result<Option<String>, MessageContinuityError> {
    if !(2..=FRAGMENT_BYTES + 1).contains(&fragment.len())
        || fragment[0] > 1
        || fragment[0] == 0 && fragment.len() != FRAGMENT_BYTES + 1
        || received.len() + fragment.len() - 1 > SESSION_MESSAGE_BYTES
    {
        return Err(MessageContinuityError("Invalid session message fragment"));
    }
    received.extend_from_slice(&fragment[1..]);
    if fragment[0] == 0 {
        return Ok(None);
    }
    let mut message = String::from_utf8(std::mem::take(received))
        .map_err(|_| MessageContinuityError("Invalid session message encoding"))?;
    if message.starts_with('\u{FEFF}') {
        message.drain(..3);
    }
    Ok(Some(message))
}

impl Frames {
    fn dispose(&self) {
        let mut state = self.state.borrow_mut();
        if let Some(retry) = state.retry.take() {
            retry.abort();
        }
        state.sending = None;
        state.received = Vec::new();
    }

    fn flush(self: &Rc<Self>) {
        while self.socket.buffered_amount() < SESSION_SOCKET_BUFFER_BYTES {
            let frame = {
                let mut state = self.state.borrow_mut();
                let Some(sending) = &state.sending else {
                    return;
                };
                let end = (state.offset + FRAGMENT_BYTES).min(sending.len());
                let complete = end == sending.len();
                let mut fragment = Vec::with_capacity(end - state.offset + 1);
                fragment.push(u8::from(complete));
                fragment.extend_from_slice(&sending.as_bytes()[state.offset..end]);
                state.offset = end;
                if complete {
                    state.sending = None;
                }
                fragment
            };
            if let Err(error) = self.socket.send(NoiseMessage::Binary(frame)) {
                self.dispose();
                if let Some(write_failed) = &self.write_failed {
                    write_failed(Rc::new(error));
                } else {
                    (self.disconnect)();
                }
                return;
            }
        }
        let mut state = self.state.borrow_mut();
        if state.sending.is_some() {
            let frames = Rc::clone(self);
            let deadline = Instant::now() + Duration::from_millis(10);
            state.retry = Some(spawn_local(async move {
                sleep_until(deadline).await;
                frames.state.borrow_mut().retry = None;
                frames.flush();
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reassembles_utf8_crossing_fragment_boundaries_and_strips_one_leading_bom() {
        let mut received = Vec::new();
        let mut first = vec![b'x'; FRAGMENT_BYTES + 1];
        first[0] = 0;
        first[1..4].copy_from_slice(b"\xef\xbb\xbf");
        first[FRAGMENT_BYTES] = 0xc2;
        assert_eq!(receive_fragment(&mut received, &first), Ok(None));
        assert_eq!(
            receive_fragment(&mut received, &[1, 0xa2]),
            Ok(Some(format!("{}\u{00a2}", "x".repeat(FRAGMENT_BYTES - 4)))),
        );
        assert!(received.is_empty());
    }

    #[test]
    fn malformed_fragments_fail_without_exposing_content() {
        let mut received = Vec::new();
        for frame in [&[][..], &[1][..], &[0, b'X'][..], &[2, b'X'][..]] {
            assert_eq!(
                receive_fragment(&mut received, frame),
                Err(MessageContinuityError("Invalid session message fragment"))
            );
        }
        assert_eq!(
            receive_fragment(&mut received, &[1, 0xff]),
            Err(MessageContinuityError("Invalid session message encoding"))
        );
        assert!(received.is_empty());
    }
}
