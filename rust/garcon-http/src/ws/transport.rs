//! Browser framing and client-facing outbound buffering.

use std::cell::{Cell, RefCell};
use std::future::poll_fn;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use futures::Sink;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Instant;
use yawc::close::CloseCode;
use yawc::{Frame, OpCode, Options, Role, WebSocket, WebSocketError};

use crate::websocket_auth::BrowserClose;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendResult {
    Sent(usize),
    Queued,
    Dropped,
}

pub(crate) trait PrimaryTransport {
    fn send(&self, payload: Bytes) -> SendResult;
    fn buffered_amount(&self) -> usize;
    fn close(&self, close: BrowserClose);
    fn terminate(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SocketState {
    Open,
    Closing,
    Terminated,
}

pub(crate) struct BrowserTransport<S> {
    codec: RefCell<WebSocket<ClientSocket<S>>>,
    socket: Rc<RefCell<ClientWrites<S>>>,
    task: RefCell<Option<Waker>>,
    state: Cell<SocketState>,
}

struct ClientWrites<S> {
    socket: S,
    pending: BytesMut,
    hard_limit: usize,
    last_input: Instant,
}

impl<S: AsyncWrite + Unpin> ClientWrites<S> {
    fn poll_drain(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.pending.is_empty() {
            let written =
                std::task::ready!(Pin::new(&mut self.socket).poll_write(cx, &self.pending))?;
            if written == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
            self.pending.advance(written);
        }
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn stage(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> io::Result<usize> {
        if self.hard_limit != 0 && self.pending.len() > self.hard_limit {
            return Err(io::Error::other(
                "WebSocket native send queue exceeded its limit",
            ));
        }
        let written = match self.poll_drain(cx) {
            Poll::Ready(Ok(())) => match Pin::new(&mut self.socket).poll_write(cx, bytes) {
                Poll::Ready(result) => result?,
                Poll::Pending => 0,
            },
            Poll::Ready(Err(error)) => return Err(error),
            Poll::Pending => 0,
        };
        self.pending.extend_from_slice(&bytes[written..]);
        Ok(bytes.len())
    }
}

struct ClientSocket<S>(Rc<RefCell<ClientWrites<S>>>);

impl<S: AsyncRead + Unpin> AsyncRead for ClientSocket<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut socket = self.0.borrow_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut socket.socket).poll_read(cx, buf);
        if buf.filled().len() > before {
            socket.last_input = Instant::now();
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ClientSocket<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(self.0.borrow_mut().stage(cx, bytes))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // The codec hands off encoded bytes synchronously; the socket loop
        // flushes staged bytes independently of reads and the codec.
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut state = self.0.borrow_mut();
        std::task::ready!(state.poll_drain(cx))?;
        Pin::new(&mut state.socket).poll_shutdown(cx)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> BrowserTransport<S> {
    pub(crate) fn new(
        socket: S,
        extension: Option<&str>,
        shared_message_limit: usize,
        hard_write_limit: usize,
    ) -> yawc::Result<Rc<Self>> {
        let socket = Rc::new(RefCell::new(ClientWrites {
            socket,
            pending: BytesMut::new(),
            hard_limit: hard_write_limit,
            last_input: Instant::now(),
        }));
        // The inflater checks an exclusive boundary; the shared Bun limit is inclusive.
        let limit = shared_message_limit.saturating_add(1);
        let options = Options::default()
            .with_limits(limit, limit)
            .with_utf8()
            .with_balanced_compression()
            .with_compression_threshold(0);
        let codec = WebSocket::from_stream_with_extensions(
            ClientSocket(Rc::clone(&socket)),
            Role::Server,
            extension,
            options,
        )?;
        Ok(Rc::new(Self {
            codec: RefCell::new(codec),
            socket,
            task: RefCell::new(None),
            state: Cell::new(SocketState::Open),
        }))
    }

    pub(crate) fn poll_frame(&self, cx: &mut Context<'_>) -> Poll<yawc::Result<Option<Frame>>> {
        self.task.replace(Some(cx.waker().clone()));
        if self.state.get() != SocketState::Open {
            return Poll::Ready(Ok(None));
        }
        if let Poll::Ready(Err(error)) = self.socket.borrow_mut().poll_drain(cx) {
            return Poll::Ready(Err(error.into()));
        }
        let mut codec = self.codec.borrow_mut();
        let result = std::task::ready!(codec.poll_next_frame(cx));
        if let Ok(frame) = &result {
            match frame.opcode() {
                OpCode::Ping => {
                    // The codec stages the owed pong when the sink is driven.
                    if let Poll::Ready(Err(error)) = Pin::new(&mut *codec).poll_ready(cx) {
                        return Poll::Ready(Err(error));
                    }
                }
                OpCode::Close => {
                    // Stages the protocol's own close acknowledgement, without
                    // waiting for more input after the application retires it.
                    let _ = codec.poll_next_frame(cx);
                    self.state.set(SocketState::Closing);
                }
                _ => {}
            }
        }
        Poll::Ready(result.map(Some))
    }

    pub(crate) fn ping(&self) -> yawc::Result<()> {
        self.queue_frame(Frame::ping(&b""[..]))
    }

    pub(crate) fn last_input(&self) -> Instant {
        self.socket.borrow().last_input
    }

    pub(crate) async fn finish(&self) {
        if self.state.get() == SocketState::Closing {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                poll_fn(|cx| self.socket.borrow_mut().poll_drain(cx)),
            )
            .await;
        }
    }

    fn queue_frame(&self, frame: Frame) -> yawc::Result<()> {
        let task = self.task.borrow().clone();
        let mut cx = Context::from_waker(task.as_ref().unwrap_or(Waker::noop()));
        let mut codec = self.codec.borrow_mut();
        let mut sink = Pin::new(&mut *codec);
        match sink.as_mut().poll_ready(&mut cx) {
            Poll::Ready(result) => result?,
            Poll::Pending => return Err(unexpected_pending()),
        }
        sink.as_mut().start_send(frame)?;
        match sink.poll_flush(&mut cx) {
            Poll::Ready(result) => result?,
            Poll::Pending => return Err(unexpected_pending()),
        }
        if self.buffered_amount() > 0
            && let Some(task) = task
        {
            task.wake();
        }
        Ok(())
    }

    fn wake(&self) {
        if let Some(task) = self.task.borrow().as_ref() {
            task.wake_by_ref();
        }
    }
}

fn unexpected_pending() -> WebSocketError {
    io::Error::other("WebSocket codec did not finish staging an outbound frame").into()
}

impl<S: AsyncRead + AsyncWrite + Unpin> PrimaryTransport for BrowserTransport<S> {
    fn send(&self, payload: Bytes) -> SendResult {
        if self.state.get() != SocketState::Open {
            return SendResult::Dropped;
        }
        let bytes = payload.len();
        if self.queue_frame(Frame::text(payload)).is_err() {
            self.terminate();
            return SendResult::Dropped;
        }
        if self.buffered_amount() == 0 {
            SendResult::Sent(bytes)
        } else {
            SendResult::Queued
        }
    }

    fn buffered_amount(&self) -> usize {
        self.socket.borrow().pending.len()
    }

    fn close(&self, close: BrowserClose) {
        if self.state.get() != SocketState::Open {
            return;
        }
        if self
            .queue_frame(Frame::close(CloseCode::from(close.code), close.reason))
            .is_err()
        {
            self.terminate();
            return;
        }
        self.state.set(SocketState::Closing);
        self.wake();
    }

    fn terminate(&self) {
        self.state.set(SocketState::Terminated);
        self.socket.borrow_mut().pending.clear();
        self.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    #[tokio::test]
    async fn counts_only_encoded_bytes_that_the_client_socket_did_not_accept() {
        let (socket, mut client) = duplex(16);
        let peer = BrowserTransport::new(socket, None, 1024, 1024).unwrap();
        let data = Bytes::from(vec![b'a'; 80]);
        assert_eq!(peer.send(data.clone()), SendResult::Queued);
        assert_eq!(peer.buffered_amount(), 66);

        let read = async {
            let mut wire = [0; 82];
            client.read_exact(&mut wire).await.unwrap();
            assert_eq!(&wire[..2], &[0x81, 80]);
            assert_eq!(&wire[2..], data.as_ref());
        };
        let drain = poll_fn(|cx| peer.socket.borrow_mut().poll_drain(cx));
        let (_, drained) = tokio::join!(read, drain);
        drained.unwrap();
        assert_eq!(peer.buffered_amount(), 0);
    }

    #[test]
    fn bases_backpressure_on_compressed_wire_bytes() {
        let (socket, _client) = duplex(1);
        let peer = BrowserTransport::new(
            socket,
            Some("permessage-deflate; client_no_context_takeover; server_no_context_takeover"),
            65_535,
            65_535,
        )
        .unwrap();
        let data = Bytes::from(vec![b'x'; 32_768]);
        assert_eq!(peer.send(data), SendResult::Queued);
        assert!(peer.buffered_amount() < 1024);
    }

    #[tokio::test]
    async fn preserves_control_ping_payload_and_named_application_close() {
        let (socket, mut client) = duplex(1024);
        let peer = BrowserTransport::new(socket, None, 1024, 1024).unwrap();
        let mask = [1, 2, 3, 4];
        client
            .write_all(&[
                0x89,
                0x83,
                1,
                2,
                3,
                4,
                b'a' ^ mask[0],
                b'b' ^ mask[1],
                b'c' ^ mask[2],
            ])
            .await
            .unwrap();
        let ping = poll_fn(|cx| peer.poll_frame(cx)).await.unwrap().unwrap();
        assert_eq!(ping.opcode(), OpCode::Ping);
        assert_eq!(ping.payload(), &Bytes::from_static(b"abc"));

        let mut pong = [0; 5];
        client.read_exact(&mut pong).await.unwrap();
        assert_eq!(&pong, b"\x8a\x03abc");

        peer.ping().unwrap();
        let mut automatic = [0; 2];
        client.read_exact(&mut automatic).await.unwrap();
        assert_eq!(&automatic, b"\x89\x00");

        peer.close(BrowserClose {
            code: 4001,
            reason: "AUTH_REVOKED",
        });
        peer.finish().await;
        let mut close = [0; 16];
        client.read_exact(&mut close).await.unwrap();
        assert_eq!(&close, b"\x88\x0e\x0f\xa1AUTH_REVOKED");
    }
}
