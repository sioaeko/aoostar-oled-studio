# Third-party notices

AOOSTAR OLED Studio is an independent project maintained at
<https://github.com/sioaeko/aoostar-oled-studio>.

The `asterctl-lcd` device-protocol crate is derived from
[`zehnm/aoostar-rs`](https://github.com/zehnm/aoostar-rs), Copyright (c) 2025
Markus Zehnder. Those files retain their SPDX copyright notices and are
available under the MIT License or Apache License 2.0.

The optional bundled `yt-dlp` helper is distributed under The Unlicense. Its
license is stored at `third_party/yt-dlp/LICENSE` and is copied into Proxmox
release packages.

The self-hosted Figtree, JetBrains Mono, and Space Grotesk fonts are licensed
under the SIL Open Font License. Their license texts are stored alongside the
font files in `oled-studio/source/public/fonts/licenses/`.

The server-side Spotify renderer embeds Inter, Copyright 2020 The Inter
Project Authors, and Noto Sans KR, Copyright 2014-2021 Adobe, both under the
SIL Open Font License 1.1. Sources:
<https://github.com/google/fonts/tree/main/ofl/inter> and
<https://github.com/google/fonts/tree/main/ofl/notosanskr>. The bundled files
are static instances of the variable fonts (Inter wght 580/560 at opsz 32 and
wght 400 at opsz 20; Noto Sans KR wght 570) with hinting and OpenType layout
tables removed, made with fontTools. Font names are unchanged; neither font has
a Reserved Font Name that applies to them. Files and licenses are in
`crates/asterctl-web/assets/`.

Nocturne (<https://github.com/usenocturne/nocturne>) is a visual reference
for the Spotify display only. No Nocturne firmware, application code, fonts,
images, icons, or API services are bundled or used. The sample album artwork
is original, fictional layout-test content. Spotify is a trademark of Spotify AB;
this project is not endorsed by Spotify or Nocturne.
