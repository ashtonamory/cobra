//! The agent's HTTP API, on loopback (the desk's api.py).
//!
//! Errors carry the agent's own message: a 409 from `POST /session` says why
//! the screen was not what it expected, and that sentence is what the UI shows.

use crate::computers::{Machine, Store};
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }
}

/// Every reply says when this desktop's key expires (ms since the epoch); with
/// less than this left, the desktop swaps in a key it makes (`rotate_key`), so
/// a key never expires under a desk that is running. The agent's half: keys.ts.
const KEY_EXPIRES_HEADER: &str = "x-cobra-key-expires";
const ROTATE_WITHIN_S: f64 = 30.0 * 24.0 * 3600.0;

pub struct Api {
    client: reqwest::Client,
    /// When a rotation was last tried.
    rotation_tried: Mutex<f64>,
}

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Whether a reply's expiry says rotate now. After it is too late: the agent refuses the key.
pub fn rotation_due(header: Option<&str>, now: f64) -> bool {
    match header.and_then(|h| h.trim().parse::<f64>().ok()) {
        Some(ms) => {
            let at = ms / 1000.0;
            now < at && at < now + ROTATE_WITHIN_S
        }
        None => false,
    }
}

pub fn new_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Api {
    pub fn new() -> Self {
        Api {
            client: reqwest::Client::builder()
                .user_agent(concat!("cobra-desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            rotation_tried: Mutex::new(0.0),
        }
    }

    pub async fn request(
        &self,
        store: &Store,
        m: &Machine,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout_ms: u64,
    ) -> Result<Value, ApiError> {
        let (value, expires) = self.direct(m, method, path, body, timeout_ms).await?;
        if rotation_due(expires.as_deref(), now()) {
            self.rotate_key(store, m).await;
        }
        Ok(value)
    }

    async fn direct(&self, m: &Machine, method: &str, path: &str, body: Option<Value>, timeout_ms: u64) -> Result<(Value, Option<String>), ApiError> {
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| ApiError::new(0, "bad method"))?;
        let mut req = self
            .client
            .request(method, format!("{}{}", m.base, path))
            .bearer_auth(&m.key)
            .timeout(Duration::from_millis(timeout_ms));
        if let Some(b) = body {
            req = req.json(&b);
        }
        send(req).await
    }

    /// An image for a session (`POST /session/attach`), the raw file as the body.
    pub async fn upload(&self, m: &Machine, path_and_query: &str, bytes: Vec<u8>) -> Result<Value, ApiError> {
        let req = self
            .client
            .post(format!("{}{}", m.base, path_and_query))
            .bearer_auth(&m.key)
            .header("content-type", "application/octet-stream")
            .timeout(Duration::from_secs(120))
            .body(bytes);
        send(req).await.map(|(v, _)| v)
    }

    /// One file from the agent (`GET /fs/get`), as bytes. A refusal comes back as the agent's own
    /// words; a file over `limit` is refused with 413.
    pub async fn download(&self, m: &Machine, file: &str, limit: usize) -> Result<Vec<u8>, ApiError> {
        let res = self
            .client
            .get(format!("{}{}", m.base, fs_get_path(file)))
            .bearer_auth(&m.key)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| ApiError::new(0, format!("unreachable: {e}")))?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(refusal(status, &text, &m.label));
        }
        if res.content_length().is_some_and(|n| n as usize > limit) {
            return Err(too_big());
        }
        let bytes = res.bytes().await.map_err(|e| ApiError::new(0, format!("unreachable: {e}")))?;
        if bytes.len() > limit {
            return Err(too_big());
        }
        Ok(bytes.to_vec())
    }

    /// Swap this desktop's key for a new one: the agent gets only its hash, and
    /// keeps taking the old key until the new one is used, so a failure anywhere
    /// here leaves the desk working. Once an hour at most.
    async fn rotate_key(&self, store: &Store, m: &Machine) {
        {
            let mut tried = self.rotation_tried.lock().unwrap();
            if now() - *tried < 3600.0 {
                return;
            }
            *tried = now();
        }
        let new = new_key();
        let hash = hex::encode(Sha256::digest(new.as_bytes()));
        match self.direct(m, "POST", "/keys/rotate", Some(json!({ "keyHash": hash })), 10_000).await {
            Ok(_) => match store.replace_key(&m.key, &new) {
                Ok(()) => eprintln!("cobra-desktop: rotated the agent's key"),
                Err(e) => eprintln!("cobra-desktop: could not keep the new key: {e}"),
            },
            Err(e) => eprintln!("cobra-desktop: could not rotate the key: {}", e.message),
        }
    }
}

/// `/fs/get?path=…` with the path encoded as a query value.
pub fn fs_get_path(file: &str) -> String {
    let mut url = reqwest::Url::parse("http://agent/fs/get").expect("url");
    url.query_pairs_mut().append_pair("path", file);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

fn too_big() -> ApiError {
    ApiError::new(413, "That file is too big to show here.")
}

/// A non-200 answer to a download, in the agent's own words.
fn refusal(status: u16, text: &str, label: &str) -> ApiError {
    interpret(status, text, None).err().unwrap_or_else(|| ApiError::new(status, format!("{label} answered {status}")))
}

async fn send(req: reqwest::RequestBuilder) -> Result<(Value, Option<String>), ApiError> {
    let res = req.send().await.map_err(|e| {
        let why = if e.is_timeout() { "timed out".to_string() } else { root_cause(&e) };
        ApiError::new(0, format!("unreachable: {why}"))
    })?;
    let status = res.status().as_u16();
    let expires = res.headers().get(KEY_EXPIRES_HEADER).and_then(|v| v.to_str().ok()).map(String::from);
    let text = res.text().await.map_err(|e| ApiError::new(0, format!("unreachable: {e}")))?;
    interpret(status, &text, expires)
}

/// The agent's answer: its JSON, or its error with its own words.
pub fn interpret(status: u16, text: &str, expires: Option<String>) -> Result<(Value, Option<String>), ApiError> {
    if !(200..300).contains(&status) {
        let msg = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| {
                if text.is_empty() {
                    reqwest::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("error").to_string()
                } else {
                    text.to_string()
                }
            });
        return Err(ApiError::new(status, msg));
    }
    if text.is_empty() {
        return Ok((Value::Null, expires));
    }
    serde_json::from_str(text).map(|v| (v, expires)).map_err(|_| ApiError::new(status, "the agent's answer was not JSON"))
}

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_path_is_one_query_value() {
        assert_eq!(fs_get_path("/home/a/Spaces/x/designs/shown/2026-10-31T10:00:00Z/post 1.png"), "/fs/get?path=%2Fhome%2Fa%2FSpaces%2Fx%2Fdesigns%2Fshown%2F2026-10-31T10%3A00%3A00Z%2Fpost+1.png");
        assert_eq!(fs_get_path("a&b=c"), "/fs/get?path=a%26b%3Dc");
    }

    #[test]
    fn rotation_window() {
        let now = 1_000_000.0;
        assert!(!rotation_due(None, now));
        assert!(!rotation_due(Some("soon"), now));
        assert!(rotation_due(Some(&format!("{}", (now + 86400.0) * 1000.0)), now));
        assert!(!rotation_due(Some(&format!("{}", (now + 60.0 * 86400.0) * 1000.0)), now));
        assert!(!rotation_due(Some(&format!("{}", (now - 1.0) * 1000.0)), now));
    }

    #[test]
    fn keys_are_43_url_safe_chars() {
        let k = new_key();
        assert_eq!(k.len(), 43);
        assert!(k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn answers_are_read_as_the_agent_said_them() {
        assert_eq!(interpret(204, "", None).unwrap().0, Value::Null);
        assert_eq!(interpret(404, "", None).unwrap_err().message, "Not Found");
        assert_eq!(interpret(500, "boom", None).unwrap_err().message, "boom");
        assert_eq!(interpret(409, "{\"error\":\"no dialog\"}", None).unwrap_err().message, "no dialog");
        assert_eq!(interpret(200, "not json", None).unwrap_err().message, "the agent's answer was not JSON");
    }
}
