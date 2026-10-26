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
Display On/Off and Stop disable the saved Spotify display mode. Changing
brightness does not disable it.

## Frames and images

- `POST /api/frame` accepts exactly 721,920 bytes: one 960×376 RGB565
  little-endian frame.
- `POST /api/image` accepts multipart form data with a `file` field containing
  PNG, JPEG, or GIF data. GIF playback repeats until stopped or replaced.

Uploads are decoded in memory and are not stored as source files.
An accepted frame or decoded image replaces and disables Spotify display mode.

## Spotify display (v0.2.6)

This integration requests only `user-read-currently-playing`. It reads playback
metadata and renders a display; it does not play audio or expose Spotify
playback-control endpoints. Send JSON POST bodies with
`Content-Type: application/json`.

| Method and path | Request / result |
| --- | --- |
| `GET /api/spotify/status` | Connection/display snapshot; never includes tokens or PKCE secrets. |
| `POST /api/spotify/auth/start` | `{ "client_id": "32-character hexadecimal Client ID" }`; returns `authorization_url` and `redirect_uri`. Replaces any pending sign-in attempt. |
| `POST /api/spotify/auth/complete` | `{ "callback_url": "http://127.0.0.1:17879/callback?code=...&state=..." }`; validates the pending attempt, exchanges the code, saves the connection with display disabled, and returns a snapshot. |
| `POST /api/spotify/mode` | `{ "enabled": true }` or `{ "enabled": false }`; enabling requires a connection and powers on the display. Disabling stops updates, not panel power. Returns a snapshot. |
| `POST /api/spotify/disconnect` | No fields required (`{}` is accepted); disables the mode, clears local credentials and cached track state, and returns a snapshot. Does not revoke authorization at Spotify. |
| `GET /api/spotify/preview.png` | Current server-rendered PNG with `Cache-Control: no-store`; fetching it does not enable the mode or trigger an API poll. |
| `GET /api/spotify/sample.png` | Fixed fictional sample PNG for web preview only; does not call Spotify or transmit to the panel. |

The redirect URI is fixed at `http://127.0.0.1:17879/callback`. No callback
listener is opened: after Spotify redirects, the user copies the browser's
complete returned URL into the UI. The pending PKCE attempt expires after ten
minutes and is lost when the service restarts. The URL contains a one-time code
and must not be logged or shared. No Client Secret is used. See
[`SPOTIFY.md`](SPOTIFY.md) for the complete setup and security boundary.

A disconnected snapshot has this shape:

```json
{
  "connected": false,
  "enabled": false,
  "track": null,
  "message": "Not connected",
  "error": null,
  "client_id": ""
}
```

When present, `track` contains `title`, `artist`, `album`, `duration_ms`,
`progress_ms`, `is_playing`, and `url`. The artwork URL and token values are not
part of this response. `connected` describes saved/last-known connection state,
not a newly validated Spotify request. Stopping updates can retain the last
track. `/api/status` reports job `spotify` when this mode is enabled, the display
is on, and the device worker is healthy.

Normal Spotify polling is approximately every 15 seconds while enabled. The
renderer waits about one second between cycles and estimates progress locally;
network, rendering, and serial transfer time add latency. Paused progress does
not advance. Empty playback, errors, and delayed retries remain explicit.
Closing the browser does not stop server polling.

The packaged service stores Client ID, refresh token, and enabled preference in
`/var/lib/asterctl-web/spotify.json` (file mode `0600`, state directory `0700`).
Enabled mode resumes after service restart when credentials and dependencies
are available. Display On/Off, Stop, or accepted manual frame/image commands
disable it persistently; brightness changes do not. These endpoints have the
same unauthenticated trusted-LAN boundary as the rest of the API.

If persistence fails while disabling Spotify, updates stop in memory and manual
display/Off commands still proceed. `/api/spotify/status.error` reports that
Spotify may resume after restart because the disabled preference was not saved.
Do not equate a successful Off command with successful state persistence.

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
