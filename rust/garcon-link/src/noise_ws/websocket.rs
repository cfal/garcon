//! The native WebSocket transport of the adapters, on tokio-tungstenite. The
//! original has this part from Bun: a socket that queues writes, reports the
//! bytes still queued, and closes with code 1000 or terminates.

use std::cell::Cell;
use std::collections::VecDeque;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::poll_fn;
use futures::{Sink, SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::spawn_local;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_util::sync::CancellationToken;

use super::connection::{NoiseConnection, NoiseFrame, NoiseTransport, RejectedWrite};
use super::errors::NoiseErrorCode;
use super::options::MAX_FRAME_BYTES;

/// `maxPayloadLength: MAX_FRAME_BYTES` of the dedicated listener. The client
/// bounds what it reads the same way, before the connection sees it.
pub(super) fn frame_limit() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES))
}

/// The dedicated listener's `backpressureLimit` with `closeOnBackpressureLimit`.
const BACKPRESSURE_LIMIT: usize = 128 * 1024 * 1024;
/// How long our close frame waits for the peer's before the socket is dropped.
const CLOSE_HANDSHAKE: std::time::Duration = std::time::Duration::from_secs(30);

/// Which side the stream serves: only the dedicated listener has a
/// `backpressureLimit` that closes a socket.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Side {
    Client,
    Server,
}

enum Outbound {
    Frame(Vec<u8>),
    Close,
}

/// Why the driver left the loop that serves the connection.
enum End {
    /// The connection is finished and reported an error; the socket is only dropped.
    Aborted,
    /// The connection is finished and closed well; the socket closes with code 1000.
    Closing,
    /// The peer sent its close frame, which Bun reports as a `close` event.
    PeerClosed,
    Failed(NoiseErrorCode),
}

pub(super) struct WebSocketTransport {
    outgoing: UnboundedSender<Outbound>,
    aborted: CancellationToken,
    /// Wire bytes handed to `write` and not yet flushed to the socket.
    buffered: Rc<Cell<usize>>,
}

impl WebSocketTransport {
    /// Starts driving `stream` for `socket` and returns the transport to attach.
    pub(super) fn start<S>(
        socket: Rc<NoiseConnection>,
        stream: WebSocketStream<S>,
        side: Side,
    ) -> Rc<Self>
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static,
    {
        let (outgoing, signals) = unbounded();
        let buffered = Rc::new(Cell::new(0));
        let aborted = CancellationToken::new();
        spawn_local(drive(
            socket,
            stream,
            signals,
            Rc::clone(&buffered),
            aborted.clone(),
            side,
        ));
        Rc::new(Self {
            outgoing,
            buffered,
            aborted,
        })
    }
}

impl NoiseTransport for WebSocketTransport {
    fn buffered_amount(&self) -> usize {
        self.buffered.get()
    }

    fn write(&self, frame: Vec<u8>) -> Result<(), RejectedWrite> {
        let length = frame.len();
        self.outgoing
            .unbounded_send(Outbound::Frame(frame))
            .map_err(|_| RejectedWrite)?;
        self.buffered.set(self.buffered.get() + length);
        Ok(())
    }

    fn close(&self) {
        let _ = self.outgoing.unbounded_send(Outbound::Close);
    }

    fn abort(&self) {
        self.aborted.cancel();
    }
}

/// How a failed stream reaches the connection. Once the socket is open, Bun
/// reports every failure only as a `close` event, on either side: a reset, a
/// bare end of stream, a protocol violation, and a close frame alike. An
/// oversized message is delivered to the connection before Bun closes it.
fn failure(error: &WebSocketError) -> NoiseErrorCode {
    match error {
        WebSocketError::Capacity(_) => NoiseErrorCode::ProtocolError,
        _ => NoiseErrorCode::TransportClosed,
    }
}

/// Hands every queued frame to the socket. What is left when the socket would
/// block stays in the sink, so a poll that is dropped loses nothing.
fn flush<S>(
    writer: &mut futures::stream::SplitSink<WebSocketStream<S>, Message>,
    pending: &mut VecDeque<Vec<u8>>,
    flushing_bytes: &mut usize,
    cx: &mut Context<'_>,
) -> Poll<Result<(), WebSocketError>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut sink = Pin::new(writer);
    while let Some(frame) = pending.pop_front() {
        match sink.as_mut().poll_ready(cx) {
            Poll::Ready(Ok(())) => {}
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Pending => {
                pending.push_front(frame);
                return Poll::Pending;
            }
        }
        *flushing_bytes += frame.len();
        if let Err(error) = sink
            .as_mut()
            .start_send(Message::Binary(Bytes::from(frame)))
        {
            return Poll::Ready(Err(error));
        }
    }
    sink.poll_flush(cx)
}

/// Reads until the peer's close frame.
async fn peer_close<S>(reader: &mut futures::stream::SplitStream<WebSocketStream<S>>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    while let Some(Ok(message)) = reader.next().await {
        if matches!(message, Message::Close(_)) {
            break;
        }
    }
}

async fn drive<S>(
    socket: Rc<NoiseConnection>,
    stream: WebSocketStream<S>,
    mut signals: UnboundedReceiver<Outbound>,
    buffered: Rc<Cell<usize>>,
    aborted: CancellationToken,
    side: Side,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut writer, mut reader) = stream.split();
    let mut pending = VecDeque::new();
    let mut flushing_bytes = 0;
    let mut closing = false;
    let end = loop {
        let mut end = None;
        let can_flush = !pending.is_empty() || flushing_bytes != 0;
        tokio::select! {
            biased;
            _ = aborted.cancelled() => end = Some(End::Aborted),
            result = poll_fn(|cx| flush(&mut writer, &mut pending, &mut flushing_bytes, cx)), if can_flush => match result {
                Ok(()) => buffered.set(buffered.get() - std::mem::take(&mut flushing_bytes)),
                Err(_) => end = Some(End::Failed(NoiseErrorCode::TransportClosed)),
            },
            signal = signals.next(), if !closing => match signal {
                Some(Outbound::Frame(frame)) => {
                    pending.push_back(frame);
                    if side == Side::Server && buffered.get() > BACKPRESSURE_LIMIT {
                        end = Some(End::Failed(NoiseErrorCode::TransportClosed));
                    }
                }
                Some(Outbound::Close) => closing = true,
                None => end = Some(End::Aborted),
            },
            message = reader.next() => match message {
                Some(Ok(Message::Binary(bytes))) => socket.receive(NoiseFrame::Binary(&bytes)),
                Some(Ok(Message::Text(_))) => socket.receive(NoiseFrame::Other),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) => end = Some(End::PeerClosed),
                Some(Ok(Message::Frame(_))) => {}
                Some(Err(error)) => end = Some(End::Failed(failure(&error))),
                None => end = Some(End::Failed(NoiseErrorCode::TransportClosed)),
            },
        }
        if let Some(end) = end {
            break end;
        }
        if closing && buffered.get() == 0 {
            break End::Closing;
        }
    };
    match end {
        End::Aborted => {}
        End::Failed(code) => socket.fail(code),
        End::PeerClosed => {
            socket.fail(NoiseErrorCode::TransportClosed);
            let _ = timeout(CLOSE_HANDSHAKE, writer.flush()).await;
        }
        End::Closing => {
            let _ = timeout(CLOSE_HANDSHAKE, async {
                if writer
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Normal,
                        reason: "".into(),
                    })))
                    .await
                    .is_ok()
                {
                    peer_close(&mut reader).await;
                }
            })
            .await;
        }
    }
}
