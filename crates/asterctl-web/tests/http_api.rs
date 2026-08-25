use std::sync::{Arc, Mutex};
use std::time::Duration;

use asterctl_lcd::FRAME_BYTES;
use asterctl_web::{BridgeRuntime, DisplayDevice, Job, build_router};
use axum::body::Body;
use http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame, Rgba, RgbaImage};
use serde::Deserialize;
use tower::ServiceExt;

#[derive(Default)]
struct DeviceState {
    display_on: bool,
    frame_lengths: Vec<usize>,
    cache_clears: usize,
}

struct RecordingDevice(Arc<Mutex<DeviceState>>);

impl DisplayDevice for RecordingDevice {
    fn power_on(&mut self) -> anyhow::Result<()> {
        self.0.lock().unwrap().display_on = true;
        Ok(())
    }

    fn power_off(&mut self) -> anyhow::Result<()> {
        self.0.lock().unwrap().display_on = false;
        Ok(())
    }

    fn send_rgb565_le(&mut self, frame: &[u8]) -> anyhow::Result<()> {
        self.0.lock().unwrap().frame_lengths.push(frame.len());
        Ok(())
    }

    fn clear_cache(&mut self) {
        self.0.lock().unwrap().cache_clears += 1;
    }
}

#[derive(Debug, Deserialize)]
struct Status {
    ok: bool,
    simulated: bool,
    display_on: bool,
    brightness: u8,
    job: Job,
    device: String,
    uptime_sec: u64,
}

async fn json_status(response: axum::response::Response) -> Status {
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn test_runtime() -> (BridgeRuntime, Arc<Mutex<DeviceState>>) {
    let state = Arc::new(Mutex::new(DeviceState {
        display_on: true,
        ..DeviceState::default()
    }));
    let runtime = BridgeRuntime::spawn(
        Box::new(RecordingDevice(state.clone())),
        true,
        "test-display",
        true,
    );
    (runtime, state)
}

fn animated_gif() -> Vec<u8> {
    let mut encoded = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut encoded);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
            encoder
                .encode_frame(Frame::from_parts(
                    RgbaImage::from_pixel(2, 2, Rgba(color)),
                    0,
                    0,
                    Delay::from_numer_denom_ms(80, 1),
                ))
                .unwrap();
        }
    }
    encoded
}

fn multipart_gif_request() -> Request<Body> {
    let boundary = "asterctl-web-test-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.gif\"\r\nContent-Type: image/gif\r\n\r\n"
    )
    .into_bytes();
    body.extend(animated_gif());
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());

    Request::post("/api/image")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn status_and_embedded_ui_match_the_frontend_contract() {
    let (runtime, _) = test_runtime();
    let app = build_router(runtime.handle());

    let status = app
        .clone()
        .oneshot(Request::get("/api/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = json_status(status).await;
    assert!(status.ok);
    assert!(status.simulated);
    assert!(status.display_on);
    assert_eq!(status.brightness, 100);
    assert_eq!(status.job, Job::Idle);
    assert_eq!(status.device, "test-display");
    assert!(status.uptime_sec < 5);

    let boosted = app
        .clone()
        .oneshot(
            Request::post("/api/display/brightness")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"percent":180}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_status(boosted).await.brightness, 180);

    let invalid_boost = app
        .clone()
        .oneshot(
            Request::post("/api/display/brightness")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"percent":90}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_boost.status(), StatusCode::BAD_REQUEST);

    let telemetry = app
        .clone()
        .oneshot(Request::get("/api/telemetry").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(telemetry.status(), StatusCode::OK);
    let telemetry: serde_json::Value =
        serde_json::from_slice(&telemetry.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(telemetry["cpu"].is_number());
    assert!(telemetry["load_avg"].is_array());
    assert!(telemetry["hostname"].is_string());

    let rejected_video = app
        .clone()
        .oneshot(
            Request::post("/api/youtube")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"url":"https://example.com/video"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected_video.status(), StatusCode::BAD_REQUEST);

    let index = app
        .clone()
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert!(
        index
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let html = index.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&html).contains("<div id=\"root\"></div>"));

    let fonts = app
        .clone()
        .oneshot(
            Request::get("/fonts/fonts.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fonts.status(), StatusCode::OK);
    assert_eq!(
        fonts.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );
    assert!(
        fonts
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/css")
    );
    let css = fonts.into_body().collect().await.unwrap().to_bytes();
    assert!(!String::from_utf8_lossy(&css).contains("fonts.googleapis.com"));

    let missing_asset = app
        .oneshot(
            Request::get("/assets/index-does-not-exist.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        missing_asset.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );

    runtime.shutdown(false).await.unwrap();
}

#[tokio::test]
async fn exact_raw_frame_is_serialized_through_the_worker() {
    let (runtime, device) = test_runtime();
    let app = build_router(runtime.handle());

    let invalid = app
        .clone()
        .oneshot(
            Request::post("/api/frame")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(vec![0_u8; 10]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );

    let response = app
        .oneshot(
            Request::post("/api/frame")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(vec![0_u8; FRAME_BYTES]))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = json_status(response).await;
    assert_eq!(status.job, Job::Still);
    assert_eq!(device.lock().unwrap().frame_lengths, vec![FRAME_BYTES]);

    runtime.shutdown(false).await.unwrap();
    assert!(device.lock().unwrap().display_on);
}

#[tokio::test]
async fn power_command_stops_the_active_job_and_shutdown_policy_is_explicit() {
    let (runtime, device) = test_runtime();
    let app = build_router(runtime.handle());

    let frame = app
        .clone()
        .oneshot(
            Request::post("/api/frame")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(vec![0_u8; FRAME_BYTES]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_status(frame).await.job, Job::Still);

    let off = app
        .oneshot(
            Request::post("/api/display/off")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = json_status(off).await;
    assert!(!status.display_on);
    assert_eq!(status.job, Job::Idle);

    runtime.shutdown(true).await.unwrap();
    assert!(!device.lock().unwrap().display_on);
}

#[tokio::test]
async fn gif_is_interruptible_and_serialized_with_power_and_stop_commands() {
    let (runtime, device) = test_runtime();
    let app = build_router(runtime.handle());

    let started = app.clone().oneshot(multipart_gif_request()).await.unwrap();
    assert_eq!(json_status(started).await.job, Job::Gif);
    assert_eq!(device.lock().unwrap().cache_clears, 1);

    for _ in 0..20 {
        if !device.lock().unwrap().frame_lengths.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(device.lock().unwrap().frame_lengths[0], FRAME_BYTES);

    let stopped = app
        .clone()
        .oneshot(Request::post("/api/stop").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(json_status(stopped).await.job, Job::Idle);
    let stopped_at = device.lock().unwrap().frame_lengths.len();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(device.lock().unwrap().frame_lengths.len(), stopped_at);

    let restarted = app.clone().oneshot(multipart_gif_request()).await.unwrap();
    assert_eq!(json_status(restarted).await.job, Job::Gif);
    assert_eq!(device.lock().unwrap().cache_clears, 2);

    let off = app
        .oneshot(
            Request::post("/api/display/off")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let off = json_status(off).await;
    assert_eq!(off.job, Job::Idle);
    assert!(!off.display_on);

    runtime.shutdown(false).await.unwrap();
}

#[tokio::test]
async fn cors_allows_same_origin_and_vite_but_rejects_untrusted_origins() {
    let (runtime, device) = test_runtime();
    let app = build_router(runtime.handle());

    let preflight = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/frame")
                .header(header::ORIGIN, "http://localhost:5173")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::OK);
    assert_eq!(
        preflight
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "http://localhost:5173"
    );

    let denied = app
        .clone()
        .oneshot(
            Request::post("/api/display/off")
                .header(header::HOST, "display.local:8787")
                .header(header::ORIGIN, "https://untrusted.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert!(device.lock().unwrap().display_on);

    let same_origin = app
        .oneshot(
            Request::post("/api/display/off")
                .header(header::HOST, "display.local:8787")
                .header(header::ORIGIN, "http://display.local:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(!json_status(same_origin).await.display_on);

    runtime.shutdown(false).await.unwrap();
}
