# AOOSTAR OLED Studio

AOOSTAR OLED Studio is the web interface for the self-hosted AOOSTAR WTR MAX
front-display controller. The complete product consists of this React app and
the repository's `asterctl-web` Rust service. Production builds are embedded in
the service, so the UI, Linux telemetry, media preparation, and display-control
API are served from one process and one origin.

The target panel is a 3.5-inch 960×376 RGB LCD connected through its internal
USB UART interface. The OEM ecosystem calls it an OLED display, which is why
the project retains the OLED Studio name.

## Features

- Live Linux host stats for CPU, memory, temperature, network, clock, hostname,
  uptime, and load
- Source-timed looping GIF playback, including optional GIPHY search
- Local video and YouTube playback with duration and loop controls
- Still images with contain, cover, and stretch fit modes
- Styled static or scrolling text
- Dedicated display Off mode and display power controls
- 100–200% RGB565 midtone boost with matching browser preview
- Clearly labelled in-browser simulation for frontend development
- Dark and light interface themes with locally bundled fonts

## Run the complete application

Build the frontend before compiling the Rust service because `asterctl-web`
embeds `../dist` at compile time:

```bash
cd oled-studio/source
bun install --frozen-lockfile
bun test
bun run build
cd ../..

cargo run -p asterctl-web --release -- --simulate
```

Open <http://127.0.0.1:8787>. The `--simulate` flag exercises the complete HTTP
stack without opening a serial device. On a WTR MAX host, omit `--simulate` and
optionally select the panel explicitly:

```bash
cargo run -p asterctl-web --release -- --device /dev/ttyACM0
```

For a Proxmox installation, release packaging, rollback, and private-LAN
guidance, see [`../../linux/PROXMOX-INSTALL.md`](../../linux/PROXMOX-INSTALL.md).
The control API has no authentication and must not be exposed directly to the
public internet.

## Frontend development

This package uses Bun 1.3.13, React 19, TypeScript, Vite, and Tailwind CSS.

```bash
bun install --frozen-lockfile
bun test
bun run dev
```

Vite serves the development UI at <http://127.0.0.1:5173>. With no service URL
configured, display actions and telemetry are simulated locally and marked as
simulated. To exercise real API calls, run `asterctl-web` and enter its URL in
the Bridge connection field.

Build with:

```bash
bun run build
```

Vite writes the production bundle to `../dist`. Commit source and rebuilt
bundle changes together because the Rust service embeds that directory.

## Media integrations

### GIPHY

The GIF tab supports local files without an account. Search requires a GIPHY
Web API key, entered once in the UI. The key and anonymous analytics identifier
remain in that browser's local storage. Search, media downloads, and required
analytics requests go directly from the browser to GIPHY; the key is not sent
to `asterctl-web`.

### YouTube

The Video tab accepts local files and individual YouTube URLs. For YouTube,
`asterctl-web` validates the URL and uses the repository's pinned `yt-dlp`
helper to prepare one temporary video. The browser reads the same-origin range
stream and sends extracted RGB565 frames through the normal frame endpoint.
The temporary file is removed when released, replaced, or the service stops.

## Architecture

- `src/lib/oled.ts` contains the 960×376 canvas pipeline, RGB565 little-endian
  conversion, media loaders, service client, and browser simulator.
- `src/lib/giphy.ts` implements GIPHY search, download limits, and analytics.
- `src/components/OledPage.tsx` coordinates the six content modes, preview,
  service connection, power, brightness, and activity log.
- `src/components/OledPanel.tsx` renders the scaled front-panel preview.
- `src/hooks/useTelemetry.ts` polls live host telemetry and provides the local
  development preview fallback.
- `../../crates/asterctl-web` serves the embedded UI and HTTP API and owns the
  single display worker.
- `../../crates/asterctl-lcd` implements the USB UART display protocol.

The HTTP contract is documented in [`../../docs/API.md`](../../docs/API.md).

## Display limits

- A full frame is exactly 960×376×2 bytes (721,920 bytes), little-endian
  RGB565. High-change animation and video cadence is limited by the serial
  link; it is not a conventional high-frame-rate display path.
- Brightness is a software transformation of RGB565 midtones. It does not
  control the physical backlight or increase the luminance of an already-white
  pixel.
- The service decodes uploads and prepares YouTube media in runtime storage. It
  does not keep uploaded source images as a persistent media library.

## License

Unless a file states otherwise, this project is available under either the
[MIT License](../../LICENSE-MIT) or
[Apache License 2.0](../../LICENSE-APACHE). Bundled fonts retain their SIL Open
Font License files under `public/fonts/licenses`.
