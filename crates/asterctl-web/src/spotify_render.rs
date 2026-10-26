// SPDX-License-Identifier: MIT OR Apache-2.0
// Original fixed-size renderer. The layout follows the proportions of the
// Nocturne "Now Playing" screen (visual reference only, no code is copied)
// without the playback controls, scaled to fit the 960x376 panel.
use std::{io::Cursor, sync::LazyLock};

use fontdue::{Font, FontSettings};
use image::{GrayImage, ImageFormat, Luma, Rgb, RgbImage, imageops::FilterType};

use crate::spotify::Track;

fn load(bytes: &'static [u8]) -> Font {
    Font::from_bytes(bytes, FontSettings::default()).expect("bundled font")
}
// Static instances of the Inter and Noto Sans KR variable fonts at the
// weights the reference uses (title 580, artist 560, timestamps 400).
static TITLE: LazyLock<Font> = LazyLock::new(|| load(include_bytes!("../assets/Inter-580.ttf")));
static ARTIST: LazyLock<Font> = LazyLock::new(|| load(include_bytes!("../assets/Inter-560.ttf")));
static LABEL: LazyLock<Font> = LazyLock::new(|| load(include_bytes!("../assets/Inter-400.ttf")));
static KOREAN: LazyLock<Font> =
    LazyLock::new(|| load(include_bytes!("../assets/NotoSansKR-570.ttf")));

pub const WIDTH: u32 = 960;
pub const HEIGHT: u32 = 376;

// The reference screen is 800x480 with controls below the progress bar.
// Without controls the remaining stack is 338 px tall; scaling it by 0.9 fits
// the panel with the reference's 40 px top margin (36 px here) on both ends.
const SCALE: f32 = 0.9;
const PAD_X: f32 = 48.0 * SCALE;
const ART: f32 = 280.0 * SCALE;
const ART_RADIUS: f32 = 12.0 * SCALE;
const ART_GAP: f32 = 32.0 * SCALE;
const TITLE_SIZE: f32 = 40.0 * SCALE;
const ARTIST_SIZE: f32 = 36.0 * SCALE;
const LABEL_SIZE: f32 = 20.0 * SCALE;
const BAR_HEIGHT: f32 = 8.0 * SCALE;
// Inter's ascent and descent; "line-height: normal" in a browser.
const ASCENT: f32 = 1984.0 / 2048.0;
const LINE: f32 = (1984.0 + 494.0) / 2048.0;
const TOP: f32 = (HEIGHT as f32 - (280.0 + 4.0 + 16.0 + 8.0 + 6.0 + 20.0 * LINE) * SCALE) / 2.0;
const TEXT_X: f32 = PAD_X + ART + ART_GAP;
const TEXT_WIDTH: f32 = WIDTH as f32 - PAD_X - TEXT_X;
const BAR_Y: f32 = TOP + ART + (4.0 + 16.0) * SCALE;
const LABEL_Y: f32 = BAR_Y + BAR_HEIGHT + 6.0 * SCALE;
const NO_COVER: [f32; 3] = [25.0, 20.0, 20.0];

pub fn png(frame: &RgbImage) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    frame
        .write_to(&mut out, ImageFormat::Png)
        .expect("encode RGB PNG");
    out.into_inner()
}

/// Latin script uses Inter; anything Inter lacks (Hangul, kana, Hanja) falls
/// back to Noto Sans KR, like the reference's CSS font stack.
fn glyph_font(primary: &'static Font, c: char) -> &'static Font {
    if primary.lookup_glyph_index(c) != 0 || KOREAN.lookup_glyph_index(c) == 0 {
        primary
    } else {
        &KOREAN
    }
}

/// Advance width including CSS letter-spacing ("tracking-tight" is -0.05em).
fn measure(text: &str, font: &'static Font, size: f32, tracking: f32) -> f32 {
    text.chars()
        .map(|c| glyph_font(font, c).metrics(c, size).advance_width + tracking * size)
        .sum()
}

/// Single-line truncation with an ellipsis, as CSS `truncate` does.
fn fit(text: &str, font: &'static Font, size: f32, tracking: f32, width: f32) -> String {
    if measure(text, font, size, tracking) <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = measure("…", font, size, tracking);
    for c in text.chars() {
        used += measure(&c.to_string(), font, size, tracking);
        if used > width {
            break;
        }
        out.push(c);
    }
    let mut out = out.trim_end().to_owned();
    out.push('…');
    out
}

fn blend(dest: &mut Rgb<u8>, ink: [f32; 3], alpha: f32) {
    for (channel, ink) in dest.0.iter_mut().zip(ink) {
        *channel = (f32::from(*channel) * (1.0 - alpha) + ink * alpha).round() as u8;
    }
}

#[allow(clippy::too_many_arguments)]
fn text(
    frame: &mut RgbImage,
    value: &str,
    x: f32,
    baseline: f32,
    font: &'static Font,
    size: f32,
    tracking: f32,
    opacity: f32,
) {
    let mut pen = x;
    for c in value.chars() {
        let glyph = glyph_font(font, c);
        let (metrics, bitmap) = glyph.rasterize(c, size);
        let left = pen.round() as i32 + metrics.xmin;
        let top = baseline.round() as i32 - metrics.height as i32 - metrics.ymin;
        for y in 0..metrics.height {
            for x in 0..metrics.width {
                let px = left + x as i32;
                let py = top + y as i32;
                if !(0..WIDTH as i32).contains(&px) || !(0..HEIGHT as i32).contains(&py) {
                    continue;
                }
                let alpha = f32::from(bitmap[y * metrics.width + x]) / 255.0 * opacity;
                blend(frame.get_pixel_mut(px as u32, py as u32), [255.0; 3], alpha);
            }
        }
        pen += metrics.advance_width + tracking * size;
    }
}

/// Anti-aliased coverage of a rounded rectangle at a pixel center.
fn rounded(px: f32, py: f32, x: f32, y: f32, w: f32, h: f32, r: f32) -> f32 {
    let dx = (px - (x + w / 2.0)).abs() - (w / 2.0 - r);
    let dy = (py - (y + h / 2.0)).abs() - (h / 2.0 - r);
    let outside = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - r;
    (0.5 - outside).clamp(0.0, 1.0)
}

fn fill_rounded(frame: &mut RgbImage, rect: [f32; 4], radius: f32, ink: [f32; 3], opacity: f32) {
    let [x, y, w, h] = rect;
    for py in (y.floor() as u32)..((y + h).ceil() as u32).min(HEIGHT) {
        for px in (x.floor() as u32)..((x + w).ceil() as u32).min(WIDTH) {
            let alpha = rounded(px as f32 + 0.5, py as f32 + 0.5, x, y, w, h, radius) * opacity;
            if alpha > 0.0 {
                blend(frame.get_pixel_mut(px, py), ink, alpha);
            }
        }
    }
}

fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
}

fn luma(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

fn scaled(c: [f32; 3], factor: f32) -> [f32; 3] {
    c.map(|v| (v * factor).round().clamp(0.0, 255.0))
}

/// Four background colors from the artwork: brightest, two mid tones and the
/// darkest of a 5x5 sample grid. Bright colors are capped so white text stays
/// legible; near-black artwork gets a dim tint of its first visible color.
fn palette(cover: &RgbImage) -> [[f32; 3]; 4] {
    let small = image::imageops::resize(cover, 100, 100, FilterType::Triangle);
    let mut samples: Vec<[f32; 3]> = (0..5)
        .flat_map(|x| (0..5).map(move |y| (x * 20, y * 20)))
        .map(|(x, y)| small.get_pixel(x, y).0.map(f32::from))
        .collect();
    samples.sort_by(|a, b| luma(*b).total_cmp(&luma(*a)));
    let picked = [samples[0], samples[10], samples[12], samples[24]].map(|c| {
        let l = luma(c);
        if l > 200.0 { scaled(c, 200.0 / l) } else { c }
    });
    let dark = picked.iter().filter(|c| luma(**c) < 30.0).count();
    let average = picked.iter().map(|c| luma(*c)).sum::<f32>() / 4.0;
    if dark >= 3 || average < 25.0 {
        let accent = picked
            .iter()
            .copied()
            .find(|c| luma(*c) > 30.0)
            .unwrap_or_else(|| {
                let [r, g, b] = picked[0];
                if r >= g && r >= b {
                    [61.0, 40.0, 40.0]
                } else if g >= b {
                    [40.0, 61.0, 40.0]
                } else {
                    [40.0, 40.0, 61.0]
                }
            });
        return [
            scaled(accent, 0.3),
            scaled(accent, 0.2),
            accent,
            scaled(accent, 0.1).map(|v| v.max(1.0)),
        ];
    }
    let mut sorted = picked;
    sorted.sort_by(|a, b| luma(*b).total_cmp(&luma(*a)));
    sorted
}

/// Mesh of four radial gradients over black, each fading from its color to
/// transparent at 80% of an ellipse that reaches the farthest corner.
fn background(colors: [[f32; 3]; 4]) -> RgbImage {
    const CENTERS: [(f32, f32); 4] = [(0.0, 0.25), (0.25, 0.0), (1.0, 0.75), (0.75, 1.0)];
    let (w, h) = (WIDTH as f32, HEIGHT as f32);
    let radii = CENTERS.map(|(u, v)| {
        let sqrt2 = std::f32::consts::SQRT_2;
        (u.max(1.0 - u) * w * sqrt2, v.max(1.0 - v) * h * sqrt2)
    });
    RgbImage::from_fn(WIDTH, HEIGHT, |x, y| {
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        let mut out = [0.0f32; 3];
        // Painted bottom layer first; the first gradient in the list is on top.
        for i in (0..4).rev() {
            let (u, v) = CENTERS[i];
            let (rx, ry) = radii[i];
            let t = ((px - u * w) / rx).hypot((py - v * h) / ry);
            let alpha = (1.0 - t / 0.8).clamp(0.0, 1.0);
            for c in 0..3 {
                out[c] = colors[i][c] * alpha + out[c] * (1.0 - alpha);
            }
        }
        Rgb(out.map(|c| c.round() as u8))
    })
}

fn draw_artwork(frame: &mut RgbImage, cover: Option<&RgbImage>) {
    let (x, y) = (PAD_X, TOP);
    // drop-shadow(0 8px 5px rgba(0,0,0,.25)): blurred copy of the rounded shape.
    let mut shadow = GrayImage::new(WIDTH, HEIGHT);
    let offset = 8.0 * SCALE;
    for py in 0..HEIGHT {
        for px in 0..WIDTH {
            let alpha = rounded(
                px as f32 + 0.5,
                py as f32 + 0.5,
                x,
                y + offset,
                ART,
                ART,
                ART_RADIUS,
            );
            shadow.put_pixel(px, py, Luma([(alpha * 255.0) as u8]));
        }
    }
    let shadow = image::imageops::blur(&shadow, 5.0 * SCALE / 2.0);
    for (px, py, value) in shadow.enumerate_pixels() {
        if value.0[0] > 0 {
            blend(
                frame.get_pixel_mut(px, py),
                [0.0; 3],
                f32::from(value.0[0]) / 255.0 * 0.25,
            );
        }
    }
    let size = ART.round() as u32;
    // object-cover: center-crop to a square, then scale.
    let art = cover.map(|cover| {
        let side = cover.width().min(cover.height());
        let square = image::imageops::crop_imm(
            cover,
            (cover.width() - side) / 2,
            (cover.height() - side) / 2,
            side,
            side,
        )
        .to_image();
        image::imageops::resize(&square, size, size, FilterType::Lanczos3)
    });
    let (left, top) = (x.round() as u32, y.round() as u32);
    for dy in 0..size {
        for dx in 0..size {
            let (px, py) = (left + dx, top + dy);
            let alpha = rounded(px as f32 + 0.5, py as f32 + 0.5, x, y, ART, ART, ART_RADIUS);
            if alpha <= 0.0 {
                continue;
            }
            let ink = art.as_ref().map_or([40.0, 40.0, 40.0], |art| {
                art.get_pixel(dx, dy).0.map(f32::from)
            });
            blend(frame.get_pixel_mut(px, py), ink, alpha);
        }
    }
    if cover.is_none() {
        let note = "♪";
        let size = 120.0 * SCALE;
        let width = measure(note, &LABEL, size, 0.0);
        let baseline = y + ART / 2.0 + size * 0.35;
        text(
            frame,
            note,
            x + (ART - width) / 2.0,
            baseline,
            &LABEL,
            size,
            0.0,
            0.35,
        );
    }
}

pub fn sample_art() -> RgbImage {
    let mut art = RgbImage::from_fn(272, 272, |x, y| {
        let d = ((x as f32 - 138.0).powi(2) + (y as f32 - 183.0).powi(2)).sqrt();
        let ring = if d > 65.0 && d < 115.0 && (d as u32 % 7 < 2) {
            22
        } else {
            0
        };
        Rgb([232 + ring, (77.0 + y as f32 * 0.16) as u8, 23 + ring])
    });
    let mut draw = |value: &str, baseline: f32, font: &'static Font, size: f32| {
        let mut pen: f32 = 24.0;
        for c in value.chars() {
            let (metrics, bitmap) = font.rasterize(c, size);
            let left = pen.round() as i32 + metrics.xmin;
            let top = baseline as i32 - metrics.height as i32 - metrics.ymin;
            for y in 0..metrics.height {
                for x in 0..metrics.width {
                    let (px, py) = (left + x as i32, top + y as i32);
                    if (0..272).contains(&px) && (0..272).contains(&py) {
                        let alpha = f32::from(bitmap[y * metrics.width + x]) / 255.0;
                        blend(
                            art.get_pixel_mut(px as u32, py as u32),
                            [255.0, 240.0, 215.0],
                            alpha,
                        );
                    }
                }
            }
            pen += metrics.advance_width;
        }
    };
    draw("NIGHT", 62.0, &TITLE, 38.0);
    draw("DRIVE", 104.0, &TITLE, 38.0);
    draw("OLED STUDIO / SAMPLE", 253.0, &LABEL, 14.0);
    art
}

pub fn render(
    track: Option<&Track>,
    cover: Option<&RgbImage>,
    progress: u64,
    message: &str,
) -> RgbImage {
    let colors = cover.map_or([NO_COVER; 4], palette);
    let mut frame = background(colors);
    draw_artwork(&mut frame, cover);

    // Title and artist are vertically centered against the artwork.
    let tracking = -0.05;
    let (title, artist) = match track {
        Some(track) => (track.title.as_str(), track.artist.as_str()),
        // No track: the reference shows "Not Playing"; the connection state
        // takes the empty artist line so setup problems stay visible.
        None => ("Not Playing", message),
    };
    let block = (TITLE_SIZE + ARTIST_SIZE) * LINE;
    let block_top = TOP + ART / 2.0 - block / 2.0;
    let title = fit(title, &TITLE, TITLE_SIZE, tracking, TEXT_WIDTH);
    text(
        &mut frame,
        &title,
        TEXT_X,
        block_top + TITLE_SIZE * ASCENT,
        &TITLE,
        TITLE_SIZE,
        tracking,
        1.0,
    );
    let artist = fit(artist, &ARTIST, ARTIST_SIZE, tracking, TEXT_WIDTH);
    text(
        &mut frame,
        &artist,
        TEXT_X,
        block_top + TITLE_SIZE * LINE + ARTIST_SIZE * ASCENT,
        &ARTIST,
        ARTIST_SIZE,
        tracking,
        0.6,
    );

    let duration = track.map_or(0, |t| t.duration_ms);
    let bar_width = WIDTH as f32 - 2.0 * PAD_X;
    let bar = [PAD_X, BAR_Y, bar_width, BAR_HEIGHT];
    fill_rounded(&mut frame, bar, BAR_HEIGHT / 2.0, [255.0; 3], 0.2);
    if duration > 0 {
        let fraction = progress.min(duration) as f32 / duration as f32;
        // The fill is a full-width pill translated left and clipped by the track.
        let shift = bar_width * (1.0 - fraction);
        for py in (BAR_Y.floor() as u32)..((BAR_Y + BAR_HEIGHT).ceil() as u32) {
            for px in (PAD_X.floor() as u32)..((PAD_X + bar_width).ceil() as u32) {
                let (cx, cy) = (px as f32 + 0.5, py as f32 + 0.5);
                let track_alpha = rounded(
                    cx,
                    cy,
                    PAD_X,
                    BAR_Y,
                    bar_width,
                    BAR_HEIGHT,
                    BAR_HEIGHT / 2.0,
                );
                let fill_alpha = rounded(
                    cx,
                    cy,
                    PAD_X - shift,
                    BAR_Y,
                    bar_width,
                    BAR_HEIGHT,
                    BAR_HEIGHT / 2.0,
                );
                let alpha = track_alpha.min(fill_alpha);
                if alpha > 0.0 {
                    blend(frame.get_pixel_mut(px, py), [255.0; 3], alpha);
                }
            }
        }
    }

    let (elapsed, total) = if duration > 0 {
        (clock(progress.min(duration)), clock(duration))
    } else {
        ("--:--".into(), "--:--".into())
    };
    let baseline = LABEL_Y + LABEL_SIZE * ASCENT;
    text(
        &mut frame, &elapsed, PAD_X, baseline, &LABEL, LABEL_SIZE, 0.0, 0.6,
    );
    let right = WIDTH as f32 - PAD_X - measure(&total, &LABEL, LABEL_SIZE, 0.0);
    text(
        &mut frame, &total, right, baseline, &LABEL, LABEL_SIZE, 0.0, 0.6,
    );
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "exports visual QA artifacts; run explicitly"]
    async fn export_layout_previews() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../output");
        std::fs::create_dir_all(&directory).unwrap();
        let response = crate::spotify::sample().await;
        let body = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        std::fs::write(directory.join("spotify-panel-sample.png"), body).unwrap();
        let track: Track = serde_json::from_value(serde_json::json!({
            "title": "밤하늘을 지나 너에게 돌아가는 아주 길고 긴 노래 제목",
            "artist": "한글 아티스트 이름, OLED Studio",
            "album": "한국어 표시 확인 · 실제 재생 정보 아님",
            "duration_ms": 224000, "progress_ms": 86000,
            "is_playing": false, "url": ""
        }))
        .unwrap();
        std::fs::write(
            directory.join("spotify-panel-korean.png"),
            png(&render(Some(&track), Some(&sample_art()), 86000, "Paused")),
        )
        .unwrap();
        std::fs::write(
            directory.join("spotify-panel-idle.png"),
            png(&render(None, None, 0, "Not connected")),
        )
        .unwrap();
    }

    #[test]
    fn fixed_panel_bounds_and_unicode_ellipsis() {
        assert_eq!(
            render(None, None, 0, "Not connected").dimensions(),
            (960, 376)
        );
        let title = "아주 긴 한국어 노래 제목과 아티스트 ".repeat(20);
        let shortened = fit(&title, &TITLE, TITLE_SIZE, -0.05, TEXT_WIDTH);
        assert!(shortened.ends_with('…'));
        assert!(measure(&shortened, &TITLE, TITLE_SIZE, -0.05) <= TEXT_WIDTH);
        assert_ne!(KOREAN.lookup_glyph_index('한'), 0);
        assert!(std::ptr::eq(glyph_font(&TITLE, '한'), &*KOREAN));
        assert!(std::ptr::eq(glyph_font(&TITLE, 'A'), &*TITLE));
        // The stack is centered: equal margins above the art and below the labels.
        let bottom = LABEL_Y + LABEL_SIZE * LINE;
        assert!((TOP - (HEIGHT as f32 - bottom)).abs() < 0.5);
    }

    #[test]
    fn long_metadata_stays_inside_panel_and_artwork_is_unmodified() {
        let cover = RgbImage::from_pixel(272, 272, Rgb([255; 3]));
        let track: Track = serde_json::from_value(serde_json::json!({
            "title": "끝없이 길어지는 제목 ".repeat(30),
            "artist": "VeryLongArtistName".repeat(30),
            "album": "앨범 ".repeat(100),
            "duration_ms": 240000, "progress_ms": 90000,
            "is_playing": true, "url": ""
        }))
        .unwrap();
        let frame = render(Some(&track), Some(&cover), 90000, "");
        let empty = render(None, Some(&cover), 0, "");
        assert_eq!(frame.dimensions(), (WIDTH, HEIGHT));
        // Inside the rounded corners the artwork is copied unchanged.
        let inset = ART_RADIUS.ceil() as u32 + 1;
        let (left, top, size) = (PAD_X.round() as u32, TOP.round() as u32, ART.round() as u32);
        for y in top + inset..top + size - inset {
            for x in left + 1..left + size - 1 {
                assert_eq!(frame.get_pixel(x, y), &Rgb([255; 3]));
            }
        }
        // Arbitrary metadata must not intrude into the right padding.
        let right = (WIDTH as f32 - PAD_X).ceil() as u32 + 1;
        for y in 80..(BAR_Y as u32 - 2) {
            for x in right..WIDTH {
                assert_eq!(frame.get_pixel(x, y), empty.get_pixel(x, y));
            }
        }
        // Even a white cover is capped below full brightness behind the text.
        assert!(palette(&cover).iter().all(|c| luma(*c) <= 200.5));
    }

    #[test]
    fn dark_artwork_gets_a_tinted_background() {
        let cover = RgbImage::from_pixel(64, 64, Rgb([5, 5, 5]));
        let colors = palette(&cover);
        assert_eq!(colors[2], [61.0, 40.0, 40.0]);
        assert!(colors.iter().all(|c| luma(*c) <= 61.0));
    }
}
