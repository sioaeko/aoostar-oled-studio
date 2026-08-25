import { describe, expect, test } from 'bun:test';
import { applyRgb565PreviewInPlace, boostRgb565Pixel } from './oled';

function rgb565(red: number, green: number, blue: number): number {
  return (red << 11) | (green << 5) | blue;
}

function unpack565(packed: number): [number, number, number] {
  return [(packed >> 11) & 0x1f, (packed >> 5) & 0x3f, packed & 0x1f];
}

describe('RGB565 brightness preview', () => {
  test('100% is an identity operation on packed panel pixels', () => {
    for (const pixel of [0x8410, 0x2937, 0xffff, 0x0000]) {
      expect(boostRgb565Pixel(pixel, 100)).toBe(pixel);
    }
  });

  test('lifts a midpoint gray without adding a tint', () => {
    const [red, green, blue] = unpack565(boostRgb565Pixel(rgb565(16, 32, 16), 150));
    expect(red).toBeGreaterThan(16);
    expect(blue).toBeGreaterThan(16);
    expect(red).toBe(blue);
    expect(Math.abs(green - 2 * red)).toBeLessThanOrEqual(1);
  });

  test('keeps RGB565 endpoints and largely preserves saturated color ratios', () => {
    for (const endpoint of [
      rgb565(0, 0, 0),
      rgb565(31, 63, 31),
      rgb565(31, 0, 0),
      rgb565(0, 63, 0),
      rgb565(0, 0, 31),
    ]) {
      expect(boostRgb565Pixel(endpoint, 200)).toBe(endpoint);
    }

    const [red, green, blue] = unpack565(boostRgb565Pixel(rgb565(20, 20, 0), 200));
    expect(blue).toBe(0);
    expect(red).toBeGreaterThan(20);
    expect(Math.abs(green - red)).toBeLessThanOrEqual(2);
  });

  test('preview quantizes RGBA through RGB565 before applying the boost', () => {
    const preview = new Uint8ClampedArray([128, 128, 128, 77, 255, 0, 0, 255]);
    applyRgb565PreviewInPlace(preview, 150);

    // Alpha is not part of the panel frame and must be left alone. The RGB
    // values are expanded from the same boosted RGB565 words sent by backend.
    expect(Array.from(preview)).toEqual([165, 162, 165, 77, 255, 0, 0, 255]);
  });
});
