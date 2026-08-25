#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0

import importlib.util
import stat
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


# The policy tests exercise only path/canonical-device validation. Allow them
# to run from a Windows packaging checkout where Linux-only modules are absent.
for linux_module in ("fcntl", "termios"):
    if importlib.util.find_spec(linux_module) is None:
        sys.modules[linux_module] = types.ModuleType(linux_module)


PROBE_PATH = Path(__file__).resolve().parents[1] / "brightness-probe.py"
SPEC = importlib.util.spec_from_file_location("brightness_probe", PROBE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


def fake_stat(mode=stat.S_IFCHR | 0o600, rdev=123):
    return types.SimpleNamespace(st_mode=mode, st_rdev=rdev)


class DevicePathPolicyTests(unittest.TestCase):
    def test_approved_input_forms(self):
        for path in (
            "/dev/ttyACM0",
            "/dev/ttyUSB12",
            "/dev/serial/by-id/usb-AOOSTAR_0416_90a1-if00",
        ):
            with self.subTest(path=path):
                self.assertTrue(PROBE.device_path_allowed(path))

    def test_unsafe_input_forms(self):
        for path in (
            "ttyACM0",
            "/dev/null",
            "/tmp/ttyACM0",
            "/dev/ttyACM0 --simulate",
            "/dev/serial/by-id/../../null",
            "/dev/serial/by-path/pci-0000",
        ):
            with self.subTest(path=path):
                self.assertFalse(PROBE.device_path_allowed(path))

    def test_serial_by_id_resolves_to_approved_character_device(self):
        node = fake_stat(rdev=456)
        with mock.patch.object(PROBE.os.path, "realpath", return_value="/dev/ttyUSB2"), \
                mock.patch.object(PROBE.os, "stat", side_effect=(node, node)):
            self.assertEqual(
                PROBE.resolve_device_path(
                    "/dev/serial/by-id/usb-AOOSTAR_0416_90a1-if00"),
                ("/dev/ttyUSB2", 456),
            )

    def test_rejects_canonical_path_outside_approved_ttys(self):
        with mock.patch.object(PROBE.os.path, "realpath", return_value="/dev/null"), \
                mock.patch.object(PROBE.os, "stat") as stat_mock:
            with self.assertRaises(PROBE.ProbeError):
                PROBE.resolve_device_path(
                    "/dev/serial/by-id/usb-AOOSTAR_0416_90a1-if00")
            stat_mock.assert_not_called()

    def test_rejects_non_character_device(self):
        regular = fake_stat(mode=stat.S_IFREG | 0o600)
        with mock.patch.object(PROBE.os.path, "realpath", return_value="/dev/ttyACM0"), \
                mock.patch.object(PROBE.os, "stat", side_effect=(regular, regular)):
            with self.assertRaisesRegex(PROBE.ProbeError, "character device"):
                PROBE.resolve_device_path("/dev/ttyACM0")

    def test_rejects_device_change_during_resolution(self):
        with mock.patch.object(PROBE.os.path, "realpath", return_value="/dev/ttyACM0"), \
                mock.patch.object(
                    PROBE.os, "stat", side_effect=(fake_stat(rdev=1), fake_stat(rdev=2))):
            with self.assertRaisesRegex(PROBE.ProbeError, "changed"):
                PROBE.resolve_device_path("/dev/ttyACM0")


if __name__ == "__main__":
    unittest.main()
