//! Load generator for comparing the Garcon front door with the TypeScript
//! original. Each worker holds one keep-alive connection and issues requests
//! back to back for the run's duration; latencies go into one histogram. The
//! result is one JSON object on stdout. See rust/BENCHMARKS.md.
//!
//! Usage:
//!   garcon-bench http <url> [--header 'Name: value']... [--concurrency N] [--seconds S] [--warmup S]
//!   garcon-bench ws <url> [--protocol P]... [--concurrency N] [--seconds S] [--warmup S]

use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hdrhistogram::Histogram;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper::header::{HeaderName, HeaderValue};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

struct Options {
    mode: String,
    url: String,
    headers: Vec<(HeaderName, HeaderValue)>,
    protocols: Vec<String>,
    concurrency: usize,
    seconds: f64,
    warmup: f64,
}

#[derive(Default)]
struct WorkerResult {
    latencies: Vec<u64>,
    errors: u64,
    bytes: u64,
}

fn parse_options() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("missing mode: http or ws")?;
    let url = args.next().ok_or("missing url")?;
    let mut options = Options {
        mode,
        url,
        headers: Vec::new(),
        protocols: Vec::new(),
        concurrency: 1,
        seconds: 5.0,
        warmup: 1.0,
    };
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--header" => {
                let (name, value) = value.split_once(':').ok_or("headers are 'Name: value'")?;
                options.headers.push((
                    HeaderName::from_bytes(name.trim().as_bytes())
                        .map_err(|error| error.to_string())?,
                    HeaderValue::from_str(value.trim()).map_err(|error| error.to_string())?,
                ));
            }
            "--protocol" => options.protocols.push(value),
            "--concurrency" => {
                options.concurrency = value.parse().map_err(|_| "invalid --concurrency")?
            }
            "--seconds" => options.seconds = value.parse().map_err(|_| "invalid --seconds")?,
            "--warmup" => options.warmup = value.parse().map_err(|_| "invalid --warmup")?,
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(options)
}

async fn http_worker(options: &Options, measure_from: Instant, end: Instant) -> WorkerResult {
    let mut result = WorkerResult::default();
    let uri: hyper::Uri = options.url.parse().expect("the URL was validated");
    let authority = uri
        .authority()
        .expect("http URLs have an authority")
        .clone();
    let Ok(stream) = TcpStream::connect(authority.as_str()).await else {
        result.errors += 1;
        return result;
    };
    let _ = stream.set_nodelay(true);
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        result.errors += 1;
        return result;
    };
    tokio::spawn(connection);
    let path = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_string();
    while Instant::now() < end {
        let mut request = Request::get(path.as_str())
            .header(hyper::header::HOST, authority.as_str())
            .body(Empty::<Bytes>::new())
            .expect("a GET request is valid");
        for (name, value) in &options.headers {
            request.headers_mut().insert(name.clone(), value.clone());
        }
        let sent = Instant::now();
        let outcome = match sender.send_request(request).await {
            Ok(response) => {
                let ok = response.status().is_success();
                match response.into_body().collect().await {
                    Ok(body) if ok => Some(body.to_bytes().len() as u64),
                    _ => None,
                }
            }
            Err(_) => None,
        };
        let elapsed = sent.elapsed().as_micros() as u64;
        if sent < measure_from {
            if outcome.is_none() {
                break;
            }
            continue;
        }
        match outcome {
            Some(bytes) => {
                result.latencies.push(elapsed);
                result.bytes += bytes;
            }
            None => {
                result.errors += 1;
                break;
            }
        }
    }
    result
}

async fn ws_worker(
    options: &Options,
    worker: usize,
    measure_from: Instant,
    end: Instant,
) -> WorkerResult {
    let mut result = WorkerResult::default();
    let mut request = options
        .url
        .as_str()
        .into_client_request()
        .expect("the URL was validated");
    if !options.protocols.is_empty() {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&options.protocols.join(", "))
                .expect("protocols are header-safe"),
        );
    }
    let Ok((mut socket, _)) = tokio_tungstenite::connect_async(request).await else {
        result.errors += 1;
        return result;
    };
    let mut sequence = 0u64;
    while Instant::now() < end {
        sequence += 1;
        let id = format!("bench-{worker}-{sequence}");
        let ping = serde_json::json!({ "type": "ws-ping", "clientRequestId": id, "sentAt": 1 })
            .to_string();
        let sent = Instant::now();
        if socket.send(Message::text(ping)).await.is_err() {
            result.errors += 1;
            break;
        }
        // Skips broadcasts until the reply to this ping arrives.
        let mut replied = false;
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message
                && text.contains(&id)
            {
                result.bytes += text.len() as u64;
                replied = true;
                break;
            }
        }
        if !replied {
            result.errors += 1;
            break;
        }
        if sent >= measure_from {
            result.latencies.push(sent.elapsed().as_micros() as u64);
        }
    }
    let _ = socket.close(None).await;
    result
}

#[tokio::main]
async fn main() {
    let options = match parse_options() {
        Ok(options) => std::sync::Arc::new(options),
        Err(error) => {
            eprintln!("garcon-bench: {error}");
            std::process::exit(2);
        }
    };
    let start = Instant::now();
    let measure_from = start + Duration::from_secs_f64(options.warmup);
    let end = measure_from + Duration::from_secs_f64(options.seconds);
    let workers: Vec<_> = (0..options.concurrency)
        .map(|worker| {
            let options = options.clone();
            tokio::spawn(async move {
                match options.mode.as_str() {
                    "ws" => ws_worker(&options, worker, measure_from, end).await,
                    _ => http_worker(&options, measure_from, end).await,
                }
            })
        })
        .collect();
    let mut histogram = Histogram::<u64>::new(3).expect("three significant figures are supported");
    let (mut errors, mut bytes) = (0, 0);
    for worker in workers {
        let result = worker.await.unwrap_or_default();
        errors += result.errors;
        bytes += result.bytes;
        for latency in result.latencies {
            let _ = histogram.record(latency.max(1));
        }
    }
    let measured = options.seconds;
    println!(
        "{}",
        serde_json::json!({
            "requests": histogram.len(),
            "errors": errors,
            "seconds": measured,
            "requestsPerSecond": histogram.len() as f64 / measured,
            "megabytesPerSecond": bytes as f64 / measured / 1e6,
            "p50Micros": histogram.value_at_quantile(0.5),
            "p90Micros": histogram.value_at_quantile(0.9),
            "p99Micros": histogram.value_at_quantile(0.99),
            "maxMicros": histogram.max(),
        })
    );
}
