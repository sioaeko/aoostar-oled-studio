#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)"
PORT="${ASTERCTL_VERIFY_PORT:-18792}"
SERVER_PID=""
LOG_FILE=""
YTDLP_EXPECTED_SHA256="6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

verify_file_sha256() {
    local path="$1" expected="$2" label="$3" actual
    actual="$(sha256sum -- "$path" | awk '{print tolower($1)}')" || return 1
    [[ "$actual" == "$expected" ]] ||
        die "$label SHA256 mismatch: expected $expected, got $actual"
}

cleanup() {
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        kill -TERM "$SERVER_PID" >/dev/null 2>&1 || true
        wait "$SERVER_PID" >/dev/null 2>&1 || true
    fi
    [[ -z "$LOG_FILE" ]] || rm -f -- "$LOG_FILE"
}
trap cleanup EXIT INT TERM

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1024 || PORT > 65535)); then
    die "ASTERCTL_VERIFY_PORT must be an unprivileged TCP port"
fi
[[ "$(uname -m)" == "x86_64" ]] || die "this package requires an x86_64 Proxmox host"

cd "$SCRIPT_DIR"
for file in asterctl-web asterctl-web.service install-asterctl-web.sh PROXMOX-INSTALL.md \
    brightness-probe.py yt-dlp SHA256SUMS version.txt LICENSE-MIT LICENSE-APACHE LICENSE-YT-DLP; do
    [[ -f "$file" ]] || die "package file is missing: $file"
done

sha256sum -c SHA256SUMS
verify_file_sha256 yt-dlp "$YTDLP_EXPECTED_SHA256" "yt-dlp official release"
chmod 0755 asterctl-web yt-dlp install-asterctl-web.sh verify-package.sh brightness-probe.py
python3 -c "import ast; ast.parse(open('brightness-probe.py').read())" ||
    die "brightness-probe.py does not parse"
python3 brightness-probe.py --help | grep -Fq -- '--control-lines' ||
    die 'brightness-probe.py --help failed or lacks opt-in --control-lines'
if grep -Fq 'beyond doubt' brightness-probe.py ||
    grep -Fq 'cannot put the firmware into an unknown state' brightness-probe.py; then
    die 'brightness probe contains an unsupported safety or causality claim'
fi
grep -Fq 'systemctl disable --now asterctl-web' PROXMOX-INSTALL.md ||
    die 'guide does not disable automatic startup before the reboot probe'
grep -Fq 'systemctl enable --now asterctl-web' PROXMOX-INSTALL.md ||
    die 'guide does not restore automatic startup after the probe'
grep -Fq -- '--control-lines' PROXMOX-INSTALL.md ||
    die 'guide does not warn about the opt-in control-line probe'
[[ $(grep -Fc 'systemctl disable --now asterctl-web' PROXMOX-INSTALL.md) -ge 2 &&
    $(grep -Fc 'sudo reboot' PROXMOX-INSTALL.md) -ge 2 ]] ||
    die 'guide does not restore the boot-animation baseline before the control-line probe'
grep -Fq 'send_command_expect_ack' brightness-probe.py ||
    die 'brightness probe does not verify command acknowledgements'
grep -Fq 'send_frame_expect_ack' brightness-probe.py ||
    die 'brightness probe does not verify frame acknowledgements'
grep -Fq 'if args.control_lines:' brightness-probe.py ||
    die 'brightness probe control-line writes are not behind the opt-in flag'
if ! grep -Fq 'off_attempted = False' brightness-probe.py ||
    ! grep -Fq 'DISPLAY_ON_AFTER_OFF' brightness-probe.py ||
    ! grep -Fq 'termios.tcsetattr(fd, termios.TCSANOW, tty_attrs)' brightness-probe.py; then
    die 'brightness probe does not restore display-on and tty state during cleanup'
fi
grep -Fq 'set_control_state(fd, control_state)' brightness-probe.py ||
    die 'brightness probe does not restore the saved control-line state'

previous_stage_line=0
for marker in \
    S1_port_open_changed \
    S2_display_on_changed \
    S3_white_dimmer_than_boot_animation \
    S4_bars_dimmer_than_boot_animation \
    S5_display_off_blanked \
    S6_display_on_after_off_dimmer; do
    stage_line=$(grep -n -m1 -F "$marker" brightness-probe.py | cut -d: -f1)
    [[ -n "$stage_line" && "$stage_line" -gt "$previous_stage_line" ]] ||
        die "brightness probe stage is missing or out of order: $marker"
    previous_stage_line="$stage_line"
done
bash -n install-asterctl-web.sh
./install-asterctl-web.sh --help | grep -Fq -- '--device PATH' ||
    die "installer does not support explicit serial-device pinning"
if grep -Fq 'AOOSTAR USB 0416:90a1 is not visible' install-asterctl-web.sh; then
    die "installer still contains the obsolete mandatory udev VID/PID gate"
fi

magic="$(od -An -tx1 -N4 asterctl-web | tr -d '[:space:]')"
[[ "$magic" == "7f454c46" ]] || die "asterctl-web is not an ELF binary"
./asterctl-web --version
[[ "$(./yt-dlp --version)" == "2026.07.04" ]] || die "bundled yt-dlp version is wrong"

if command -v curl >/dev/null 2>&1; then
    http_get() { curl --fail --silent --show-error --max-time 4 "$1"; }
elif command -v wget >/dev/null 2>&1; then
    http_get() { wget --quiet --timeout=4 --output-document=- "$1"; }
else
    die "curl or wget is required for the HTTP smoke test"
fi

LOG_FILE="$(mktemp)"
./asterctl-web --simulate --bind "127.0.0.1:$PORT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

status_json=""
for _attempt in {1..20}; do
    status_json="$(http_get "http://127.0.0.1:$PORT/api/status" 2>/dev/null || true)"
    if printf '%s' "$status_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
        break
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        sed -n '1,120p' "$LOG_FILE" >&2
        die "simulation server exited before becoming ready"
    fi
    sleep 0.25
done

printf '%s' "$status_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' ||
    die "simulation status did not become healthy"
printf '%s' "$status_json" | grep -Eq '"simulated"[[:space:]]*:[[:space:]]*true' ||
    die "verification server is not in simulation mode"

html="$(http_get "http://127.0.0.1:$PORT/")"
printf '%s' "$html" | grep -q 'id="root"' || die "embedded OLED Studio HTML is missing"
asset_path="$(printf '%s' "$html" | grep -oE '/assets/[^"[:space:]]+\.js' | head -n 1)"
[[ -n "$asset_path" ]] || die "embedded JavaScript asset was not referenced"
bundle="$(http_get "http://127.0.0.1:$PORT$asset_path")"
printf '%s' "$bundle" | grep -q 'api\.giphy\.com' || die "GIPHY integration is missing from the bundle"
printf '%s' "$bundle" | grep -q 'customer_id' || die "GIPHY anonymous client ID support is missing"
printf '%s' "$bundle" | grep -q '/api/youtube' || die "YouTube URL support is missing from the bundle"
telemetry_json="$(http_get "http://127.0.0.1:$PORT/api/telemetry")"
printf '%s' "$telemetry_json" | grep -Eq '"hostname"[[:space:]]*:' || die "live telemetry API is missing"

printf 'Package verification passed.\n'
printf '  binary:  ELF64 x86_64\n'
printf '  runtime: simulation API healthy on 127.0.0.1:%s\n' "$PORT"
printf '  UI:      embedded OLED Studio with GIPHY and YouTube support\n'
printf '  helper:  yt-dlp 2026.07.04 official release checksum verified\n'
printf '  probe:   syntax, help CLI, opt-in control lines, and service restore guide verified\n'
printf '  install: explicit/legacy serial path pinning available\n'
printf 'No physical OLED was accessed. Continue with the installer dry run in PROXMOX-INSTALL.md.\n'
