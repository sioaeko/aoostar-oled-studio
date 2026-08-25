# asterctl-web

`asterctl-web` embeds the production `oled-studio/dist` build and serves it together with a small HTTP API that owns the AOOSTAR LCD serial connection. It reuses `asterctl-lcd`; the display protocol is not duplicated in the web server.

## Run

Build with Rust 1.88 or newer. Linux builds of `serialport` also require `pkg-config` and `libudev-dev`.

```shell
cargo run --release -p asterctl-web -- --simulate
cargo run --release -p asterctl-web -- --bind 192.168.1.10:8787 --device /dev/ttyACM0
```

The default bind address is `127.0.0.1:8787`. Binding to a LAN address exposes display power and frame upload controls without authentication; use a trusted network or an authenticated TLS reverse proxy.

Options:

- `--bind 127.0.0.1:8787`: HTTP listen address.
- `--device /dev/ttyACM0` or `--device COM3`: explicit serial port.
- `--usb 0416:90a1`: USB VID:PID lookup. The AOOSTAR ID is used by default.
- `--simulate`: use `asterctl-lcd`'s simulated serial device and report `simulated: true`.
- `--write-only`: skip the LCD initialization response check.
- `--off-on-exit`: switch the display off during a clean shutdown. Without this option, shutdown leaves its current power state unchanged.

### systemd

The repository includes `linux/asterctl-web.service`. It is intended for a
headless Proxmox/Linux host: it runs as a dedicated `aoostar` user, accesses
the display's serial character device through the `dialout` group, and listens
on one verified RFC1918 address at port 8787 so a different computer on that LAN
can open the UI. The migration installer pins the verified legacy serial path in the
installed unit, so udev VID/PID metadata is not a runtime requirement:

#### Replace an existing aoostar-rs installation

Use the migration installer when `aoostar-rs`, `lcd-off.service`, or an older
OLED Studio bridge already starts automatically. The first command is a
read-only audit; the second performs the replacement:

```shell
sudo bash linux/install-asterctl-web.sh --dry-run --purge-legacy
sudo bash linux/install-asterctl-web.sh --yes --purge-legacy
```

In an extracted release archive, the script and service file are beside the
binaries, so use `sudo bash ./install-asterctl-web.sh ...` instead. The installer:

- records active and enabled states before changing anything;
- stops, disables, backs up, and removes manually installed units whose
  effective `ExecStart` confirms legacy `asterctl` or `oled-bridge` usage;
  package/vendor units are preserved but masked against boot-time reactivation
  (unit names alone are not treated as proof);
- with the documented `--purge-legacy` option, also archives manually installed
  legacy CLI/bridge binaries and `aster-sysinfo`; omit this option if another
  application still consumes the non-conflicting sysinfo sensor files;
- preserves package-managed files and all existing `cfg`, fonts, and source
  directories;
- refuses to kill unknown processes, take port 8787 or the OLED serial device
  from an unrelated owner, continue without a verified serial path, or silently
  remove cron/`rc.local`/user-service startup entries;
- installs the new binary, bundled `yt-dlp`, and a unit pinned with `--device`
  and one private `--bind` address atomically, then
  verifies real-hardware mode, the reported device path, actual serial-device
  ownership, live host telemetry, the UI/API, a stable service PID, and the
  selected private-address listener;
- automatically restores the old files and their separate active/enabled states
  if any installation or verification step fails.

Successful migration prints its root-only backup directory and an exact rollback
command. Starting the new service initializes and powers on the OLED. Non-systemd
autostart entries in cron, `rc.local`, or a user service are reported as blockers
and must be migrated explicitly rather than being silently deleted.

#### Fresh manual installation

On a host without an earlier installation, the equivalent manual commands are:

```shell
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aoostar
sudo usermod --append --groups dialout aoostar
sudo install -m 0755 target/release/asterctl-web /usr/local/bin/asterctl-web
sudo install -m 0644 linux/asterctl-web.service /etc/systemd/system/asterctl-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now asterctl-web.service
```

Open `http://<PROXMOX-IP>:8787` from another computer. If the Proxmox datacenter,
node, or guest firewall is enabled, allow inbound TCP port 8787 from the trusted
LAN. The service has no login, so do not forward this port from the internet.
For remote/untrusted access, put an authenticated TLS reverse proxy or VPN in
front. A reverse proxy must preserve the original `Host` header so same-origin
browser requests pass the bridge's Origin check.

On a Proxmox node, use its management/LAN address (usually the address assigned
to `vmbr0`). These commands show the available addresses and confirm both the
service and listener before testing from another PC:

```shell
ip -o -4 addr show scope global
sudo systemctl status asterctl-web --no-pager
sudo ss -lntp | grep ':8787'
curl http://<SELECTED-PRIVATE-IP>:8787/api/status
```

The listener should show only the selected private IPv4, never `0.0.0.0:8787`
or a public address. If installed inside an LXC or
VM rather than directly on the Proxmox node, use that guest's IP address and
make the OLED serial character device available to the guest.

The migration installer first tries the USB UART identity and then a path
explicitly configured in a confirmed legacy unit. If neither is visible, use
the same option for both the audit and installation, for example
`--device /dev/ttyACM0`. A `/dev/serial/by-id/...` path is also accepted and is
preferable when the host exposes one.

## API

- `GET /api/status`
- `GET /api/telemetry`
- `POST /api/display/on`
- `POST /api/display/off`
- `POST /api/display/brightness` with JSON `{ "percent": 100..200 }` for an RGB565 midtone boost designed to largely preserve hue and saturation (100% default; no physical backlight control).
- `POST /api/frame` with `Content-Type: application/octet-stream` and exactly `960 * 376 * 2` RGB565 little-endian bytes.
- `POST /api/image` as multipart form data with a `file` field containing PNG, JPEG, or GIF.
- `POST /api/youtube` with JSON `{ "url": "https://youtu.be/..." }`, followed by the returned same-origin range-capable video URL.
- `POST /api/youtube/release` with the returned token.
- `POST /api/stop`

All API responses are JSON. Content and power commands interrupt a running GIF before they execute; brightness changes refresh the current frame without stopping the loop. GIFs repeat every source frame in order, with a 30 ms safety floor, until stopped or superseded. If UART writes take longer than the source delay, playback slows down instead of skipping frames. Blocking serial writes are serialized on one dedicated worker thread.

Request bodies are limited to 32 MiB, and only one image decode/upload job is accepted at a time. Image decoders are limited to 8192 pixels per dimension and 64 MiB per decoder allocation. GIFs are additionally limited to 90 frames and 32 Mi total decoded/stored pixels (about 64 MiB of stored RGB565 frame data). Display-off, display-on, and stop commands use a priority control lane so a full frame queue cannot reject them. Cross-origin requests are rejected except for the Vite development origins `http://127.0.0.1:5173` and `http://localhost:5173`; production uses the embedded UI from the same origin.

## Verify

```shell
cargo fmt --all -- --check
cargo test -p asterctl-lcd -p asterctl-web
cargo clippy -p asterctl-lcd -p asterctl-web --all-targets -- -D warnings
```
