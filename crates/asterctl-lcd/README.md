# asterctl-lcd

`asterctl-lcd` is the AOOSTAR display-protocol crate used by AOOSTAR OLED
Studio. The web backend owns one `AooScreen` instance in a dedicated worker and
uses this crate for display power commands and RGB565 frame transfers; the HTTP
layer does not duplicate the serial protocol.

This crate is derived from
[`zehnm/aoostar-rs`](https://github.com/zehnm/aoostar-rs), originally written by
Markus Zehnder. The derived protocol source files retain their SPDX copyright
and dual-license notices. The crate is available under either the MIT License or
Apache License 2.0.

## Display protocol

- Target devices: AOOSTAR WTR MAX and GEM12+ PRO
- Resolution: 960 x 376 pixels
- Pixel format: RGB565, little endian
- Complete frame size: 721,920 bytes
- Transport: USB UART, VID:PID `0416:90a1`
- Serial settings: 1,500,000 baud, 8N1

Use `AooScreenBuilder` to open the default USB device, a specific serial path,
or a simulated port. `AooScreen::send_rgb565_le` accepts one already encoded
full frame and rejects any other byte length.
