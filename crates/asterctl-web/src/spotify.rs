// SPDX-License-Identifier: MIT OR Apache-2.0
//! Read-only Spotify integration. Credentials never cross the status API.
use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex as StdMutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use asterctl_lcd::ToRgb565;
use axum::{
    extract::State,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use image::{ImageReader, Limits, RgbImage};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify};
use url::Url;

use crate::{ApiError, ApiJson, ApiResult, AppState, BridgeHandle, Command, spotify_render};

pub const REDIRECT_URI: &str = "http://127.0.0.1:17879/callback";
const SCOPE: &str = "user-read-currently-playing";
const POLL_SECONDS: u64 = 15;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub progress_ms: u64,
    pub is_playing: bool,
    pub url: String,
    #[serde(skip)]
    cover_url: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub connected: bool,
    pub enabled: bool,
    pub track: Option<Track>,
    pub message: String,
    pub error: Option<String>,
    pub client_id: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Saved {
    client_id: String,
    refresh_token: String,
    enabled: bool,
}

struct Pending {
    client_id: String,
    state: String,
    verifier: String,
    created: Instant,
}

struct Session {
    pending: Option<Pending>,
    access_token: String,
    expires: Instant,
    next_poll: Instant,
    retry_until: Option<Instant>,
    sampled: Instant,
    track: Option<Track>,
    cover: Option<RgbImage>,
    cover_url: String,
}

struct Inner {
    session: Mutex<Session>,
    // Never held across network I/O. Off/Stop must not wait for token refresh,
    // playback polling, artwork downloads, or OAuth completion.
    saved: StdMutex<Saved>,
    // Serializes mode changes with in-flight UART output. An Off or new frame
    // cannot be followed by a late Spotify frame after suspend() returns.
    output_gate: Mutex<()>,
    public: RwLock<Snapshot>,
    persistence_error: RwLock<Option<String>>,
    preview: RwLock<Vec<u8>>,
    client: Client,
    path: PathBuf,
    bridge: BridgeHandle,
    wake: Notify,
    generation: AtomicU64,
    request_poll: AtomicBool,
    token_url: String,
    playback_url: String,
    #[cfg(test)]
    http_mock: Option<Arc<tests::HttpMock>>,
}

#[derive(Clone)]
pub struct Spotify(Arc<Inner>);

impl Spotify {
    pub fn new(bridge: BridgeHandle, path: PathBuf) -> Self {
        let service = Self::new_state(bridge, path);
        let _worker = service.spawn_worker();
        service
    }

    fn spawn_worker(&self) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let service = Self(inner);
                service.tick().await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                    _ = service.0.wake.notified() => {},
                }
            }
        })
    }

    fn new_state(bridge: BridgeHandle, path: PathBuf) -> Self {
        let (saved, error) = match read_saved(&path) {
            Ok(saved) => (saved, None),
            Err(_) => (
                Saved::default(),
                Some("Spotify settings could not be read; reconnect to recover.".into()),
            ),
        };
        let public = Snapshot {
            connected: !saved.refresh_token.is_empty(),
            enabled: saved.enabled,
            client_id: saved.client_id.clone(),
            error,
            message: "Not connected".into(),
            ..Snapshot::default()
        };
        Self(Arc::new(Inner {
            session: Mutex::new(Session {
                pending: None,
                access_token: String::new(),
                expires: Instant::now(),
                next_poll: Instant::now(),
                retry_until: None,
                sampled: Instant::now(),
                track: None,
                cover: None,
                cover_url: String::new(),
            }),
            saved: StdMutex::new(saved),
            output_gate: Mutex::new(()),
            public: RwLock::new(public),
            persistence_error: RwLock::new(None),
            preview: RwLock::new(Vec::new()),
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .user_agent("aoostar-oled-studio/spotify-display")
                .build()
                .expect("HTTP client"),
            path,
            bridge,
            wake: Notify::new(),
            generation: AtomicU64::new(0),
            request_poll: AtomicBool::new(false),
            token_url: "https://accounts.spotify.com/api/token".into(),
            playback_url: "https://api.spotify.com/v1/me/player/currently-playing".into(),
            #[cfg(test)]
            http_mock: None,
        }))
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut snapshot = self.0.public.read().expect("Spotify snapshot").clone();
        if let Some(error) = self
            .0
            .persistence_error
            .read()
            .expect("Spotify storage status")
            .clone()
        {
            snapshot.error = Some(error);
        }
        snapshot
    }

    pub async fn suspend(&self) -> Result<(), ApiError> {
        let _gate = self.0.output_gate.lock().await;
        let mut saved = self.0.saved.lock().expect("Spotify saved state");
        if saved.enabled {
            self.0.generation.fetch_add(1, Ordering::SeqCst);
            // Disable in memory even if disk writes fail; never fight an Off request.
            saved.enabled = false;
            self.0.public.write().expect("Spotify snapshot").enabled = false;
            if save(&self.0.path, &saved).is_err() {
                *self.0.persistence_error.write().expect("Spotify storage status") = Some(
                    "Spotify updates stopped, but the setting could not be saved. Spotify may resume after restart; check the service state directory.".into(),
                );
                return Err(ApiError::internal("Could not save Spotify display mode"));
            }
            *self
                .0
                .persistence_error
                .write()
                .expect("Spotify storage status") = None;
        }
        Ok(())
    }

    /// A persistence failure must never prevent the requested hardware command.
    /// The warning remains visible through /api/spotify/status.
    pub async fn suspend_for_display_command(&self) {
        if self.suspend().await.is_err() {
            log::warn!(
                "Spotify updates stopped in memory, but the mode could not be saved; continuing the display command"
            );
        }
    }

    async fn tick(&self) {
        if !self.snapshot().enabled {
            return;
        }
        let mut session = self.0.session.lock().await;
        if !self.snapshot().enabled {
            return;
        }
        let generation = self.0.generation.load(Ordering::SeqCst);
        if self.0.request_poll.swap(false, Ordering::SeqCst) {
            session.next_poll = session.retry_until.unwrap_or_else(Instant::now);
        }
        if Instant::now() >= session.next_poll {
            session.next_poll = Instant::now() + Duration::from_secs(POLL_SECONDS);
            if let Err(failure) = self.poll(&mut session).await {
                let _transition = if failure.reconnect {
                    Some(self.0.output_gate.lock().await)
                } else {
                    None
                };
                let mut public = self.0.public.write().expect("Spotify snapshot");
                public.error = Some(failure.message.into());
                public.message = failure.label.into();
                // Do not extrapolate stale playback while offline/rate limited.
                if let Some(track) = &mut session.track {
                    track.is_playing = false;
                }
                if failure.reconnect {
                    public.connected = false;
                    public.enabled = false;
                }
                drop(public);
                if failure.reconnect {
                    let mut saved = self.0.saved.lock().expect("Spotify saved state");
                    saved.enabled = false;
                    let _ = save(&self.0.path, &saved);
                }
                session.next_poll = Instant::now() + Duration::from_secs(failure.retry_after);
                session.retry_until = Some(session.next_poll);
            }
        }
        let progress = session
            .track
            .as_ref()
            .map_or(0, |t| estimate_progress(t, session.sampled.elapsed()));
        let mut track = session.track.clone();
        if let Some(t) = &mut track {
            t.progress_ms = progress;
        }
        self.0.public.write().expect("Spotify snapshot").track = track.clone();
        let cover = session.cover.clone();
        let message = self.snapshot().message;
        drop(session);
        let rendered = tokio::task::spawn_blocking(move || {
            let frame = spotify_render::render(track.as_ref(), cover.as_ref(), progress, &message);
            let bytes = (&frame).to_rgb565_le().to_vec();
            (spotify_render::png(&frame), bytes)
        })
        .await;
        let Ok((png, bytes)) = rendered else {
            return;
        };
        let _gate = self.0.output_gate.lock().await;
        if generation != self.0.generation.load(Ordering::SeqCst) {
            return;
        }
        *self.0.preview.write().expect("Spotify preview") = png;
        if !self.snapshot().enabled || !self.0.bridge.status().display_on {
            return;
        }
        if self
            .0
            .bridge
            .request_data(|reply| Command::Frame { data: bytes, reply })
            .await
            .is_err()
        {
            self.0.public.write().expect("Spotify snapshot").error =
                Some("Display output failed; check the bridge status.".into());
        }
    }

    async fn poll(&self, session: &mut Session) -> Result<(), Failure> {
        if session.access_token.is_empty() || Instant::now() >= session.expires {
            let credentials = self.0.saved.lock().expect("Spotify saved state").clone();
            let response = self
                .request_token(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &credentials.refresh_token),
                    ("client_id", &credentials.client_id),
                ])
                .await?;
            let token = token_response(response).await?;
            if let Some(refresh) = token.refresh_token {
                let mut saved = self.0.saved.lock().expect("Spotify saved state");
                saved.refresh_token = refresh;
                // Preserve the current mode, including an Off received while
                // Spotify was rotating the token.
                save(&self.0.path, &saved).map_err(|_| Failure::storage())?;
                *self
                    .0
                    .persistence_error
                    .write()
                    .expect("Spotify storage status") = None;
            }
            session.access_token = token.access_token;
            session.expires =
                Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60).max(1));
        }
        let response = self.request_playback(&session.access_token).await?;
        if response.status() == 401 {
            session.access_token.clear();
            return Err(Failure {
                message: "Spotify session is refreshing.",
                label: "Reconnecting",
                retry_after: 2,
                reconnect: false,
            });
        }
        if response.status() == 204 {
            session.track = None;
            session.cover = None;
            session.cover_url.clear();
        } else {
            check_response(&response)?;
            let value: Value = serde_json::from_slice(&limited_body(response, 512 * 1024).await?)
                .map_err(|_| Failure::network())?;
            session.track = parse_track(&value);
            let cover_url = session
                .track
                .as_ref()
                .map_or("", |t| t.cover_url.as_str())
                .to_owned();
            if cover_url != session.cover_url || (!cover_url.is_empty() && session.cover.is_none())
            {
                session.cover = self.fetch_cover(&cover_url).await;
                session.cover_url = cover_url;
            }
        }
        session.sampled = Instant::now();
        session.retry_until = None;
        let mut public = self.0.public.write().expect("Spotify snapshot");
        public.error = None;
        public.connected = true;
        public.message = if session.track.is_none() {
            "Waiting for music".into()
        } else {
            String::new()
        };
        Ok(())
    }

    async fn request_token(&self, form: &[(&str, &str)]) -> Result<reqwest::Response, Failure> {
        #[cfg(test)]
        if let Some(mock) = &self.0.http_mock {
            return Ok(mock.token(form).await);
        }
        self.0
            .client
            .post(&self.0.token_url)
            .form(form)
            .send()
            .await
            .map_err(|_| Failure::network())
    }

    async fn request_playback(&self, access_token: &str) -> Result<reqwest::Response, Failure> {
        #[cfg(test)]
        if let Some(mock) = &self.0.http_mock {
            return Ok(mock.playback(access_token));
        }
        self.0
            .client
            .get(&self.0.playback_url)
            .query(&[("additional_types", "track,episode")])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| Failure::network())
    }

    async fn fetch_cover(&self, url: &str) -> Option<RgbImage> {
        if !allowed_cover(url) {
            return None;
        }
        let response = self.0.client.get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body = limited_body(response, 2 * 1024 * 1024).await.ok()?;
        tokio::task::spawn_blocking(move || {
            let mut reader = ImageReader::new(Cursor::new(body))
                .with_guessed_format()
                .ok()?;
            let mut limits = Limits::default();
            limits.max_image_width = Some(2048);
            limits.max_image_height = Some(2048);
            limits.max_alloc = Some(24 * 1024 * 1024);
            reader.limits(limits);
            reader.decode().ok().map(|image| image.to_rgb8())
        })
        .await
        .ok()
        .flatten()
    }
}

pub fn estimate_progress(track: &Track, elapsed: Duration) -> u64 {
    let delta = if track.is_playing {
        elapsed.as_millis().min(30_000) as u64
    } else {
        0
    };
    track
        .progress_ms
        .saturating_add(delta)
        .min(track.duration_ms)
}

fn clean(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect()
}

fn parse_track(value: &Value) -> Option<Track> {
    let item = value.get("item")?.as_object()?;
    if !matches!(item.get("type")?.as_str()?, "track" | "episode") {
        return None;
    }
    let album = item.get("album").or_else(|| item.get("show"));
    let artist = item
        .get("artists")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                .take(8)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| {
            album
                .and_then(|a| a.get("publisher"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        });
    let images = album
        .and_then(|a| a.get("images"))
        .or_else(|| item.get("images"))
        .and_then(Value::as_array);
    let cover_url = images
        .and_then(|images| {
            images
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str))
                .find(|url| allowed_cover(url))
        })
        .unwrap_or_default()
        .to_string();
    let track_url = item
        .get("external_urls")
        .and_then(|v| v.get("spotify"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(Track {
        title: clean(item.get("name").and_then(Value::as_str)),
        artist: clean(Some(&artist)),
        album: clean(album.and_then(|a| a.get("name")).and_then(Value::as_str)),
        duration_ms: item
            .get("duration_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(86_400_000),
        progress_ms: value
            .get("progress_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        is_playing: value
            .get("is_playing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        url: if track_url.starts_with("https://open.spotify.com/") {
            track_url.chars().take(512).collect()
        } else {
            String::new()
        },
        cover_url,
    })
}

fn allowed_cover(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("i.scdn.co")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
    })
}

struct Failure {
    message: &'static str,
    label: &'static str,
    retry_after: u64,
    reconnect: bool,
}
impl Failure {
    fn network() -> Self {
        Self {
            message: "Spotify could not be reached. Retrying automatically.",
            label: "Offline",
            retry_after: 30,
            reconnect: false,
        }
    }
    fn storage() -> Self {
        Self {
            message: "Spotify credentials could not be saved. Check the service state directory.",
            label: "Storage error",
            retry_after: 30,
            reconnect: false,
        }
    }
}
fn check_response(response: &reqwest::Response) -> Result<(), Failure> {
    match response.status().as_u16() {
        200..=299 => Ok(()),
        429 => Err(Failure {
            message: "Spotify rate limit reached. Waiting before retrying.",
            label: "Rate limited",
            retry_after: response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(1, 604800),
            reconnect: false,
        }),
        400 | 401 | 403 => Err(Failure {
            message: "Reconnect Spotify. Check Premium and the app's user allowlist.",
            label: "Reconnect Spotify",
            retry_after: 60,
            reconnect: true,
        }),
        _ => Err(Failure::network()),
    }
}
async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(Failure::network());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::network())? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(Failure::network());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}
async fn token_response(response: reqwest::Response) -> Result<Token, Failure> {
    check_response(&response)?;
    let token: Token = serde_json::from_slice(&limited_body(response, 32 * 1024).await?)
        .map_err(|_| Failure::network())?;
    if token.access_token.is_empty() || token.expires_in == 0 || token.expires_in > 86400 {
        return Err(Failure::network());
    }
    Ok(token)
}

fn read_saved(path: &PathBuf) -> std::io::Result<Saved> {
    if !path.exists() {
        return Ok(Saved::default());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 {
        return Err(std::io::Error::other("invalid credentials file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::other("credentials must be private"));
        }
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn save(path: &PathBuf, saved: &Saved) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no state directory"))?;
    fs::create_dir_all(parent)?;
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce)
        .map_err(|_| std::io::Error::other("secure randomness unavailable"))?;
    let temp = path.with_extension(format!("{}.new", URL_SAFE_NO_PAD.encode(nonce)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(saved)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn random_secret() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ApiError::internal("Secure randomness unavailable"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub async fn status(State(state): State<AppState>) -> ApiResult<Snapshot> {
    Ok(ApiJson(state.spotify.snapshot()))
}

#[derive(Deserialize)]
pub struct Start {
    client_id: String,
}
#[derive(Serialize)]
pub struct Authorization {
    authorization_url: String,
    redirect_uri: &'static str,
}
pub async fn start(
    State(state): State<AppState>,
    axum::Json(input): axum::Json<Start>,
) -> ApiResult<Authorization> {
    let client_id = input.client_id.trim();
    if client_id.len() != 32 || !client_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "Enter the 32-character Spotify Client ID (not a client secret).",
        ));
    }
    let verifier = random_secret()?;
    let nonce = random_secret()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse("https://accounts.spotify.com/authorize").expect("fixed URL");
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPE),
        ("state", nonce.as_str()),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
    ]);
    state.spotify.0.session.lock().await.pending = Some(Pending {
        client_id: client_id.into(),
        state: nonce,
        verifier,
        created: Instant::now(),
    });
    Ok(ApiJson(Authorization {
        authorization_url: url.to_string(),
        redirect_uri: REDIRECT_URI,
    }))
}

#[derive(Deserialize)]
pub struct Complete {
    callback_url: String,
}
fn callback_code(raw: &str, pending: &Pending) -> Result<String, ApiError> {
    if raw.len() > 8192 || pending.created.elapsed() > Duration::from_secs(600) {
        return Err(ApiError::bad_request(
            "Login expired. Start Spotify sign-in again.",
        ));
    }
    let url = Url::parse(raw)
        .map_err(|_| ApiError::bad_request("Paste the full callback URL from the address bar."))?;
    let expected = Url::parse(REDIRECT_URI).expect("fixed callback");
    if url.scheme() != expected.scheme()
        || url.host_str() != expected.host_str()
        || url.port() != expected.port()
        || url.path() != expected.path()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad_request(
            "Callback URL does not match the registered loopback address.",
        ));
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    if states.len() != 1
        || states[0].1 != pending.state
        || codes.len() != 1
        || codes[0].1.is_empty()
    {
        return Err(ApiError::bad_request(
            "Login was denied or does not match this session. Start again.",
        ));
    }
    Ok(codes[0].1.to_string())
}

pub async fn complete(
    State(state): State<AppState>,
    axum::Json(input): axum::Json<Complete>,
) -> ApiResult<Snapshot> {
    let mut session = state.spotify.0.session.lock().await;
    let pending = session
        .pending
        .take()
        .ok_or_else(|| ApiError::bad_request("Start Spotify sign-in first."))?;
    let code = callback_code(input.callback_url.trim(), &pending)?;
    let response = state
        .spotify
        .request_token(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", pending.client_id.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ])
        .await
        .map_err(|_| {
            ApiError::service_unavailable("Spotify sign-in could not be reached. Start again.")
        })?;
    let token = token_response(response)
        .await
        .map_err(|f| ApiError::bad_request(f.message))?;
    let saved = Saved {
        client_id: pending.client_id,
        refresh_token: token
            .refresh_token
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::bad_request("Spotify did not issue a refresh token."))?,
        enabled: false,
    };
    // Only the local commit is exclusive with output. Spotify's HTTP request
    // above must not block an unrelated Off/Stop request.
    let _gate = state.spotify.0.output_gate.lock().await;
    save(&state.spotify.0.path, &saved).map_err(|_| {
        ApiError::internal("Could not save Spotify credentials. Check the service state directory.")
    })?;
    *state.spotify.0.saved.lock().expect("Spotify saved state") = saved.clone();
    *state
        .spotify
        .0
        .persistence_error
        .write()
        .expect("Spotify storage status") = None;
    session.access_token = token.access_token;
    state.spotify.0.generation.fetch_add(1, Ordering::SeqCst);
    state
        .spotify
        .0
        .preview
        .write()
        .expect("Spotify preview")
        .clear();
    session.expires =
        Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60).max(1));
    session.next_poll = Instant::now();
    session.retry_until = None;
    session.track = None;
    session.cover = None;
    session.cover_url.clear();
    *state.spotify.0.public.write().expect("Spotify snapshot") = Snapshot {
        connected: true,
        client_id: saved.client_id,
        message: "Ready to display".into(),
        ..Snapshot::default()
    };
    Ok(ApiJson(state.spotify.snapshot()))
}

#[derive(Deserialize)]
pub struct Mode {
    enabled: bool,
}
pub async fn mode(
    State(state): State<AppState>,
    axum::Json(input): axum::Json<Mode>,
) -> ApiResult<Snapshot> {
    if !input.enabled {
        state.spotify.suspend().await?;
        return Ok(ApiJson(state.spotify.snapshot()));
    }
    let _gate = state.spotify.0.output_gate.lock().await;
    if state
        .spotify
        .0
        .saved
        .lock()
        .expect("Spotify saved state")
        .refresh_token
        .is_empty()
        || !state.spotify.snapshot().connected
    {
        return Err(ApiError::bad_request(
            "Connect Spotify before enabling this display.",
        ));
    }
    state
        .bridge
        .request_control(|reply| Command::Power { on: true, reply })
        .await
        .map_err(ApiError::bridge)?;
    let mut saved = state.spotify.0.saved.lock().expect("Spotify saved state");
    let mut next = saved.clone();
    next.enabled = true;
    save(&state.spotify.0.path, &next)
        .map_err(|_| ApiError::internal("Could not save Spotify display mode"))?;
    *saved = next;
    *state
        .spotify
        .0
        .persistence_error
        .write()
        .expect("Spotify storage status") = None;
    state.spotify.0.generation.fetch_add(1, Ordering::SeqCst);
    state.spotify.0.request_poll.store(true, Ordering::SeqCst);
    state
        .spotify
        .0
        .public
        .write()
        .expect("Spotify snapshot")
        .enabled = true;
    state.spotify.0.wake.notify_one();
    Ok(ApiJson(state.spotify.snapshot()))
}

pub async fn disconnect(State(state): State<AppState>) -> ApiResult<Snapshot> {
    state.spotify.suspend().await?;
    let mut session = state.spotify.0.session.lock().await;
    let _gate = state.spotify.0.output_gate.lock().await;
    save(&state.spotify.0.path, &Saved::default())
        .map_err(|_| ApiError::internal("Could not remove saved Spotify credentials"))?;
    *state.spotify.0.saved.lock().expect("Spotify saved state") = Saved::default();
    *state
        .spotify
        .0
        .persistence_error
        .write()
        .expect("Spotify storage status") = None;
    session.access_token.clear();
    session.pending = None;
    session.track = None;
    session.cover = None;
    session.cover_url.clear();
    *state.spotify.0.public.write().expect("Spotify snapshot") = Snapshot {
        message: "Not connected".into(),
        ..Snapshot::default()
    };
    state
        .spotify
        .0
        .preview
        .write()
        .expect("Spotify preview")
        .clear();
    Ok(ApiJson(state.spotify.snapshot()))
}

pub async fn preview(State(state): State<AppState>) -> Response {
    let bytes = state
        .spotify
        .0
        .preview
        .read()
        .expect("Spotify preview")
        .clone();
    let bytes = if bytes.is_empty() {
        tokio::task::spawn_blocking(|| {
            spotify_render::png(&spotify_render::render(None, None, 0, "Not connected"))
        })
        .await
        .unwrap_or_default()
    } else {
        bytes
    };
    (
        [("content-type", "image/png"), ("cache-control", "no-store")],
        bytes,
    )
        .into_response()
}

// Explicit UI-only fixture: never activates output, never calls Spotify, never
// represents a real artist or recording. Kept separate from live state.
static SAMPLE: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let cover = spotify_render::sample_art();
    let track = Track {
        title: "Night Drive".into(),
        artist: "OLED Studio".into(),
        album: "Sample artwork · not live playback".into(),
        duration_ms: 224000,
        progress_ms: 86000,
        is_playing: false,
        url: String::new(),
        cover_url: String::new(),
    };
    spotify_render::png(&spotify_render::render(
        Some(&track),
        Some(&cover),
        track.progress_ms,
        "Layout preview",
    ))
});
pub async fn sample() -> Response {
    let bytes = tokio::task::spawn_blocking(|| SAMPLE.clone())
        .await
        .unwrap_or_default();
    (
        [("content-type", "image/png"), ("cache-control", "no-store")],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // In-process responses at the HTTP boundary make delayed requests and 429s
    // deterministic without opening sockets or touching any real account.
    pub(super) struct HttpMock {
        token_entered: Notify,
        token_release: Option<Notify>,
        tokens: StdMutex<VecDeque<reqwest::Response>>,
        playback: StdMutex<VecDeque<reqwest::Response>>,
        playback_calls: AtomicU64,
    }
    impl HttpMock {
        fn new(tokens: Vec<reqwest::Response>, playback: Vec<reqwest::Response>) -> Self {
            Self {
                token_entered: Notify::new(),
                token_release: None,
                tokens: StdMutex::new(tokens.into()),
                playback: StdMutex::new(playback.into()),
                playback_calls: AtomicU64::new(0),
            }
        }
        pub(super) async fn token(&self, form: &[(&str, &str)]) -> reqwest::Response {
            assert!(form.iter().any(|(key, _)| *key == "client_id"));
            assert!(form.iter().any(|(key, value)| *key == "grant_type"
                && matches!(*value, "refresh_token" | "authorization_code")));
            self.token_entered.notify_one();
            if let Some(release) = &self.token_release {
                release.notified().await;
            }
            self.tokens
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected token request")
        }
        pub(super) fn playback(&self, access_token: &str) -> reqwest::Response {
            assert!(access_token.starts_with("test-access"));
            self.playback_calls.fetch_add(1, Ordering::SeqCst);
            self.playback
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected playback request")
        }
    }
    fn response(status: u16, body: Value) -> reqwest::Response {
        let mut response = axum::http::Response::builder().status(status);
        if status == 429 {
            response = response.header("retry-after", "120");
        }
        response
            .body(serde_json::to_vec(&body).unwrap())
            .unwrap()
            .into()
    }
    fn tokens() -> Vec<reqwest::Response> {
        vec![response(
            200,
            serde_json::json!({
                "access_token":"test-access-not-real", "refresh_token":"test-refresh-rotated", "expires_in":3600
            }),
        )]
    }

    struct Counter(Arc<AtomicU64>);
    impl crate::DisplayDevice for Counter {
        fn power_on(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
        fn power_off(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
        fn clear_cache(&mut self) {}
        fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()> {
            assert_eq!(frame.len(), 960 * 376 * 2);
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn app_state(bridge: BridgeHandle, spotify: Spotify) -> AppState {
        AppState {
            bridge,
            spotify,
            decode_slots: Arc::new(tokio::sync::Semaphore::new(1)),
            telemetry: Arc::new(StdMutex::new(crate::HostTelemetrySampler::default())),
            youtube: crate::YoutubeState::default(),
        }
    }

    fn activate_fixture(service: &Spotify) {
        *service.0.saved.lock().unwrap() = Saved {
            client_id: "a".repeat(32),
            refresh_token: "test-refresh-not-real".into(),
            enabled: true,
        };
        let mut public = service.0.public.write().unwrap();
        public.connected = true;
        public.enabled = true;
    }

    #[tokio::test]
    async fn off_and_stop_still_execute_when_mode_cannot_be_saved() {
        let counter = Arc::new(AtomicU64::new(0));
        let runtime =
            crate::BridgeRuntime::spawn(Box::new(Counter(counter)), true, "storage-failure", true);
        let folder = std::env::temp_dir().join(format!(
            "oled-spotify-storage-test-{}",
            random_secret().unwrap()
        ));
        fs::create_dir(&folder).unwrap();
        // A directory at the target filename deterministically rejects rename
        // on Windows and Linux, including when tests run as root.
        let path = folder.join("spotify.json");
        fs::create_dir(&path).unwrap();
        let service = Spotify::new_state(runtime.handle(), path.clone());
        let state = app_state(runtime.handle(), service.clone());
        activate_fixture(&service);
        let result = crate::display_off(State(state.clone())).await.unwrap();
        assert!(!result.0.display_on);
        assert!(!service.snapshot().enabled);
        assert!(
            service
                .snapshot()
                .error
                .unwrap()
                .contains("may resume after restart")
        );

        runtime
            .handle()
            .request_data(|reply| Command::Frame {
                data: vec![0; 960 * 376 * 2],
                reply,
            })
            .await
            .unwrap();
        assert_eq!(runtime.handle().status().job, crate::Job::Still);
        activate_fixture(&service);
        let result = crate::stop(State(state)).await.unwrap();
        assert_eq!(result.0.job, crate::Job::Idle);
        assert!(!service.snapshot().enabled);
        assert!(
            service
                .snapshot()
                .error
                .unwrap()
                .contains("may resume after restart")
        );
        runtime.shutdown(false).await.unwrap();
        fs::remove_dir(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn off_does_not_wait_for_slow_refresh_and_late_poll_cannot_send() {
        let mut mock = HttpMock::new(tokens(), vec![response(204, Value::Null)]);
        mock.token_release = Some(Notify::new());
        let mock = Arc::new(mock);
        let count = Arc::new(AtomicU64::new(0));
        let runtime = crate::BridgeRuntime::spawn(
            Box::new(Counter(count.clone())),
            true,
            "slow-refresh",
            true,
        );
        let folder = std::env::temp_dir().join(format!(
            "oled-spotify-slow-test-{}",
            random_secret().unwrap()
        ));
        let path = folder.join("spotify.json");
        save(&path, &Saved::default()).expect("create test state");
        let mut service = Spotify::new_state(runtime.handle(), path.clone());
        Arc::get_mut(&mut service.0).unwrap().http_mock = Some(mock.clone());
        activate_fixture(&service);
        let state = app_state(runtime.handle(), service.clone());
        let polling_service = service.clone();
        let polling = tokio::spawn(async move {
            polling_service.tick().await;
        });
        tokio::time::timeout(Duration::from_secs(2), mock.token_entered.notified())
            .await
            .unwrap();
        // The mock token endpoint cannot finish until we release it below.
        let off = tokio::time::timeout(Duration::from_secs(1), crate::display_off(State(state)))
            .await
            .expect("Off must finish while the token endpoint is still blocked")
            .unwrap();
        assert!(!off.0.display_on);
        assert!(!service.snapshot().enabled);
        assert!(!read_saved(&path).unwrap().enabled);
        mock.token_release.as_ref().unwrap().notify_one();
        tokio::time::timeout(Duration::from_secs(10), polling)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            count.load(Ordering::SeqCst),
            0,
            "late poll must not emit a stale frame"
        );
        let saved = read_saved(&path).unwrap();
        assert_eq!(
            saved.refresh_token, "test-refresh-rotated",
            "keep rotated refresh credentials"
        );
        assert!(
            !saved.enabled,
            "token refresh must preserve the Off setting"
        );
        runtime.shutdown(false).await.unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn mock_refresh_poll_render_persist_and_suspend_without_a_browser() {
        let mock = Arc::new(HttpMock::new(
            tokens(),
            vec![
                response(
                    200,
                    serde_json::json!({"is_playing":true,"progress_ms":1000,"item":{
                        "type":"track","name":"한글 제목 / Browser closed","artists":[{"name":"Test artist"}],
                        "duration_ms":50000,"album":{"name":"Fixture only","images":[]}
                    }}),
                ),
                response(204, Value::Null),
                response(429, Value::Null),
            ],
        ));
        let counter = Arc::new(AtomicU64::new(0));
        let runtime = crate::BridgeRuntime::spawn(
            Box::new(Counter(counter.clone())),
            true,
            "spotify-test",
            true,
        );
        let folder =
            std::env::temp_dir().join(format!("oled-spotify-test-{}", random_secret().unwrap()));
        let path = folder.join("spotify.json");
        save(&path, &Saved::default()).expect("create test state");
        let mut service = Spotify::new_state(runtime.handle(), path.clone());
        let inner = Arc::get_mut(&mut service.0).unwrap();
        inner.http_mock = Some(mock.clone());
        {
            *inner.saved.lock().unwrap() = Saved {
                client_id: "a".repeat(32),
                refresh_token: "test-refresh-old".into(),
                enabled: true,
            };
            inner.public.write().unwrap().enabled = true;
        }
        service.tick().await;
        assert!(
            service.snapshot().error.is_none(),
            "mock poll failed: {:?}",
            service.snapshot().error
        );
        assert_eq!(
            service.snapshot().track.unwrap().title,
            "한글 제목 / Browser closed"
        );
        assert_eq!(
            read_saved(&path).unwrap().refresh_token,
            "test-refresh-rotated"
        );
        assert!(read_saved(&path).unwrap().enabled);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert!(!service.0.preview.read().unwrap().is_empty());
        service.0.session.lock().await.next_poll = Instant::now();
        service.tick().await;
        assert!(service.snapshot().track.is_none());
        service.0.session.lock().await.next_poll = Instant::now();
        service.tick().await;
        assert_eq!(service.snapshot().message, "Rate limited");
        let next = service.0.session.lock().await.next_poll;
        assert!(next.saturating_duration_since(Instant::now()) > Duration::from_secs(110));
        service.tick().await;
        assert_eq!(mock.playback_calls.load(Ordering::SeqCst), 3);
        // Toggling the display may request a fresh poll, but must not bypass
        // Spotify's Retry-After window.
        service.suspend().await.unwrap();
        mode(
            State(app_state(runtime.handle(), service.clone())),
            axum::Json(Mode { enabled: true }),
        )
        .await
        .unwrap();
        service.tick().await;
        assert_eq!(mock.playback_calls.load(Ordering::SeqCst), 3);
        service.suspend().await.unwrap();
        let sent = counter.load(Ordering::SeqCst);
        service.tick().await;
        assert_eq!(counter.load(Ordering::SeqCst), sent);
        assert!(!read_saved(&path).unwrap().enabled);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        runtime.shutdown(false).await.unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn off_does_not_wait_for_oauth_completion() {
        let mut mock = HttpMock::new(tokens(), vec![]);
        mock.token_release = Some(Notify::new());
        let mock = Arc::new(mock);
        let counter = Arc::new(AtomicU64::new(0));
        let runtime = crate::BridgeRuntime::spawn(
            Box::new(Counter(counter.clone())),
            true,
            "slow-oauth",
            true,
        );
        let folder = std::env::temp_dir().join(format!(
            "oled-spotify-oauth-test-{}",
            random_secret().unwrap()
        ));
        let path = folder.join("spotify.json");
        let mut service = Spotify::new_state(runtime.handle(), path.clone());
        Arc::get_mut(&mut service.0).unwrap().http_mock = Some(mock.clone());
        service.0.session.lock().await.pending = Some(Pending {
            client_id: "a".repeat(32),
            state: "test-state".into(),
            verifier: "test-verifier".into(),
            created: Instant::now(),
        });
        let state = app_state(runtime.handle(), service.clone());
        let auth_state = state.clone();
        let completion = tokio::spawn(async move {
            complete(
                State(auth_state),
                axum::Json(Complete {
                    callback_url: format!("{REDIRECT_URI}?code=test-code&state=test-state"),
                }),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), mock.token_entered.notified())
            .await
            .unwrap();
        let off = tokio::time::timeout(Duration::from_secs(1), crate::display_off(State(state)))
            .await
            .expect("OAuth network I/O must not hold the display gate")
            .unwrap();
        assert!(!off.0.display_on);
        mock.token_release.as_ref().unwrap().notify_one();
        let connected = tokio::time::timeout(Duration::from_secs(2), completion)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(connected.0.connected);
        assert!(!connected.0.enabled);
        assert!(!runtime.handle().status().display_on);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        assert!(!read_saved(&path).unwrap().enabled);
        runtime.shutdown(false).await.unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn revoked_session_disables_output_and_requires_reconnect() {
        let mock = Arc::new(HttpMock::new(tokens(), vec![response(403, Value::Null)]));
        let counter = Arc::new(AtomicU64::new(0));
        let runtime =
            crate::BridgeRuntime::spawn(Box::new(Counter(counter.clone())), true, "revoked", true);
        let folder = std::env::temp_dir().join(format!(
            "oled-spotify-revoked-test-{}",
            random_secret().unwrap()
        ));
        let path = folder.join("spotify.json");
        let mut service = Spotify::new_state(runtime.handle(), path.clone());
        Arc::get_mut(&mut service.0).unwrap().http_mock = Some(mock.clone());
        activate_fixture(&service);
        service.tick().await;
        let snapshot = service.snapshot();
        assert!(!snapshot.connected);
        assert!(!snapshot.enabled);
        assert_eq!(snapshot.message, "Reconnect Spotify");
        assert!(!read_saved(&path).unwrap().enabled);
        assert!(
            mode(
                State(app_state(runtime.handle(), service.clone())),
                axum::Json(Mode { enabled: true })
            )
            .await
            .is_err()
        );
        service.tick().await;
        assert_eq!(mock.playback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        runtime.shutdown(false).await.unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn worker_runs_without_browser_requests_and_exits_when_service_drops() {
        let mock = Arc::new(HttpMock::new(tokens(), vec![response(204, Value::Null)]));
        let counter = Arc::new(AtomicU64::new(0));
        let runtime = crate::BridgeRuntime::spawn(
            Box::new(Counter(counter.clone())),
            true,
            "background",
            true,
        );
        let folder = std::env::temp_dir().join(format!(
            "oled-spotify-worker-test-{}",
            random_secret().unwrap()
        ));
        let path = folder.join("spotify.json");
        let mut service = Spotify::new_state(runtime.handle(), path.clone());
        Arc::get_mut(&mut service.0).unwrap().http_mock = Some(mock.clone());
        activate_fixture(&service);
        let worker = service.spawn_worker();
        tokio::time::timeout(Duration::from_secs(10), async {
            while counter.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("server worker must render without browser requests");
        assert_eq!(mock.playback_calls.load(Ordering::SeqCst), 1);
        service.suspend().await.unwrap();
        drop(service);
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .expect("background worker must not keep its service alive forever")
            .unwrap();
        runtime.shutdown(false).await.unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(folder).unwrap();
    }
    #[test]
    fn callback_requires_exact_address_state_and_single_code() {
        let pending = Pending {
            client_id: "id".into(),
            state: "safe".into(),
            verifier: "secret".into(),
            created: Instant::now(),
        };
        assert_eq!(
            callback_code(&format!("{REDIRECT_URI}?code=abc&state=safe"), &pending).unwrap(),
            "abc"
        );
        for input in [
            "http://evil.test/callback?code=x&state=safe",
            "http://127.0.0.1:17879/callback?code=x&state=wrong",
            "http://127.0.0.1:17879/callback?code=x&code=y&state=safe",
        ] {
            assert!(callback_code(input, &pending).is_err());
        }
    }
    #[test]
    fn metadata_is_bounded_and_cover_fetch_is_allowlisted() {
        assert!(!allowed_cover("http://i.scdn.co/image/x"));
        assert!(!allowed_cover("https://i.scdn.co.evil.test/image/x"));
        assert!(!allowed_cover("https://127.0.0.1/image/x"));
        assert!(allowed_cover("https://i.scdn.co/image/x"));
        let track = parse_track(&serde_json::json!({"progress_ms":1000,"is_playing":true,"item":{"type":"track","name":"한글\n노래","duration_ms":2000,"artists":[{"name":"가수"}],"album":{"name":"앨범","images":[]}}})).unwrap();
        assert_eq!(track.title, "한글노래");
        assert_eq!(estimate_progress(&track, Duration::from_secs(100)), 2000);
        let mut paused = track;
        paused.is_playing = false;
        assert_eq!(estimate_progress(&paused, Duration::from_secs(100)), 1000);
        assert!(parse_track(&serde_json::json!({"item":null})).is_none());
    }
    #[test]
    fn public_status_never_serializes_credentials() {
        let value = serde_json::to_string(&Snapshot::default()).unwrap();
        for secret in ["access_token", "refresh_token", "verifier", "pending"] {
            assert!(!value.contains(secret));
        }
    }
}
