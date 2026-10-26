# AOOSTAR OLED Studio

A self-hosted web controller for the 960×376 front display in the AOOSTAR
WTR MAX and compatible systems. One Rust service hosts the OLED Studio UI,
collects Linux telemetry, and serializes every display command through a single
device worker.

![AOOSTAR OLED Studio web UI](docs/img/oled-studio-web-ui.png)

## Features

- Live CPU, RAM, temperature, network, clock, hostname, and uptime dashboard
- Read-only Spotify now-playing display laid out like Nocturne's player
  (rounded artwork, title, artist, timeline, artwork-colored mesh gradient);
  no panel playback controls
- Source-timed, continuously looping GIF playback
- Optional GIPHY search with a browser-local API key
- Local video and YouTube playback with selectable duration and looping
- Still images, styled text, rotation, fit modes, and a dedicated Off mode
- 100–200% RGB565 midtone boost without interrupting active playback
- Embedded frontend: the production service needs no separate web server
- Proxmox migration installer with dry-run, backup, rollback, and legacy-service replacement

### Native 960×376 panel render

![OLED Studio Stats panel rendered at the device's native resolution](docs/img/oled-studio-panel-render.png)

![Spotify now-playing panel with fictional sample artwork](docs/img/oled-studio-spotify-panel.png)

## Proxmox installation

Download and verify a release ZIP on the Proxmox host, then run a no-change
preflight before installing:

```bash
sha256sum -c aoostar-oled-studio-proxmox-x86_64.zip.sha256
unzip aoostar-oled-studio-proxmox-x86_64.zip
cd aoostar-oled-studio-proxmox-x86_64
./verify-package.sh

sudo bash install-asterctl-web.sh --dry-run --purge-legacy \
  --device /dev/ttyACM0 --bind-address 192.168.1.10
sudo bash install-asterctl-web.sh --yes --purge-legacy \
  --device /dev/ttyACM0 --bind-address 192.168.1.10
```

If the host has more than one private IPv4 address (for example a LAN address
and an internal VM bridge such as `10.0.1.1`), the installer stops and requires
`--bind-address`; pick the LAN address you browse from.

Open `http://192.168.1.10:8787` from another computer on the same trusted LAN.
The API has no login, so do not forward port 8787 to the internet. See
[`linux/PROXMOX-INSTALL.md`](linux/PROXMOX-INSTALL.md) for migration, firewall,
rollback, and brightness-probe details.

### Spotify setup (v0.2.7)

Connect your own Spotify app's Client ID using the loopback PKCE sign-in flow,
then select **Show on panel** in the Spotify tab. The service updates the screen
after the browser closes and saves the enabled mode for restart. Audio and
playback controls stay on your existing Spotify device. The local sample is a
web-only preview and is not sent to the panel.

The panel follows the layout of Nocturne's now-playing screen without its
controls, scaled to 960×376: 252 px artwork with rounded corners and a soft
shadow, the title in Inter 580, the artist in 60% white, a pill timeline with
elapsed and total time, and a four-point gradient sampled from the artwork.
Hangul, kana and Hanja fall back to Noto Sans KR. Long titles are truncated with
an ellipsis instead of scrolling. With nothing playing it shows "Not Playing"
and the connection state. Nocturne is a visual reference only; no Nocturne code
or assets are included.

Spotify credentials are kept in `/var/lib/asterctl-web` through systemd
`StateDirectory`, which the 0.2.7 installer validates as part of the unit policy.

See [`docs/SPOTIFY.md`](docs/SPOTIFY.md) for account setup, persistent credentials,
LAN security, and troubleshooting. Real-account authorization and physical-panel
output remain unverified; a sample preview is not proof of either.

## Development

Build the embedded frontend first, then run the Rust service in simulation:

```bash
cd oled-studio/source
bun install --frozen-lockfile
bun test
bun run build
cd ../..

cargo test --workspace
cargo run -p asterctl-web --release -- --simulate
```

Open <http://127.0.0.1:8787>. For frontend-only work, run `bun run dev` from
`oled-studio/source`; the UI automatically uses clearly labelled local
simulation data when no bridge URL is configured.

The frontend contract is documented in [`docs/API.md`](docs/API.md).

To assemble the Proxmox package, first fetch the pinned official Linux
`yt-dlp` helper and then run the package builder:

```powershell
pwsh scripts/Fetch-YtDlp.ps1
pwsh linux/New-ProxmoxPackage.ps1
pwsh linux/Test-ProxmoxPackage.ps1
```

## Brightness limitation

Brightness boost transforms RGB565 midtones in software. It can increase the
average perceived brightness of dark content, but it cannot raise the panel's
physical backlight or make an already-white pixel brighter.

## Project origin

OLED Studio, the web bridge, media pipeline, Proxmox migration tooling, and
packaging in this repository are maintained as an independent project. The
low-level `asterctl-lcd` protocol implementation is derived from
[`zehnm/aoostar-rs`](https://github.com/zehnm/aoostar-rs) and retains its
original copyright and dual MIT/Apache-2.0 licensing. See [`NOTICE.md`](NOTICE.md).

AOOSTAR is a trademark of its respective owner. This community project is not
an official AOOSTAR product.

## License

Unless a file states otherwise, the source is available under either the
[MIT License](LICENSE-MIT) or [Apache License 2.0](LICENSE-APACHE).
