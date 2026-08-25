#!/usr/bin/env python3
"""Causally ordered AOOSTAR brightness probe.

Run after ``systemctl disable --now asterctl-web`` and reboot, while the
controller animation is visible. The normal path matches the service:
open tty -> DISPLAY_ON -> frame. Every documented ON/OFF/image request must
return ASCII ``A``. No undocumented serial bytes are sent.

``--control-lines`` explicitly opts into DTR/RTS changes, which may reset or
disconnect USB. The TIOCMGET snapshot is restored in finally.
"""
import argparse
import array
import errno
import fcntl
import os
import re
import select
import stat
import subprocess
import sys
import termios
import time

MAGIC = b"\xaa\x55\xaa\x55"
DISPLAY_ON = MAGIC + b"\x0b\x00\x00\x00"
DISPLAY_OFF = MAGIC + b"\x0a\x00\x00\x00"
IMG_START = MAGIC + b"\x05\x00\x00\x00" + b"\x04\x00\x0f\x2f\x00\x04\x0b\x00"
IMG_CHUNK = MAGIC + b"\x08\x00\x00\x00"
IMG_END = MAGIC + b"\x06\x00\x00\x00"
ACK = b"A"
CHUNK_SIZE = 47
WIDTH, HEIGHT = 960, 376
FRAME_BYTES = WIDTH * HEIGHT * 2
UNSUPPORTED = {errno.ENOTTY, errno.EINVAL, errno.ENOSYS,
               getattr(errno, "EOPNOTSUPP", errno.ENOTTY)}
DEVICE_PATH_RE = re.compile(
    r"^/dev/(?:tty(?:ACM|USB)[0-9]+|serial/by-id/[A-Za-z0-9_.:+-]+)$")
CANONICAL_DEVICE_RE = re.compile(r"^/dev/tty(?:ACM|USB)[0-9]+$")


class ProbeError(RuntimeError):
    pass


class ControlLinesUnsupported(ProbeError):
    pass


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Isolate AOOSTAR brightness changes")
    parser.add_argument(
        "device", nargs="?", default="/dev/ttyACM0",
        help=("serial character device: /dev/ttyACM<N>, /dev/ttyUSB<N>, "
              "or /dev/serial/by-id/<name>"))
    parser.add_argument("--control-lines", action="store_true",
                        help="opt in to DTR/RTS toggles (may reset USB)")
    return parser.parse_args(argv)


def device_path_allowed(path):
    """Accept only the serial-device spellings supported by the installer."""
    return bool(DEVICE_PATH_RE.fullmatch(path))


def resolve_device_path(path):
    """Return a canonical approved tty path and its character-device ID."""
    if not device_path_allowed(path):
        raise ProbeError(
            "device must be /dev/ttyACM<N>, /dev/ttyUSB<N>, "
            "or /dev/serial/by-id/<name>")

    resolved = os.path.realpath(path)
    if not CANONICAL_DEVICE_RE.fullmatch(resolved):
        raise ProbeError(
            f"{path} resolves outside approved ttyACM/ttyUSB devices: {resolved}")
    try:
        requested = os.stat(path, follow_symlinks=True)
        canonical = os.stat(resolved, follow_symlinks=False)
    except OSError as exc:
        raise ProbeError(f"cannot inspect serial device {path}: {exc}") from exc
    if not stat.S_ISCHR(requested.st_mode) or not stat.S_ISCHR(canonical.st_mode):
        raise ProbeError(f"{path} does not resolve to a character device")
    if requested.st_rdev != canonical.st_rdev:
        raise ProbeError(f"serial device changed while resolving {path}")
    return resolved, canonical.st_rdev


def _process_name(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as stream:
            return stream.read(4096).replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return "<unavailable>"


def _owners(path, expected_rdev):
    """Supplement TIOCEXCL, which only blocks opens made after the ioctl."""
    target = os.stat(path, follow_symlinks=False)
    if not stat.S_ISCHR(target.st_mode):
        raise ProbeError(f"{path} is not a character device")
    if target.st_rdev != expected_rdev:
        raise ProbeError(f"{path} changed after canonical device validation")
    owners, denied = {}, 0
    for proc in os.scandir("/proc"):
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        pid = int(proc.name)
        try:
            descriptors = list(os.scandir(f"/proc/{pid}/fd"))
        except PermissionError:
            denied += 1
            continue
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                opened = os.stat(descriptor.path, follow_symlinks=True)
            except OSError:
                continue
            if stat.S_ISCHR(opened.st_mode) and opened.st_rdev == target.st_rdev:
                owners[pid] = _process_name(pid)
                break
    return sorted(owners.items()), denied


def _require_unowned(path, expected_rdev, phase):
    owners, denied = _owners(path, expected_rdev)
    if denied:
        raise ProbeError(f"{phase}: cannot inspect {denied} process fd directories; rerun with sudo")
    if owners:
        detail = "\n".join(f"  PID {pid}: {name}" for pid, name in owners)
        raise ProbeError(f"{phase}: {path} is already open:\n{detail}")


def open_port(path, expected_rdev):
    if not hasattr(termios, "B1500000"):
        raise ProbeError("B1500000 is unavailable; refusing to use another baud rate")
    _require_unowned(path, expected_rdev, "pre-open")
    fd = -1
    try:
        flags = os.O_RDWR | os.O_NOCTTY | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        opened = os.fstat(fd)
        if not stat.S_ISCHR(opened.st_mode) or opened.st_rdev != expected_rdev:
            raise ProbeError(f"{path} changed while it was being opened")
        fcntl.ioctl(fd, termios.TIOCEXCL)
        _require_unowned(path, expected_rdev, "post-open")
        original_attrs = termios.tcgetattr(fd)
        attrs = list(original_attrs)
        attrs[6] = list(original_attrs[6])
        attrs[0], attrs[1], attrs[3] = 0, 0, 0
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[4] = attrs[5] = termios.B1500000
        attrs[6][termios.VMIN] = attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        return fd, original_attrs
    except BaseException:
        if fd >= 0:
            os.close(fd)
        raise


def _send(fd, payload):
    view = memoryview(payload)
    while view:
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        if written <= 0:
            raise ProbeError("serial write made no progress")
        view = view[written:]
    termios.tcdrain(fd)


def _wait_ack(fd, label, timeout=3.0):
    deadline, received = time.monotonic() + timeout, bytearray()
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], max(0, deadline-time.monotonic()))
        if not readable:
            break
        chunk = os.read(fd, 4096)
        received.extend(chunk)
        if ACK in received:
            return
    raise ProbeError(f"{label}: no ACK 'A' in {timeout:.1f}s; received={bytes(received[-64:])!r}")


def _begin_request(fd):
    termios.tcflush(fd, termios.TCIFLUSH)  # discard stale A


def send_command_expect_ack(fd, payload, label):
    _begin_request(fd)
    _send(fd, payload)
    _wait_ack(fd, label)
    print(f"    {label}: ACK 'A' confirmed")


def send_frame_expect_ack(fd, pixels, label):
    if len(pixels) != FRAME_BYTES:
        raise ValueError(f"expected {FRAME_BYTES} bytes, got {len(pixels)}")
    _begin_request(fd)
    packets = bytearray(IMG_START)
    for offset in range(0, FRAME_BYTES, CHUNK_SIZE):
        packets += IMG_CHUNK + offset.to_bytes(4, "little") + pixels[offset:offset+CHUNK_SIZE]
        if len(packets) >= 65536:
            _send(fd, packets)
            packets.clear()
    packets += IMG_END
    _send(fd, packets)
    _wait_ack(fd, label)
    print(f"    {label}: ACK 'A' confirmed")


def solid(r, g, b):
    return (((r << 11) | (g << 5) | b).to_bytes(2, "little") * (WIDTH * HEIGHT))


def color_bars():
    colors = [(31,0,0),(31,32,0),(31,63,0),(0,63,0),
              (0,63,31),(0,0,31),(31,0,31),(31,63,31)]
    row = bytearray()
    for x in range(WIDTH):
        r, g, b = colors[x * len(colors) // WIDTH]
        row += ((r << 11) | (g << 5) | b).to_bytes(2, "little")
    return bytes(row) * HEIGHT


def ask(text, uncertain=True):
    choices = "[y/n/u]" if uncertain else "[y/n]"
    while True:
        answer = input(f"{text} {choices} ").strip().lower()
        if answer in ("y", "yes"):
            return "y"
        if answer in ("n", "no"):
            return "n"
        if uncertain and answer in ("u", "unknown", "unsure", "모름"):
            return "u"
        print("  y, n" + (", u" if uncertain else "") + " 중 하나를 입력하세요.")


def _ioctl(fd, operation, value):
    code = getattr(termios, operation, None)
    if code is None:
        raise ControlLinesUnsupported(f"termios.{operation} unavailable")
    data = array.array("i", [value])
    try:
        fcntl.ioctl(fd, code, data, True)
    except OSError as exc:
        if exc.errno in UNSUPPORTED:
            raise ControlLinesUnsupported(f"{operation} unsupported: {exc}") from exc
        raise ProbeError(f"{operation} failed: {exc}") from exc
    return int(data[0])


def get_control_state(fd):
    return _ioctl(fd, "TIOCMGET", 0)


def set_control_state(fd, state):
    _ioctl(fd, "TIOCMSET", state)


def control_mask(name):
    value = getattr(termios, name, None)
    if value is None:
        raise ControlLinesUnsupported(f"termios.{name} unavailable")
    return int(value)


def _probe_line(fd, original, name, mask, stage, results):
    changed = False
    try:
        set_control_state(fd, original ^ mask)
        changed = True
        time.sleep(1)
        results[f"S{stage}_{name.lower()}_toggled_changed"] = ask(
            f"[S{stage}] {name}만 반전했습니다. 밝기/화면 상태가 변했나요?")
    finally:
        if changed:
            set_control_state(fd, original)
    time.sleep(1)
    results[f"S{stage+1}_{name.lower()}_restored_changed"] = ask(
        f"[S{stage+1}] {name}을 원복했습니다. 다시 변했나요?")


def _summary(results, complete):
    print("\n========== SUMMARY ==========")
    print(f"probe_complete={'y' if complete else 'n'}")
    for key, value in results.items():
        print(f"{key}={value}")
    print("=" * 31)


def main(argv=None):
    args = parse_args(argv)
    try:
        running = subprocess.run(["pgrep", "-x", "asterctl-web"], capture_output=True).returncode == 0
    except FileNotFoundError:
        running = False
    if running:
        print("Run: systemctl disable --now asterctl-web, then reboot")
        return 1
    try:
        device_path, device_rdev = resolve_device_path(args.device)
    except ProbeError as exc:
        print(f"ERROR: {exc}")
        return 1

    print("Service order probe: open -> DISPLAY_ON -> frame")
    if device_path != args.device:
        print(f"Serial device: {args.device} -> {device_path}")
    print("TIOCEXCL only blocks later opens; /proc is checked before and after open.")
    print("Visual answers narrow suspects; they do not measure panel nits or prove causation.")
    if args.control_lines:
        print("WARNING: DTR/RTS toggles may reset/disconnect USB; restoration can fail after disconnect.")

    results, fd, tty_attrs, control_state = {}, None, None, None
    touched = restore = complete = interrupted = False
    failure = restore_failure = None
    try:
        input("Watch the brightest built-in animation scene, then press Enter: ")
        fd, tty_attrs = open_port(device_path, device_rdev)
        touched = True
        time.sleep(1)
        results["S1_port_open_changed"] = ask("[S1] Did open alone change brightness/state?")

        if args.control_lines:
            try:
                control_state = get_control_state(fd)
                print(f"    Saved TIOCMGET state: 0x{control_state:x}")
            except ControlLinesUnsupported as exc:
                results["control_lines"] = "unsupported"
                print(f"    Control-line test skipped: {exc}")

        send_command_expect_ack(fd, DISPLAY_ON, "DISPLAY_ON")
        time.sleep(1)
        results["S2_display_on_changed"] = ask("[S2] Did DISPLAY_ON alone change brightness/state?")

        send_frame_expect_ack(fd, solid(31, 63, 31), "WHITE_FRAME")
        results["S3_white_dimmer_than_boot_animation"] = ask("[S3] Is full white dimmer than the boot animation?")

        send_frame_expect_ack(fd, color_bars(), "COLOR_BARS_FRAME")
        results["S4_bars_dimmer_than_boot_animation"] = ask("[S4] Are color bars dimmer than comparable boot colors?")

        off_attempted = False
        try:
            off_attempted = True
            send_command_expect_ack(fd, DISPLAY_OFF, "DISPLAY_OFF")
            results["S5_display_off_blanked"] = ask("[S5] Did DISPLAY_OFF fully blank the panel?")
        finally:
            if off_attempted:
                send_command_expect_ack(fd, DISPLAY_ON, "DISPLAY_ON_AFTER_OFF")
        results["S6_display_on_after_off_dimmer"] = ask("[S6] Is the returned image dimmer than before OFF?")

        if args.control_lines and control_state is not None:
            if ask("Start the warned DTR/RTS test?", uncertain=False) == "y":
                restore = True
                try:
                    _probe_line(fd, control_state, "DTR", control_mask("TIOCM_DTR"), 7, results)
                    _probe_line(fd, control_state, "RTS", control_mask("TIOCM_RTS"), 9, results)
                except ControlLinesUnsupported as exc:
                    results["control_lines"] = "unsupported"
                    print(f"Control-line test stopped: {exc}")
            else:
                results["control_lines"] = "declined"
        complete = True
    except KeyboardInterrupt:
        interrupted = True
    except (ProbeError, OSError) as exc:
        failure = str(exc)
    finally:
        if fd is not None and restore and control_state is not None:
            try:
                set_control_state(fd, control_state)
                print("Control-line state restored")
            except (ProbeError, OSError) as exc:
                restore_failure = str(exc)
                print(f"WARNING: control-line restore failed: {exc}")
        if fd is not None and tty_attrs is not None:
            try:
                termios.tcsetattr(fd, termios.TCSANOW, tty_attrs)
            except OSError as exc:
                restore_failure = restore_failure or f"termios restore failed: {exc}"
                print(f"WARNING: termios restore failed: {exc}")
        if fd is not None:
            os.close(fd)

    if results or interrupted or failure:
        _summary(results, complete)
    if interrupted:
        print("Interrupted after device access; screen/controller state may have changed."
              if touched else "Interrupted before device access.")
        return 130
    if failure or restore_failure:
        print(f"ERROR: {failure or restore_failure}")
        if touched:
            print("Device state may have changed.")
        return 1
    print("Restore service with: systemctl enable --now asterctl-web")
    return 0


if __name__ == "__main__":
    sys.exit(main())
