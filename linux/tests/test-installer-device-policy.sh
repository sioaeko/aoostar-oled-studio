#!/usr/bin/env bash
# shellcheck disable=SC2016 # Tests intentionally grep literal shell expressions.
# SPDX-License-Identifier: MIT OR Apache-2.0

set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)"
INSTALLER="$(readlink -f "$TEST_DIR/../install-asterctl-web.sh")"
VERIFIER="$(readlink -f "$TEST_DIR/../verify-asterctl-web-package.sh")"
PROBE_TEST="$(readlink -f "$TEST_DIR/test-brightness-probe-device-policy.py")"
PYTHON="${PYTHON:-python3}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT INT TERM

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

# Load definitions without executing the root/systemd main program.
# shellcheck disable=SC1090
source <(awk '/^for command_name in / { exit } { print }' "$INSTALLER")
TEST_UNIT_SOURCE="$(readlink -f "$TEST_DIR/../asterctl-web.service")"

for allowed in \
    /dev/ttyACM0 \
    /dev/ttyUSB12 \
    /dev/serial/by-id/usb-AOOSTAR_0416_90a1-if00; do
    serial_device_path_allowed "$allowed" || fail "allowed path was rejected: $allowed"
done

for rejected in \
    ttyACM0 \
    /dev/null \
    /tmp/ttyACM0 \
    '/dev/ttyACM0 --simulate' \
    '/dev/serial/by-id/../../null'; do
    if serial_device_path_allowed "$rejected"; then
        fail "unsafe path was accepted: $rejected"
    fi
done

expected_ytdlp_sha256='6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae'
[[ "$YTDLP_EXPECTED_SHA256" == "$expected_ytdlp_sha256" ]] ||
    fail 'installer does not pin the approved official yt-dlp checksum'
printf 'not the official yt-dlp binary\n' >"$TEMP_DIR/fake-yt-dlp"
if verify_ytdlp_hash "$TEMP_DIR/fake-yt-dlp" >/dev/null 2>&1; then
    fail 'installer checksum policy accepted a non-official yt-dlp binary'
fi
fake_hash="$(sha256sum "$TEMP_DIR/fake-yt-dlp" | awk '{print $1}')"
verify_file_sha256 "$TEMP_DIR/fake-yt-dlp" "$fake_hash" test-helper ||
    fail 'generic checksum helper rejected a matching digest'

installer_hash_line="$(grep -n -m1 'verify_ytdlp_hash "$YTDLP_SOURCE"' "$INSTALLER" | cut -d: -f1)"
installer_exec_line="$(grep -n -m1 '\$YTDLP_SOURCE" --version' "$INSTALLER" | cut -d: -f1)"
[[ -n "$installer_hash_line" && -n "$installer_exec_line" &&
    "$installer_hash_line" -lt "$installer_exec_line" ]] ||
    fail 'installer does not verify yt-dlp before executing it'
verifier_hash_line="$(grep -n -m1 '^verify_file_sha256 yt-dlp ' "$VERIFIER" | cut -d: -f1)"
verifier_exec_line="$(grep -n -m1 '^\[\[ "\$(\./yt-dlp --version)' "$VERIFIER" | cut -d: -f1)"
[[ -n "$verifier_hash_line" && -n "$verifier_exec_line" &&
    "$verifier_hash_line" -lt "$verifier_exec_line" ]] ||
    fail 'package verifier does not verify yt-dlp before executing it'

rendered="$TEMP_DIR/asterctl-web.service"
render_service_unit "$TEST_UNIT_SOURCE" "$rendered" /dev/ttyACM0 192.168.50.2
expected='ExecStart=/usr/local/bin/asterctl-web --bind 192.168.50.2:8787 --device /dev/ttyACM0'
[[ "$(grep -c '^[[:space:]]*ExecStart[[:space:]]*=' "$rendered")" == 1 ]] ||
    fail 'rendered unit does not contain exactly one ExecStart'
grep -Fxq -- "$expected" "$rendered" || fail 'rendered unit did not pin the selected path'
validate_unit_source_policy "$rendered"

unsafe_rendered="$TEMP_DIR/unsafe.service"
render_service_unit "$TEST_UNIT_SOURCE" "$unsafe_rendered" '/dev/ttyACM0 --simulate' 192.168.50.2
if validate_unit_source_policy "$unsafe_rendered" >/dev/null 2>&1; then
    fail 'unit policy accepted an injected device argument'
fi

for allowed_ip in 10.0.0.1 172.16.1.2 172.31.255.254 192.168.50.2; do
    private_ipv4 "$allowed_ip" || fail "private IPv4 was rejected: $allowed_ip"
done
for rejected_ip in 0.0.0.0 8.8.8.8 172.32.0.1 192.169.1.1 10.999.0.1; do
    if private_ipv4 "$rejected_ip"; then
        fail "non-private or invalid IPv4 was accepted: $rejected_ip"
    fi
done

help_text="$(bash "$INSTALLER" --help)"
printf '%s\n' "$help_text" | grep -Fq -- '--device PATH' ||
    fail 'installer help does not document --device'
printf '%s\n' "$help_text" | grep -Fq -- '--bind-address IPv4' ||
    fail 'installer help does not document --bind-address'
if grep -Fq 'AOOSTAR USB 0416:90a1 is not visible' "$INSTALLER"; then
    fail 'obsolete mandatory USB VID/PID gate is still present'
fi

"$PYTHON" "$PROBE_TEST" || fail 'brightness-probe device policy tests failed'

printf 'Installer, yt-dlp, and brightness-probe device policy tests passed.\n'
