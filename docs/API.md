# HTTP API

The embedded OLED Studio frontend and `asterctl-web` use the same origin in
production. The API has no authentication and is intended only for a trusted
private LAN.

## Status and telemetry

- `GET /api/status` returns worker health, display power, software brightness,
  active job, simulation state, device path, uptime, and the most recent error.
- `GET /api/telemetry` returns the Linux host values used by the Stats panel.

## Display control

- `POST /api/display/on`
- `POST /api/display/off`
- `POST /api/display/brightness` with JSON `{ "percent": 100..200 }`
- `POST /api/stop`

Brightness is an RGB565 midtone transformation, not physical backlight control.

## Frames and images

- `POST /api/frame` accepts exactly 721,920 bytes: one 960×376 RGB565
  little-endian frame.
- `POST /api/image` accepts multipart form data with a `file` field containing
  PNG, JPEG, or GIF data. GIF playback repeats until stopped or replaced.

Uploads are decoded in memory and are not stored as source files.

## YouTube preparation

- `POST /api/youtube` with JSON `{ "url": "https://..." }` prepares a
  validated YouTube URL with the pinned `yt-dlp` helper and returns a token,
  title, and same-origin stream URL.
- `GET /api/youtube/video/{token}` serves the current prepared video and
  supports HTTP byte ranges.
- `POST /api/youtube/release` with JSON `{ "token": "..." }` deletes the
  prepared runtime file.

Only HTTPS YouTube, youtu.be, and youtube-nocookie hostnames are accepted.

## Browser-origin policy

Production UI requests are same-origin. Development requests from
`http://127.0.0.1:5173` and `http://localhost:5173` are allowed. Origin checks
reduce accidental cross-origin browser access but are not authentication; use a
firewall or authenticated proxy on an untrusted network.
