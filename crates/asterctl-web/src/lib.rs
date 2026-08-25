// SPDX-License-Identifier: MIT OR Apache-2.0

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use asterctl_lcd::{AooScreen, DISPLAY_SIZE, FRAME_BYTES, ToRgb565};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::multipart::MultipartRejection;
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Request, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HOST, ORIGIN, RANGE,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use image::codecs::gif::GifDecoder;
use image::imageops::FilterType;
use image::{AnimationDecoder, ImageDecoder, ImageFormat, ImageReader, Limits};
use log::{debug, error};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;
use tokio::sync::{Semaphore, oneshot};
use tokio::time::timeout;
use tower_http::cors::CorsLayer;
use url::Url;

pub const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_GIF_FRAMES: usize = 90;
pub const MAX_GIF_TOTAL_PIXELS: u64 = 32 * 1024 * 1024;
pub const COMMAND_QUEUE_CAPACITY: usize = 4;
pub const MAX_CONCURRENT_DECODES: usize = 1;
pub const MAX_YOUTUBE_BYTES: u64 = 128 * 1024 * 1024;
pub const DEFAULT_BRIGHTNESS_BOOST: u8 = 100;

const MAX_IMAGE_DIMENSION: u32 = 8192;
const MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MIN_GIF_DELAY: Duration = Duration::from_millis(30);
const YOUTUBE_TIMEOUT: Duration = Duration::from_secs(120);
const YOUTUBE_FORMAT: &str =
    "best[ext=mp4][vcodec^=avc1][height<=720]/best[ext=mp4][height<=720]/best[height<=720]";

#[derive(Clone, Debug, Serialize)]
pub struct TelemetryPayload {
    pub cpu: f64,
    pub mem_used_gb: f64,
    pub mem_total_gb: f64,
    pub cpu_temp: f64,
    pub nvme_temp: f64,
    pub rx: f64,
    pub tx: f64,
    pub load_avg: [f64; 3],
    pub network_live: bool,
    pub uptime_sec: u64,
    pub hostname: String,
}

#[derive(Clone, Copy, Debug)]
struct CpuTicks {
    idle: u64,
    total: u64,
}

#[derive(Clone, Debug)]
struct NetworkSample {
    interface: String,
    rx: u64,
    tx: u64,
    at: Instant,
}

#[derive(Default)]
struct HostTelemetrySampler {
    cpu: Option<CpuTicks>,
    network: Option<NetworkSample>,
}

impl HostTelemetrySampler {
    fn sample(&mut self) -> TelemetryPayload {
        let cpu_now = fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|value| parse_cpu_ticks(&value));
        let cpu = cpu_now
            .map(|now| cpu_usage(self.cpu, now))
            .unwrap_or_default();
        self.cpu = cpu_now;

        let memory = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|value| parse_meminfo(&value))
            .unwrap_or_default();
        let load_avg = fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|value| parse_loadavg(&value))
            .unwrap_or([0.0; 3]);
        let uptime_sec = fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
            .unwrap_or_default()
            .max(0.0) as u64;

        let network_now = read_network_sample();
        let (rx, tx, network_live) = network_rates(self.network.as_ref(), network_now.as_ref());
        self.network = network_now;
        let (cpu_temp, nvme_temp) = read_temperatures();

        TelemetryPayload {
            cpu,
            mem_used_gb: memory.0,
            mem_total_gb: memory.1,
            cpu_temp,
            nvme_temp,
            rx,
            tx,
            load_avg,
            network_live,
            uptime_sec,
            hostname: read_hostname(),
        }
    }
}

fn parse_cpu_ticks(value: &str) -> Option<CpuTicks> {
    let mut fields = value.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let ticks = fields
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if ticks.len() < 4 {
        return None;
    }
    let idle = ticks[3].saturating_add(*ticks.get(4).unwrap_or(&0));
    Some(CpuTicks {
        idle,
        total: ticks.into_iter().sum(),
    })
}

fn cpu_usage(previous: Option<CpuTicks>, current: CpuTicks) -> f64 {
    let (idle, total) = if let Some(previous) = previous {
        (
            current.idle.saturating_sub(previous.idle),
            current.total.saturating_sub(previous.total),
        )
    } else {
        (current.idle, current.total)
    };
    if total == 0 {
        return 0.0;
    }
    ((total.saturating_sub(idle)) as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
}

fn parse_meminfo(value: &str) -> Option<(f64, f64)> {
    let values = value
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            Some((name, kb))
        })
        .collect::<HashMap<_, _>>();
    let total = *values.get("MemTotal")?;
    let available = values
        .get("MemAvailable")
        .copied()
        .or_else(|| values.get("MemFree").copied())
        .unwrap_or_default();
    let divisor = 1024.0 * 1024.0;
    Some((
        total.saturating_sub(available) as f64 / divisor,
        total as f64 / divisor,
    ))
}

fn parse_loadavg(value: &str) -> Option<[f64; 3]> {
    let mut fields = value.split_whitespace();
    Some([
        fields.next()?.parse().ok()?,
        fields.next()?.parse().ok()?,
        fields.next()?.parse().ok()?,
    ])
}

fn default_interface() -> Option<String> {
    let routes = fs::read_to_string("/proc/net/route").ok()?;
    routes.lines().skip(1).find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        (fields.len() > 3 && fields[1] == "00000000").then(|| fields[0].to_string())
    })
}

fn parse_network_bytes(value: &str, interface: &str) -> Option<(u64, u64)> {
    value.lines().find_map(|line| {
        let (name, counters) = line.split_once(':')?;
        if name.trim() != interface {
            return None;
        }
        let fields = counters.split_whitespace().collect::<Vec<_>>();
        Some((fields.first()?.parse().ok()?, fields.get(8)?.parse().ok()?))
    })
}

fn read_network_sample() -> Option<NetworkSample> {
    let interface = default_interface()?;
    let value = fs::read_to_string("/proc/net/dev").ok()?;
    let (rx, tx) = parse_network_bytes(&value, &interface)?;
    Some(NetworkSample {
        interface,
        rx,
        tx,
        at: Instant::now(),
    })
}

fn network_rates(
    previous: Option<&NetworkSample>,
    current: Option<&NetworkSample>,
) -> (f64, f64, bool) {
    let Some(current) = current else {
        return (0.0, 0.0, false);
    };
    let Some(previous) = previous.filter(|old| old.interface == current.interface) else {
        return (0.0, 0.0, true);
    };
    let seconds = current
        .at
        .saturating_duration_since(previous.at)
        .as_secs_f64();
    if seconds <= f64::EPSILON {
        return (0.0, 0.0, true);
    }
    (
        current.rx.saturating_sub(previous.rx) as f64 / seconds / 1_000_000.0,
        current.tx.saturating_sub(previous.tx) as f64 / seconds / 1_000_000.0,
        true,
    )
}

fn read_temperatures() -> (f64, f64) {
    let Ok(entries) = fs::read_dir("/sys/class/hwmon") else {
        return (0.0, 0.0);
    };
    let mut cpu_candidates = Vec::new();
    let mut nvme_candidates = Vec::new();
    for entry in entries.flatten() {
        let root = entry.path();
        let chip = fs::read_to_string(root.join("name"))
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let Ok(files) = fs::read_dir(&root) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            let Some(index) = name
                .strip_prefix("temp")
                .and_then(|rest| rest.strip_suffix("_input"))
            else {
                continue;
            };
            let Some(temp) = fs::read_to_string(file.path())
                .ok()
                .and_then(|raw| raw.trim().parse::<f64>().ok())
                .map(|millidegrees| millidegrees / 1000.0)
                .filter(|value| (0.0..=150.0).contains(value))
            else {
                continue;
            };
            let label = fs::read_to_string(root.join(format!("temp{index}_label")))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if chip.contains("nvme") {
                nvme_candidates.push(temp);
            } else {
                let preferred = label.contains("tctl")
                    || label.contains("tdie")
                    || label.contains("package")
                    || label.contains("cpu");
                cpu_candidates.push((preferred, temp));
            }
        }
    }
    let cpu = cpu_candidates
        .iter()
        .find_map(|(preferred, value)| preferred.then_some(*value))
        .or_else(|| cpu_candidates.first().map(|(_, value)| *value))
        .unwrap_or_default();
    (cpu, nvme_candidates.first().copied().unwrap_or_default())
}

fn read_hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "proxmox".to_string())
}

#[derive(RustEmbed)]
#[folder = "../../oled-studio/dist/"]
struct StudioAssets;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Job {
    Idle,
    Gif,
    Still,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatusPayload {
    pub ok: bool,
    pub simulated: bool,
    pub display_on: bool,
    /// Software RGB midtone boost. This does not control the LCD backlight.
    pub brightness: u8,
    pub job: Job,
    pub device: String,
    pub uptime_sec: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct WorkerStatus {
    ok: bool,
    display_on: bool,
    brightness: u8,
    job: Job,
    error: Option<String>,
}

/// Device contract owned by the bridge worker.
///
/// Production uses `asterctl_lcd::AooScreen`; the trait also keeps protocol-free HTTP tests fast.
pub trait DisplayDevice: Send + 'static {
    fn power_on(&mut self) -> anyhow::Result<()>;
    fn power_off(&mut self) -> anyhow::Result<()>;
    fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()>;
    fn clear_cache(&mut self);
}

impl DisplayDevice for AooScreen {
    fn power_on(&mut self) -> anyhow::Result<()> {
        self.on()
    }

    fn power_off(&mut self) -> anyhow::Result<()> {
        self.off()
    }

    fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()> {
        AooScreen::send_rgb565_le(self, frame)
    }

    fn clear_cache(&mut self) {
        AooScreen::clear_cache(self);
    }
}

#[derive(Debug)]
struct GifFrame {
    data: Vec<u8>,
    delay: Duration,
}

#[derive(Debug)]
struct GifPlayback {
    frames: Vec<GifFrame>,
    frame_index: usize,
    next_frame_at: Instant,
}

enum Command {
    Power {
        on: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Frame {
        data: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Gif {
        frames: Vec<GifFrame>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Brightness {
        percent: u8,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Stop {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        off_on_exit: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

impl Command {
    fn reply_is_closed(&self) -> bool {
        match self {
            Self::Power { reply, .. }
            | Self::Frame { reply, .. }
            | Self::Gif { reply, .. }
            | Self::Brightness { reply, .. }
            | Self::Stop { reply }
            | Self::Shutdown { reply, .. } => reply.is_closed(),
        }
    }

    fn reply(self, result: Result<(), String>) {
        match self {
            Self::Power { reply, .. }
            | Self::Frame { reply, .. }
            | Self::Gif { reply, .. }
            | Self::Brightness { reply, .. }
            | Self::Stop { reply }
            | Self::Shutdown { reply, .. } => {
                let _ = reply.send(result);
            }
        }
    }
}

struct QueuedCommand {
    command: Command,
    expires_at: Option<Instant>,
}

impl QueuedCommand {
    fn is_stale(&self) -> bool {
        self.command.reply_is_closed()
            || self
                .expires_at
                .is_some_and(|deadline| Instant::now() >= deadline)
    }
}

#[derive(Clone)]
pub struct BridgeHandle {
    data_tx: mpsc::SyncSender<QueuedCommand>,
    control_tx: mpsc::Sender<QueuedCommand>,
    status: Arc<RwLock<WorkerStatus>>,
    simulated: bool,
    device: Arc<str>,
    started_at: Instant,
}

pub struct BridgeRuntime {
    handle: BridgeHandle,
    worker: Option<JoinHandle<()>>,
}

impl BridgeRuntime {
    pub fn spawn(
        device: Box<dyn DisplayDevice>,
        simulated: bool,
        device_name: impl Into<String>,
        display_on: bool,
    ) -> Self {
        let (data_tx, data_rx) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel();
        let status = Arc::new(RwLock::new(WorkerStatus {
            ok: true,
            display_on,
            brightness: DEFAULT_BRIGHTNESS_BOOST,
            job: Job::Idle,
            error: None,
        }));
        let worker_status = status.clone();
        let worker = std::thread::Builder::new()
            .name("asterctl-display".to_string())
            .spawn(move || {
                let panic_status = worker_status.clone();
                if let Err(payload) = catch_unwind(AssertUnwindSafe(|| {
                    worker_loop(device, data_rx, control_rx, worker_status)
                })) {
                    set_worker_error(&panic_status, "display worker panicked".to_string());
                    resume_unwind(payload);
                }
            })
            .expect("failed to spawn display worker");

        Self {
            handle: BridgeHandle {
                data_tx,
                control_tx,
                status,
                simulated,
                device: Arc::from(device_name.into()),
                started_at: Instant::now(),
            },
            worker: Some(worker),
        }
    }

    pub fn handle(&self) -> BridgeHandle {
        self.handle.clone()
    }

    pub async fn shutdown(mut self, off_on_exit: bool) -> anyhow::Result<()> {
        let command_result = self.handle.request_shutdown(off_on_exit).await;

        if let Some(worker) = self.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .context("display worker join task failed")?
                .map_err(|_| anyhow!("display worker panicked"))?;
        }

        command_result.map_err(|error| anyhow!(error))
    }
}

impl BridgeHandle {
    pub fn status(&self) -> StatusPayload {
        let status = self
            .status
            .read()
            .expect("display status lock poisoned")
            .clone();
        StatusPayload {
            ok: status.ok,
            simulated: self.simulated,
            display_on: status.display_on,
            brightness: status.brightness,
            job: status.job,
            device: self.device.to_string(),
            uptime_sec: self.started_at.elapsed().as_secs(),
            error: status.error,
        }
    }

    async fn request_data(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Command,
    ) -> Result<(), BridgeRequestError> {
        let (reply, response) = oneshot::channel();
        let queued = QueuedCommand {
            command: make_command(reply),
            expires_at: Some(Instant::now() + COMMAND_TIMEOUT),
        };
        match self.data_tx.try_send(queued) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => return Err(BridgeRequestError::QueueFull),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err(BridgeRequestError::WorkerUnavailable);
            }
        }

        Self::await_response(response).await
    }

    async fn request_control(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Command,
    ) -> Result<(), BridgeRequestError> {
        let (reply, response) = oneshot::channel();
        self.control_tx
            .send(QueuedCommand {
                command: make_command(reply),
                expires_at: Some(Instant::now() + COMMAND_TIMEOUT),
            })
            .map_err(|_| BridgeRequestError::WorkerUnavailable)?;

        Self::await_response(response).await
    }

    async fn request_shutdown(&self, off_on_exit: bool) -> Result<(), BridgeRequestError> {
        let (reply, response) = oneshot::channel();
        self.control_tx
            .send(QueuedCommand {
                command: Command::Shutdown { off_on_exit, reply },
                expires_at: None,
            })
            .map_err(|_| BridgeRequestError::WorkerUnavailable)?;

        Self::await_response(response).await
    }

    async fn await_response(
        response: oneshot::Receiver<Result<(), String>>,
    ) -> Result<(), BridgeRequestError> {
        tokio::time::timeout(COMMAND_TIMEOUT, response)
            .await
            .map_err(|_| BridgeRequestError::Timeout)?
            .map_err(|_| BridgeRequestError::WorkerUnavailable)?
            .map_err(BridgeRequestError::Device)
    }
}

#[derive(Debug)]
enum BridgeRequestError {
    QueueFull,
    WorkerUnavailable,
    Timeout,
    Device(String),
}

impl std::fmt::Display for BridgeRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueueFull => formatter.write_str("display command queue is full"),
            Self::WorkerUnavailable => formatter.write_str("display worker is not running"),
            Self::Timeout => formatter.write_str("display command timed out"),
            Self::Device(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for BridgeRequestError {}

fn set_worker_success(status: &Arc<RwLock<WorkerStatus>>, display_on: Option<bool>, job: Job) {
    let mut status = status.write().expect("display status lock poisoned");
    status.ok = true;
    status.error = None;
    if let Some(display_on) = display_on {
        status.display_on = display_on;
    }
    status.job = job;
}

fn set_worker_job(status: &Arc<RwLock<WorkerStatus>>, job: Job) {
    status.write().expect("display status lock poisoned").job = job;
}

fn set_worker_brightness(status: &Arc<RwLock<WorkerStatus>>, brightness: u8) {
    status
        .write()
        .expect("display status lock poisoned")
        .brightness = brightness;
}

fn boost_rgb565_le(frame: &[u8], brightness: u8) -> Vec<u8> {
    let gamma = 100.0 / f32::from(brightness.clamp(100, 200));
    // One scale factor per pixel, derived from a gamma curve on its brightest
    // channel: all three channels are multiplied by the same factor, so hue and
    // saturation are preserved instead of washing midtone colors toward white
    // the way an independent per-channel gamma does. Black, white and any
    // already-full channel are unchanged.
    let scale_lut: [f32; 256] = std::array::from_fn(|value| {
        if value == 0 {
            1.0
        } else {
            let max = value as f32 / 255.0;
            max.powf(gamma) / max
        }
    });
    let mut boosted = Vec::with_capacity(frame.len());
    for pixel in frame.as_chunks::<2>().0 {
        let packed = u16::from_le_bytes(*pixel);
        let red = ((packed >> 11) & 0x1f) as u32;
        let green = ((packed >> 5) & 0x3f) as u32;
        let blue = (packed & 0x1f) as u32;
        let red8 = (red << 3 | red >> 2) as f32;
        let green8 = (green << 2 | green >> 4) as f32;
        let blue8 = (blue << 3 | blue >> 2) as f32;
        let scale = scale_lut[red8.max(green8).max(blue8) as usize];
        let red = ((red8 * scale).round().min(255.0) as u16) >> 3;
        let green = ((green8 * scale).round().min(255.0) as u16) >> 2;
        let blue = ((blue8 * scale).round().min(255.0) as u16) >> 3;
        boosted.extend_from_slice(&(red << 11 | green << 5 | blue).to_le_bytes());
    }
    boosted
}

fn send_with_brightness(
    device: &mut dyn DisplayDevice,
    frame: &[u8],
    brightness: u8,
) -> anyhow::Result<()> {
    if brightness == 100 {
        device.send_rgb565_le(frame)
    } else {
        device.send_rgb565_le(&boost_rgb565_le(frame, brightness))
    }
}

fn set_worker_error(status: &Arc<RwLock<WorkerStatus>>, message: String) {
    let mut status = status.write().expect("display status lock poisoned");
    status.ok = false;
    status.job = Job::Idle;
    status.error = Some(message);
}

fn worker_loop(
    mut device: Box<dyn DisplayDevice>,
    data_rx: mpsc::Receiver<QueuedCommand>,
    control_rx: mpsc::Receiver<QueuedCommand>,
    status: Arc<RwLock<WorkerStatus>>,
) {
    let mut playback: Option<GifPlayback> = None;
    let mut brightness = DEFAULT_BRIGHTNESS_BOOST;
    let mut last_frame: Option<Vec<u8>> = None;

    loop {
        let mut control_disconnected = false;
        let queued = match control_rx.try_recv() {
            Ok(command) => Some(command),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                control_disconnected = true;
                None
            }
        };

        // A GIF whose UART write takes longer than its source delay is always
        // due. Poll the data lane before drawing that next frame so a new GIF,
        // still, stats frame, or video frame can replace it without timing out.
        let queued = if queued.is_some() {
            queued
        } else {
            match data_rx.try_recv() {
                Ok(command) => Some(command),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) if control_disconnected => break,
                Err(mpsc::TryRecvError::Disconnected) => None,
            }
        };

        let queued = if queued.is_some() {
            queued
        } else if playback
            .as_ref()
            .is_some_and(|active| active.next_frame_at <= Instant::now())
        {
            None
        } else {
            let wait = playback
                .as_ref()
                .map(|active| {
                    active
                        .next_frame_at
                        .saturating_duration_since(Instant::now())
                        .min(CONTROL_POLL_INTERVAL)
                })
                .unwrap_or(CONTROL_POLL_INTERVAL);
            match data_rx.recv_timeout(wait) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) if control_disconnected => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    std::thread::sleep(CONTROL_POLL_INTERVAL);
                    None
                }
            }
        };

        if let Some(queued) = queued {
            if queued.is_stale() {
                queued
                    .command
                    .reply(Err("display command expired before execution".to_string()));
                continue;
            }

            let command = queued.command;

            // Software brightness boost changes the next frame (and refreshes
            // the current one) without stopping an active GIF loop.
            if matches!(&command, Command::Brightness { .. }) {
                let Command::Brightness { percent, reply } = command else {
                    unreachable!();
                };
                brightness = percent;
                set_worker_brightness(&status, brightness);
                let display_on = status
                    .read()
                    .expect("display status lock poisoned")
                    .display_on;
                let result = if display_on {
                    last_frame.as_deref().map_or(Ok(()), |frame| {
                        send_with_brightness(&mut *device, frame, brightness)
                    })
                } else {
                    Ok(())
                };
                if let Err(error) = &result {
                    set_worker_error(&status, error.to_string());
                }
                let _ = reply.send(result.map_err(|error| error.to_string()));
                continue;
            }

            // Every other mutating command supersedes an active GIF before it is handled.
            playback = None;
            set_worker_job(&status, Job::Idle);

            match command {
                Command::Power { on, reply } => {
                    let result = if on {
                        device.power_on()
                    } else {
                        device.power_off()
                    };
                    if result.is_ok() {
                        set_worker_success(&status, Some(on), Job::Idle);
                    } else if let Err(error) = &result {
                        set_worker_error(&status, error.to_string());
                    }
                    let _ = reply.send(result.map_err(|error| error.to_string()));
                }
                Command::Frame { data, reply } => {
                    let result = send_with_brightness(&mut *device, &data, brightness);
                    if result.is_ok() {
                        last_frame = Some(data);
                        set_worker_success(&status, None, Job::Still);
                    } else if let Err(error) = &result {
                        set_worker_error(&status, error.to_string());
                    }
                    let _ = reply.send(result.map_err(|error| error.to_string()));
                }
                Command::Gif { frames, reply } => {
                    if frames.is_empty() {
                        let _ = reply.send(Err("GIF contains no frames".to_string()));
                        continue;
                    }
                    device.clear_cache();
                    let mut started = GifPlayback {
                        frames,
                        frame_index: 0,
                        next_frame_at: Instant::now(),
                    };
                    let result =
                        send_with_brightness(&mut *device, &started.frames[0].data, brightness);
                    match result {
                        Ok(()) => {
                            last_frame = Some(started.frames[0].data.clone());
                            advance_playback(&mut started, Instant::now());
                            playback = Some(started);
                            set_worker_success(&status, None, Job::Gif);
                            let _ = reply.send(Ok(()));
                        }
                        Err(error) => {
                            let message = error.to_string();
                            set_worker_error(&status, message.clone());
                            let _ = reply.send(Err(message));
                        }
                    }
                }
                Command::Brightness { .. } => unreachable!("brightness is handled above"),
                Command::Stop { reply } => {
                    set_worker_job(&status, Job::Idle);
                    let _ = reply.send(Ok(()));
                }
                Command::Shutdown { off_on_exit, reply } => {
                    let result = if off_on_exit {
                        device.power_off()
                    } else {
                        Ok(())
                    };
                    if result.is_ok() && off_on_exit {
                        set_worker_success(&status, Some(false), Job::Idle);
                    } else if let Err(error) = &result {
                        set_worker_error(&status, error.to_string());
                    }
                    let _ = reply.send(result.map_err(|error| error.to_string()));
                    break;
                }
            }
            continue;
        }

        let Some(active) = playback.as_mut() else {
            continue;
        };
        let frame = &active.frames[active.frame_index];
        match send_with_brightness(&mut *device, &frame.data, brightness) {
            Ok(()) => {
                last_frame = Some(frame.data.clone());
                advance_playback(active, Instant::now());
            }
            Err(send_error) => {
                error!("GIF playback stopped after display error: {send_error:#}");
                playback = None;
                set_worker_error(&status, send_error.to_string());
            }
        }
    }

    debug!("display worker stopped");
}

/// Advance in source order. If UART writes are slower than the source cadence,
/// play the next frame immediately instead of skipping into a later/blank frame.
fn advance_playback(playback: &mut GifPlayback, now: Instant) {
    let sent_delay = playback.frames[playback.frame_index].delay;
    playback.frame_index = (playback.frame_index + 1) % playback.frames.len();
    playback.next_frame_at = (playback.next_frame_at + sent_delay).max(now);
}

#[derive(Clone)]
struct AppState {
    bridge: BridgeHandle,
    decode_slots: Arc<Semaphore>,
    telemetry: Arc<Mutex<HostTelemetrySampler>>,
    youtube: YoutubeState,
}

#[derive(Clone, Debug)]
struct YoutubeAsset {
    token: String,
    path: PathBuf,
    content_type: &'static str,
}

#[derive(Clone)]
struct YoutubeState {
    tool: PathBuf,
    runtime_dir: PathBuf,
    slot: Arc<Semaphore>,
    current: Arc<Mutex<Option<YoutubeAsset>>>,
    sequence: Arc<AtomicU64>,
}

impl Default for YoutubeState {
    fn default() -> Self {
        let tool = std::env::var_os("ASTERCTL_YTDLP")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/usr/local/libexec/asterctl-web/yt-dlp"));
        let runtime_dir = std::env::var_os("ASTERCTL_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/run/asterctl-web/youtube"));
        Self {
            tool,
            runtime_dir,
            slot: Arc::new(Semaphore::new(1)),
            current: Arc::new(Mutex::new(None)),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
}

pub fn build_router(bridge: BridgeHandle) -> Router {
    build_router_with_decode_slots(bridge, Arc::new(Semaphore::new(MAX_CONCURRENT_DECODES)))
}

fn build_router_with_decode_slots(bridge: BridgeHandle, decode_slots: Arc<Semaphore>) -> Router {
    let development_origins = vec![
        HeaderValue::from_static("http://127.0.0.1:5173"),
        HeaderValue::from_static("http://localhost:5173"),
    ];
    let cors = CorsLayer::new()
        .allow_origin(development_origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([CONTENT_TYPE]);

    Router::new()
        .route("/", get(index))
        .route("/api/status", get(api_status))
        .route("/api/telemetry", get(api_telemetry))
        .route("/api/display/on", post(display_on))
        .route("/api/display/off", post(display_off))
        .route("/api/display/brightness", post(display_brightness))
        .route("/api/frame", post(frame))
        .route("/api/image", post(image))
        .route("/api/youtube", post(youtube_download))
        .route("/api/youtube/release", post(youtube_release))
        .route("/api/youtube/video/{token}", get(youtube_video))
        .route("/api/stop", post(stop))
        .fallback(static_or_not_found)
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(cors)
        .layer(middleware::from_fn(restrict_origins))
        .with_state(AppState {
            bridge,
            decode_slots,
            telemetry: Arc::new(Mutex::new(HostTelemetrySampler::default())),
            youtube: YoutubeState::default(),
        })
}

async fn restrict_origins(request: Request, next: Next) -> Response {
    if request_origin_allowed(request.headers()) {
        next.run(request).await
    } else {
        ApiError::forbidden("cross-origin request is not allowed").into_response()
    }
}

fn request_origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        // Non-browser clients and ordinary same-origin GET requests commonly omit Origin.
        return true;
    };
    if matches!(origin, "http://127.0.0.1:5173" | "http://localhost:5173") {
        return true;
    }

    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| {
            uri.authority()
                .map(|authority| authority.as_str().to_owned())
        })
        .is_some_and(|authority| authority.eq_ignore_ascii_case(host))
}

async fn index() -> Response {
    embedded_asset("index.html")
}

async fn static_or_not_found(method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return ApiError::not_found("not found").into_response();
    }

    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return ApiError::not_found("not found").into_response();
    }
    if path.contains("..") || path.contains('\\') {
        return ApiError::not_found("not found").into_response();
    }

    if StudioAssets::get(path).is_some() {
        embedded_asset(path)
    } else if path
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.'))
    {
        // A missing file (especially a hashed Vite asset) must not receive HTML with status 200.
        ApiError::not_found("embedded UI asset not found").into_response()
    } else {
        // Vite is a single-page app; non-file routes fall back to its entry point.
        embedded_asset("index.html")
    }
}

fn embedded_asset(path: &str) -> Response {
    let Some(asset) = StudioAssets::get(path) else {
        return ApiError::not_found("embedded UI asset not found").into_response();
    };
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" || !path.starts_with("assets/") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    let mut response = Response::new(Body::from(asset.data.into_owned()));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

async fn api_status(State(state): State<AppState>) -> ApiJson<StatusPayload> {
    ApiJson(state.bridge.status())
}

async fn api_telemetry(State(state): State<AppState>) -> ApiResult<TelemetryPayload> {
    let mut sampler = state
        .telemetry
        .lock()
        .map_err(|_| ApiError::internal("telemetry sampler lock is unavailable"))?;
    Ok(ApiJson(sampler.sample()))
}

#[derive(Debug, Deserialize)]
struct YoutubeRequest {
    url: String,
}

#[derive(Debug, Deserialize)]
struct YoutubeReleaseRequest {
    token: String,
}

#[derive(Debug, Serialize)]
struct YoutubeResponse {
    ok: bool,
    token: String,
    title: String,
    stream_url: String,
}

fn validate_youtube_url(value: &str) -> Result<Url, ApiError> {
    let parsed = Url::parse(value.trim())
        .map_err(|_| ApiError::bad_request("enter a valid HTTPS YouTube URL"))?;
    if parsed.scheme() != "https" {
        return Err(ApiError::bad_request("YouTube URL must use HTTPS"));
    }
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| ApiError::bad_request("YouTube URL has no host"))?;
    let youtube_host = host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com");
    if !youtube_host {
        return Err(ApiError::bad_request("only YouTube links are accepted"));
    }
    Ok(parsed)
}

fn youtube_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("webm") => "video/webm",
        Some("m4v") => "video/x-m4v",
        _ => "video/mp4",
    }
}

fn next_youtube_token(state: &YoutubeState) -> String {
    let sequence = state.sequence.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis:x}-{sequence:x}")
}

async fn youtube_download(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<YoutubeRequest>,
) -> ApiResult<YoutubeResponse> {
    let parsed = validate_youtube_url(&request.url)?;
    let _permit = state
        .youtube
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::service_unavailable("another YouTube video is being prepared"))?;
    if !state.youtube.tool.is_file() {
        return Err(ApiError::service_unavailable(
            "bundled yt-dlp helper is not installed",
        ));
    }
    fs::create_dir_all(&state.youtube.runtime_dir).map_err(|error| {
        ApiError::internal(format!("could not create video runtime directory: {error}"))
    })?;
    let runtime = fs::canonicalize(&state.youtube.runtime_dir).map_err(|error| {
        ApiError::internal(format!(
            "could not resolve video runtime directory: {error}"
        ))
    })?;
    let token = next_youtube_token(&state.youtube);
    let output_template = runtime.join(format!("{token}.%(ext)s"));
    let mut command = TokioCommand::new(&state.youtube.tool);
    command
        .kill_on_drop(true)
        .arg("--ignore-config")
        .arg("--no-cache-dir")
        .arg("--no-playlist")
        .arg("--quiet")
        .arg("--no-warnings")
        .arg("--no-progress")
        .arg("--no-color")
        .arg("--socket-timeout")
        .arg("15")
        .arg("--retries")
        .arg("2")
        .arg("--max-filesize")
        .arg("128M")
        .arg("--format")
        .arg(YOUTUBE_FORMAT)
        .arg("--output")
        .arg(&output_template)
        .arg("--print")
        .arg("video:title:%(title)s")
        .arg("--print")
        .arg("after_move:path:%(filepath)s")
        .arg("--")
        .arg(parsed.as_str());
    let output = timeout(YOUTUBE_TIMEOUT, command.output())
        .await
        .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "YouTube download timed out"))?
        .map_err(|error| ApiError::service_unavailable(format!("could not run yt-dlp: {error}")))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(ApiError::bad_gateway(if message.is_empty() {
            "yt-dlp could not prepare that video".to_string()
        } else {
            format!("yt-dlp: {message}")
        }));
    }
    let lines = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let path_line = lines
        .iter()
        .find_map(|line| line.strip_prefix("path:"))
        .ok_or_else(|| ApiError::bad_gateway("yt-dlp did not produce a playable file"))?;
    let path = fs::canonicalize(path_line).map_err(|error| {
        ApiError::bad_gateway(format!("could not resolve downloaded video: {error}"))
    })?;
    if path.parent() != Some(runtime.as_path()) {
        return Err(ApiError::forbidden(
            "downloaded video escaped the private runtime directory",
        ));
    }
    let size = fs::metadata(&path)
        .map_err(|error| {
            ApiError::bad_gateway(format!("could not inspect downloaded video: {error}"))
        })?
        .len();
    if size == 0 || size > MAX_YOUTUBE_BYTES {
        let _ = fs::remove_file(&path);
        return Err(ApiError::payload_too_large(
            "downloaded video exceeds the 128 MiB limit",
        ));
    }
    let title = lines
        .iter()
        .find_map(|line| line.strip_prefix("title:"))
        .map(|value| value.chars().take(160).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "YouTube video".to_string());
    let asset = YoutubeAsset {
        token: token.clone(),
        content_type: youtube_content_type(&path),
        path,
    };
    let previous = state
        .youtube
        .current
        .lock()
        .map_err(|_| ApiError::internal("YouTube state lock is unavailable"))?
        .replace(asset);
    if let Some(previous) = previous {
        let _ = fs::remove_file(previous.path);
    }
    Ok(ApiJson(YoutubeResponse {
        ok: true,
        token: token.clone(),
        title,
        stream_url: format!("/api/youtube/video/{token}"),
    }))
}

async fn youtube_release(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<YoutubeReleaseRequest>,
) -> ApiResult<YoutubeResponse> {
    let mut current = state
        .youtube
        .current
        .lock()
        .map_err(|_| ApiError::internal("YouTube state lock is unavailable"))?;
    if current
        .as_ref()
        .is_some_and(|asset| asset.token == request.token)
        && let Some(asset) = current.take()
    {
        let _ = fs::remove_file(asset.path);
    }
    Ok(ApiJson(YoutubeResponse {
        ok: true,
        token: request.token,
        title: String::new(),
        stream_url: String::new(),
    }))
}

fn parse_byte_range(value: Option<&HeaderValue>, length: u64) -> Result<(u64, u64), ApiError> {
    if length == 0 {
        return Err(ApiError::not_found("video is empty"));
    }
    let Some(value) = value else {
        return Ok((0, length - 1));
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid byte range"))?;
    let range = value
        .strip_prefix("bytes=")
        .filter(|value| !value.contains(','))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "only one byte range is supported",
            )
        })?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid byte range"))?;
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid suffix range")
            })?;
        (length.saturating_sub(suffix.min(length)), length - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range start"))?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range end"))?
                .min(length - 1)
        };
        (start, end)
    };
    if start >= length || start > end {
        return Err(ApiError::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "requested range is outside the video",
        ));
    }
    Ok((start, end))
}

async fn youtube_video(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let asset = state
        .youtube
        .current
        .lock()
        .map_err(|_| ApiError::internal("YouTube state lock is unavailable"))?
        .as_ref()
        .filter(|asset| asset.token == token)
        .cloned()
        .ok_or_else(|| ApiError::not_found("video token is no longer available"))?;
    let bytes = tokio::task::spawn_blocking({
        let path = asset.path.clone();
        move || fs::read(path)
    })
    .await
    .map_err(|error| ApiError::internal(format!("video read task failed: {error}")))?
    .map_err(|error| ApiError::not_found(format!("video is unavailable: {error}")))?;
    let length = bytes.len() as u64;
    let requested = headers.get(RANGE);
    let (start, end) = parse_byte_range(requested, length)?;
    let partial = requested.is_some();
    let body = bytes[start as usize..=end as usize].to_vec();
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let response_headers = response.headers_mut();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static(asset.content_type));
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&(end - start + 1).to_string())
            .map_err(|_| ApiError::internal("invalid video content length"))?,
    );
    if partial {
        response_headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}"))
                .map_err(|_| ApiError::internal("invalid video content range"))?,
        );
    }
    Ok(response)
}

async fn display_on(State(state): State<AppState>) -> ApiResult<StatusPayload> {
    state
        .bridge
        .request_control(|reply| Command::Power { on: true, reply })
        .await
        .map_err(ApiError::bridge)?;
    Ok(ApiJson(state.bridge.status()))
}

async fn display_off(State(state): State<AppState>) -> ApiResult<StatusPayload> {
    state
        .bridge
        .request_control(|reply| Command::Power { on: false, reply })
        .await
        .map_err(ApiError::bridge)?;
    Ok(ApiJson(state.bridge.status()))
}

#[derive(Deserialize)]
struct BrightnessRequest {
    percent: u8,
}

async fn display_brightness(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<BrightnessRequest>,
) -> ApiResult<StatusPayload> {
    if !(100..=200).contains(&request.percent) {
        return Err(ApiError::bad_request(
            "software brightness boost must be between 100 and 200 percent",
        ));
    }
    state
        .bridge
        .request_control(|reply| Command::Brightness {
            percent: request.percent,
            reply,
        })
        .await
        .map_err(ApiError::bridge)?;
    Ok(ApiJson(state.bridge.status()))
}

async fn frame(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> ApiResult<StatusPayload> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next());
    if content_type != Some("application/octet-stream") {
        return Err(ApiError::unsupported_media_type(
            "expected Content-Type application/octet-stream",
        ));
    }

    let body = body.map_err(ApiError::body_rejection)?;
    if body.len() != FRAME_BYTES {
        return Err(ApiError::bad_request(format!(
            "expected {FRAME_BYTES} bytes, got {}",
            body.len()
        )));
    }

    state
        .bridge
        .request_data(|reply| Command::Frame {
            data: body.to_vec(),
            reply,
        })
        .await
        .map_err(ApiError::bridge)?;
    Ok(ApiJson(state.bridge.status()))
}

async fn image(
    State(state): State<AppState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<StatusPayload> {
    let _decode_permit = state
        .decode_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::service_unavailable("image decoder is busy"))?;
    let mut multipart = multipart.map_err(ApiError::multipart_rejection)?;
    let mut upload = None;

    while let Some(field) = multipart.next_field().await.map_err(|error| {
        ApiError::new(error.status(), format!("invalid multipart body: {error}"))
    })? {
        if field.name() != Some("file") {
            continue;
        }
        let data = field.bytes().await.map_err(|error| {
            ApiError::new(error.status(), format!("invalid upload field: {error}"))
        })?;
        if data.is_empty() {
            return Err(ApiError::bad_request("uploaded file is empty"));
        }
        if data.len() > MAX_UPLOAD_BYTES {
            return Err(ApiError::payload_too_large(format!(
                "upload exceeds {} MiB limit",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            )));
        }
        upload = Some(data);
        break;
    }

    let upload = upload.ok_or_else(|| ApiError::bad_request("no file part found"))?;
    let decoded = tokio::task::spawn_blocking(move || decode_upload(&upload))
        .await
        .map_err(|error| ApiError::internal(format!("image decoder task failed: {error}")))?
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    match decoded {
        DecodedUpload::Still(data) => {
            state
                .bridge
                .request_data(|reply| Command::Frame { data, reply })
                .await
                .map_err(ApiError::bridge)?;
        }
        DecodedUpload::Gif(frames) => {
            state
                .bridge
                .request_data(|reply| Command::Gif { frames, reply })
                .await
                .map_err(ApiError::bridge)?;
        }
    }

    Ok(ApiJson(state.bridge.status()))
}

async fn stop(State(state): State<AppState>) -> ApiResult<StatusPayload> {
    state
        .bridge
        .request_control(|reply| Command::Stop { reply })
        .await
        .map_err(ApiError::bridge)?;
    Ok(ApiJson(state.bridge.status()))
}

enum DecodedUpload {
    Still(Vec<u8>),
    Gif(Vec<GifFrame>),
}

fn decode_upload(data: &[u8]) -> anyhow::Result<DecodedUpload> {
    let format = image::guess_format(data).context("could not detect image format")?;
    match format {
        ImageFormat::Gif => decode_gif(data).map(DecodedUpload::Gif),
        ImageFormat::Png | ImageFormat::Jpeg => {
            decode_still(data, format).map(DecodedUpload::Still)
        }
        other => Err(anyhow!(
            "unsupported image format {other:?}; expected PNG, JPEG, or GIF"
        )),
    }
}

fn decoder_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    limits
}

fn decode_still(data: &[u8], format: ImageFormat) -> anyhow::Result<Vec<u8>> {
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    reader.limits(decoder_limits());
    let image = reader.decode().context("could not decode image")?;
    let resized = image.resize_exact(DISPLAY_SIZE.0, DISPLAY_SIZE.1, FilterType::Lanczos3);
    Ok((&resized.to_rgb8()).to_rgb565_le().to_vec())
}

fn decode_gif(data: &[u8]) -> anyhow::Result<Vec<GifFrame>> {
    let mut decoder = GifDecoder::new(Cursor::new(data)).context("could not decode GIF header")?;
    decoder
        .set_limits(decoder_limits())
        .context("GIF exceeds decoder limits")?;

    let mut decoded = Vec::new();
    let mut total_pixels = 0_u64;
    for frame in decoder.into_frames() {
        if decoded.len() >= MAX_GIF_FRAMES {
            return Err(anyhow!("GIF exceeds {MAX_GIF_FRAMES} frame limit"));
        }

        let frame = frame.context("could not decode GIF frame")?;
        let source_pixels = u64::from(frame.buffer().width()) * u64::from(frame.buffer().height());
        let stored_pixels = u64::from(DISPLAY_SIZE.0) * u64::from(DISPLAY_SIZE.1);
        total_pixels = total_pixels
            .checked_add(source_pixels.max(stored_pixels))
            .ok_or_else(|| anyhow!("GIF pixel count overflow"))?;
        if total_pixels > MAX_GIF_TOTAL_PIXELS {
            return Err(anyhow!(
                "GIF exceeds {MAX_GIF_TOTAL_PIXELS} total pixel limit"
            ));
        }

        let (delay_numerator, delay_denominator) = frame.delay().numer_denom_ms();
        let native_delay = if delay_denominator == 0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(
                f64::from(delay_numerator) / f64::from(delay_denominator) / 1000.0,
            )
        };
        let resized = image::DynamicImage::ImageRgba8(frame.into_buffer()).resize_exact(
            DISPLAY_SIZE.0,
            DISPLAY_SIZE.1,
            FilterType::Lanczos3,
        );
        decoded.push(GifFrame {
            data: (&resized.to_rgb8()).to_rgb565_le().to_vec(),
            delay: native_delay.max(MIN_GIF_DELAY),
        });
    }

    if decoded.is_empty() {
        return Err(anyhow!("GIF contains no frames"));
    }
    Ok(decoded)
}

type ApiResult<T> = Result<ApiJson<T>, ApiError>;

struct ApiJson<T>(T);

impl<T: Serialize> IntoResponse for ApiJson<T> {
    fn into_response(self) -> Response {
        let mut response = axum::Json(self.0).into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    ok: bool,
    error: &'a str,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unsupported_media_type(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, message)
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }

    fn bridge(error: BridgeRequestError) -> Self {
        let status = match &error {
            BridgeRequestError::QueueFull | BridgeRequestError::WorkerUnavailable => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            BridgeRequestError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            BridgeRequestError::Device(_) => StatusCode::BAD_GATEWAY,
        };
        Self::new(status, error.to_string())
    }

    fn body_rejection(error: axum::extract::rejection::BytesRejection) -> Self {
        Self::new(error.status(), format!("invalid request body: {error}"))
    }

    fn multipart_rejection(error: MultipartRejection) -> Self {
        Self::new(
            error.status(),
            format!("expected multipart/form-data: {error}"),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let payload = ErrorPayload {
            ok: false,
            error: &self.message,
        };
        let mut response = (self.status, axum::Json(payload)).into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::{Request, StatusCode, header};
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame, Rgba, RgbaImage};
    use std::sync::Mutex;
    use tower::ServiceExt;

    #[test]
    fn linux_telemetry_parsers_report_real_units() {
        let cpu = parse_cpu_ticks("cpu  100 20 30 400 10 5 4 1\ncpu0 0 0 0 0").unwrap();
        assert_eq!(cpu.idle, 410);
        assert_eq!(cpu.total, 570);
        assert!((cpu_usage(None, cpu) - 28.070_175).abs() < 0.001);

        let memory =
            parse_meminfo("MemTotal:       67108864 kB\nMemAvailable:   28311552 kB\n").unwrap();
        assert_eq!(memory, (37.0, 64.0));
        assert_eq!(
            parse_loadavg("1.25 0.75 0.50 1/100 42"),
            Some([1.25, 0.75, 0.5])
        );
        assert_eq!(
            parse_network_bytes(
                "Inter-| Receive | Transmit\n  eno1: 12000000 0 0 0 0 0 0 0 34000000 0 0 0 0 0 0 0\n",
                "eno1",
            ),
            Some((12_000_000, 34_000_000))
        );
    }

    #[test]
    fn youtube_input_is_restricted_and_ranges_are_bounded() {
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("http://youtube.com/watch?v=x").is_err());
        assert!(validate_youtube_url("https://youtube.com.example.test/watch?v=x").is_err());

        assert_eq!(parse_byte_range(None, 100).unwrap(), (0, 99));
        assert_eq!(
            parse_byte_range(Some(&HeaderValue::from_static("bytes=10-19")), 100).unwrap(),
            (10, 19)
        );
        assert_eq!(
            parse_byte_range(Some(&HeaderValue::from_static("bytes=-8")), 100).unwrap(),
            (92, 99)
        );
        assert!(parse_byte_range(Some(&HeaderValue::from_static("bytes=100-")), 100).is_err());
    }

    fn animated_gif() -> Vec<u8> {
        let mut encoded = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut encoded);
            encoder.set_repeat(Repeat::Infinite).unwrap();
            for (color, delay) in [([255, 0, 0, 255], 40), ([0, 255, 0, 255], 120)] {
                let image = RgbaImage::from_pixel(2, 2, Rgba(color));
                encoder
                    .encode_frame(Frame::from_parts(
                        image,
                        0,
                        0,
                        Delay::from_numer_denom_ms(delay, 1),
                    ))
                    .unwrap();
            }
        }
        encoded
    }

    #[derive(Default)]
    struct TestDevice {
        events: Arc<Mutex<Vec<&'static str>>>,
        frame_delay: Duration,
        fail_frame: bool,
    }

    impl DisplayDevice for TestDevice {
        fn power_on(&mut self) -> anyhow::Result<()> {
            self.events.lock().unwrap().push("on");
            Ok(())
        }

        fn power_off(&mut self) -> anyhow::Result<()> {
            self.events.lock().unwrap().push("off");
            Ok(())
        }

        fn send_rgb565_le(&mut self, _frame: &[u8]) -> anyhow::Result<()> {
            std::thread::sleep(self.frame_delay);
            if self.fail_frame {
                return Err(anyhow!("serial write failed"));
            }
            self.events.lock().unwrap().push("frame");
            Ok(())
        }

        fn clear_cache(&mut self) {}
    }

    #[test]
    fn still_image_decodes_to_exact_rgb565_frame() {
        let mut png = Vec::new();
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();

        let DecodedUpload::Still(frame) = decode_upload(&png).unwrap() else {
            panic!("PNG decoded as animation");
        };
        assert_eq!(frame.len(), FRAME_BYTES);
    }

    #[test]
    fn gif_preserves_each_native_delay_with_safety_floor() {
        let DecodedUpload::Gif(frames) = decode_upload(&animated_gif()).unwrap() else {
            panic!("GIF decoded as still image");
        };
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].delay, Duration::from_millis(40));
        assert_eq!(frames[1].delay, Duration::from_millis(120));
        assert!(frames.iter().all(|frame| frame.data.len() == FRAME_BYTES));
    }

    #[test]
    fn unsupported_upload_is_rejected() {
        let error = decode_upload(b"not an image").err().unwrap();
        assert!(error.to_string().contains("detect image format"));
    }

    #[test]
    fn gif_schedule_preserves_source_order_when_writes_are_late() {
        let start = Instant::now();
        let mut playback = GifPlayback {
            frames: vec![
                GifFrame {
                    data: Vec::new(),
                    delay: Duration::from_millis(40),
                },
                GifFrame {
                    data: Vec::new(),
                    delay: Duration::from_millis(100),
                },
                GifFrame {
                    data: Vec::new(),
                    delay: Duration::from_millis(50),
                },
            ],
            frame_index: 0,
            next_frame_at: start,
        };

        advance_playback(&mut playback, start + Duration::from_millis(170));
        assert_eq!(playback.frame_index, 1);
        assert_eq!(playback.next_frame_at, start + Duration::from_millis(170));
        advance_playback(&mut playback, start + Duration::from_millis(170));
        assert_eq!(playback.frame_index, 2);
        assert_eq!(playback.next_frame_at, start + Duration::from_millis(270));
        advance_playback(&mut playback, start + Duration::from_millis(270));
        assert_eq!(playback.frame_index, 0);
    }

    fn rgb565(red: u16, green: u16, blue: u16) -> [u8; 2] {
        (red << 11 | green << 5 | blue).to_le_bytes()
    }

    fn unpack565(pixel: &[u8]) -> (u16, u16, u16) {
        let packed = u16::from_le_bytes([pixel[0], pixel[1]]);
        ((packed >> 11) & 0x1f, (packed >> 5) & 0x3f, packed & 0x1f)
    }

    #[test]
    fn software_brightness_boost_lifts_midtones_and_preserves_endpoints() {
        // Black, white and fully saturated primaries are already at the panel's
        // limit for their hue and must pass through unchanged.
        for endpoint in [
            rgb565(0, 0, 0),
            rgb565(31, 63, 31),
            rgb565(31, 0, 0),
            rgb565(0, 63, 0),
            rgb565(0, 0, 31),
        ] {
            assert_eq!(boost_rgb565_le(&endpoint, 200), endpoint);
        }

        // A midtone gray gets strictly brighter and stays gray.
        let gray = rgb565(16, 32, 16);
        let (red, green, blue) = unpack565(&boost_rgb565_le(&gray, 150));
        assert!(red > 16 && blue > 16, "midtones must brighten");
        assert_eq!(red, blue, "gray must stay gray");
        assert!((i32::from(green) - 2 * i32::from(red)).abs() <= 1);
    }

    #[test]
    fn software_brightness_boost_preserves_saturation() {
        // An orange midtone must keep its channel ratios (hue/saturation)
        // instead of washing toward white: zero channels stay zero, and since
        // red5 == green6 encodes a green channel at half the red intensity,
        // that relationship must survive the boost within rounding error.
        let orange = rgb565(20, 20, 0);
        let (red, green, blue) = unpack565(&boost_rgb565_le(&orange, 200));
        assert_eq!(blue, 0, "zero channels must stay zero");
        assert!(red > 20, "boost must brighten the midtone");
        assert!(
            (i32::from(green) - i32::from(red)).abs() <= 2,
            "channel ratio drifted: red={red} green={green}"
        );
    }

    #[test]
    fn software_brightness_boost_at_100_is_identity() {
        let frame = [0x10, 0x84, 0x37, 0x29, 0xff, 0xff, 0x00, 0x00];
        assert_eq!(boost_rgb565_le(&frame, 100), frame);
    }

    struct CapturingDevice {
        frames: Arc<Mutex<Vec<u8>>>,
        frame_delay: Duration,
    }

    impl DisplayDevice for CapturingDevice {
        fn power_on(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn power_off(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()> {
            std::thread::sleep(self.frame_delay);
            self.frames.lock().unwrap().push(frame[0]);
            Ok(())
        }

        fn clear_cache(&mut self) {}
    }

    struct FrameCapturingDevice {
        frames: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl DisplayDevice for FrameCapturingDevice {
        fn power_on(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn power_off(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()> {
            self.frames.lock().unwrap().push(frame.to_vec());
            Ok(())
        }

        fn clear_cache(&mut self) {}
    }

    #[tokio::test]
    async fn worker_brightness_refreshes_the_current_frame_with_changed_bytes() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let runtime = BridgeRuntime::spawn(
            Box::new(FrameCapturingDevice {
                frames: captured.clone(),
            }),
            true,
            "brightness-worker-test",
            true,
        );
        let handle = runtime.handle();
        let pixel = rgb565(16, 32, 16);
        let source = pixel.repeat(FRAME_BYTES / pixel.len());

        handle
            .request_data(|reply| Command::Frame {
                data: source.clone(),
                reply,
            })
            .await
            .unwrap();
        handle
            .request_control(|reply| Command::Brightness {
                percent: 150,
                reply,
            })
            .await
            .unwrap();

        assert_eq!(handle.status().brightness, 150);
        runtime.shutdown(false).await.unwrap();

        let frames = captured.lock().unwrap();
        assert_eq!(frames.len(), 2, "frame plus brightness refresh expected");
        assert_eq!(frames[0], source);
        assert_ne!(
            frames[1], source,
            "worker must send transformed RGB565 bytes"
        );
        assert_eq!(frames[1], boost_rgb565_le(&source, 150));
    }

    #[tokio::test]
    async fn gif_repeats_in_order_until_explicitly_stopped() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let runtime = BridgeRuntime::spawn(
            Box::new(CapturingDevice {
                frames: captured.clone(),
                frame_delay: Duration::from_millis(12),
            }),
            true,
            "gif-loop-test",
            true,
        );
        let handle = runtime.handle();
        handle
            .request_control(|reply| Command::Brightness {
                percent: 100,
                reply,
            })
            .await
            .unwrap();
        handle
            .request_data(|reply| Command::Gif {
                frames: vec![
                    GifFrame {
                        data: vec![1, 0],
                        delay: Duration::from_millis(5),
                    },
                    GifFrame {
                        data: vec![2, 0],
                        delay: Duration::from_millis(5),
                    },
                ],
                reply,
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(75)).await;
        handle
            .request_control(|reply| Command::Stop { reply })
            .await
            .unwrap();
        runtime.shutdown(false).await.unwrap();

        let frames = captured.lock().unwrap();
        assert!(frames.len() >= 5, "captured only {frames:?}");
        assert!(
            frames
                .iter()
                .zip([1_u8, 2].iter().cycle())
                .all(|(actual, expected)| actual == expected)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn new_frame_replaces_a_late_gif_without_timing_out() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let runtime = BridgeRuntime::spawn(
            Box::new(CapturingDevice {
                frames: captured,
                frame_delay: Duration::from_millis(40),
            }),
            true,
            "gif-replace-test",
            true,
        );
        let handle = runtime.handle();
        handle
            .request_data(|reply| Command::Gif {
                frames: vec![
                    GifFrame {
                        data: vec![1, 0],
                        delay: Duration::from_millis(5),
                    },
                    GifFrame {
                        data: vec![2, 0],
                        delay: Duration::from_millis(5),
                    },
                ],
                reply,
            })
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(10)).await;
        tokio::time::timeout(
            Duration::from_millis(250),
            handle.request_data(|reply| Command::Frame {
                data: vec![9, 0],
                reply,
            }),
        )
        .await
        .expect("new frame was starved by GIF playback")
        .unwrap();
        assert_eq!(handle.status().job, Job::Still);
        runtime.shutdown(false).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn off_uses_the_priority_lane_when_the_frame_queue_is_full() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = BridgeRuntime::spawn(
            Box::new(TestDevice {
                events: events.clone(),
                frame_delay: Duration::from_millis(100),
                fail_frame: false,
            }),
            true,
            "priority-test",
            true,
        );
        let handle = runtime.handle();

        let first_handle = handle.clone();
        let first = tokio::spawn(async move {
            first_handle
                .request_data(|reply| Command::Frame {
                    data: vec![0; FRAME_BYTES],
                    reply,
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let mut queued = Vec::new();
        for _ in 0..COMMAND_QUEUE_CAPACITY {
            let queued_handle = handle.clone();
            queued.push(tokio::spawn(async move {
                queued_handle
                    .request_data(|reply| Command::Frame {
                        data: vec![0; FRAME_BYTES],
                        reply,
                    })
                    .await
            }));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;

        tokio::time::timeout(
            Duration::from_millis(250),
            handle.request_control(|reply| Command::Power { on: false, reply }),
        )
        .await
        .expect("off command was delayed behind frame data")
        .unwrap();

        first.await.unwrap().unwrap();
        for task in queued {
            task.abort();
        }
        runtime.shutdown(false).await.unwrap();

        let events = events.lock().unwrap();
        assert_eq!(events.first(), Some(&"frame"));
        assert_eq!(events.get(1), Some(&"off"));
    }

    #[tokio::test]
    async fn device_failures_are_exposed_by_status_until_a_device_command_recovers() {
        let runtime = BridgeRuntime::spawn(
            Box::new(TestDevice {
                fail_frame: true,
                ..TestDevice::default()
            }),
            true,
            "failure-test",
            true,
        );
        let handle = runtime.handle();

        let result = handle
            .request_data(|reply| Command::Frame {
                data: vec![0; FRAME_BYTES],
                reply,
            })
            .await;
        assert!(matches!(result, Err(BridgeRequestError::Device(_))));
        let failed = handle.status();
        assert!(!failed.ok);
        assert_eq!(failed.error.as_deref(), Some("serial write failed"));

        handle
            .request_control(|reply| Command::Power { on: true, reply })
            .await
            .unwrap();
        let recovered = handle.status();
        assert!(recovered.ok);
        assert!(recovered.error.is_none());
        runtime.shutdown(false).await.unwrap();
    }

    #[tokio::test]
    async fn image_requests_fail_fast_when_the_single_decoder_slot_is_busy() {
        let runtime = BridgeRuntime::spawn(
            Box::new(TestDevice::default()),
            true,
            "decode-limit-test",
            true,
        );
        let decode_slots = Arc::new(Semaphore::new(1));
        let _held = decode_slots.clone().acquire_owned().await.unwrap();
        let app = build_router_with_decode_slots(runtime.handle(), decode_slots);
        let boundary = "decode-limit-boundary";
        let request = Request::post("/api/image")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.png\"\r\nContent-Type: image/png\r\n\r\nx\r\n--{boundary}--\r\n"
            )))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        runtime.shutdown(false).await.unwrap();
    }
}
