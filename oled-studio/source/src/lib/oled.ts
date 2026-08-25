/**
 * AOOSTAR WTR MAX front-panel OLED — display spec, frame pipeline and bridge
 * client.
 *
 * The 3.5" panel is a 960×376 RGB LCD driven over an internal USB UART
 * (VID 0x0416, PID 0x90A1, 1.5 Mbaud). Frames travel as raw RGB565
 * little-endian pixels — the format reverse-engineered by the community
 * `aoostar-rs` project (zehnm/aoostar-rs). This module builds those frames in
 * the browser and talks to the embedded `asterctl-web` bridge that owns the
 * serial port.
 *
 * Without a bridge URL every operation is simulated in-browser and every
 * result is flagged `simulated: true` — the UI never claims a frame reached
 * real hardware.
 */

export const OLED_SPEC = {
  width: 960,
  height: 376,
  name: 'AOOSTAR WTR MAX OLED',
  bytesPerFrame: 960 * 376 * 2,
} as const;

export type FitMode = 'contain' | 'cover' | 'stretch';

/** State reported by the oled-bridge service (or simulated in-browser). */
export interface BridgeStatus {
  live: boolean;
  connected: boolean;
  displayOn: boolean;
  brightness: number;
  job: 'idle' | 'gif' | 'still' | 'unknown';
  simulated: boolean;
  device?: string;
  uptimeSec?: number;
  error?: string;
}

export interface SendReceipt {
  ok: boolean;
  simulated: boolean;
  label: string;
  detail: string;
  at: number;
  error?: string;
}

export interface SendResult {
  ok: boolean;
  simulated?: boolean;
  error?: string;
}

export interface YoutubeVideo {
  token: string;
  title: string;
  streamUrl: string;
}

export interface OledClient {
  kind: 'bridge' | 'simulator';
  status(): Promise<BridgeStatus>;
  setPower(on: boolean): Promise<BridgeStatus>;
  setBrightness(percent: number): Promise<BridgeStatus>;
  /** Raw RGB565 LE frame — exactly OLED_SPEC.bytesPerFrame bytes. */
  sendFrame(bytes: Uint8Array<ArrayBuffer>): Promise<SendResult>;
  sendFile(file: File): Promise<SendResult>;
  resolveYoutube(url: string): Promise<YoutubeVideo>;
  releaseYoutube(token: string): Promise<void>;
  stop(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Color / canvas pipeline                                             */
/* ------------------------------------------------------------------ */

/** Convert ImageData (RGBA) to a raw RGB565 little-endian frame. */
export function rgb565FromImageData(img: ImageData): Uint8Array<ArrayBuffer> {
  const { data } = img;
  const out = new Uint8Array(data.length / 2);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 2) {
    const r = data[i] >> 3;
    const g = data[i + 1] >> 2;
    const b = data[i + 2] >> 3;
    const v = (r << 11) | (g << 5) | b;
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
  }
  return out;
}

const previewBoostLuts = new Map<number, Float32Array>();

function normalizedBrightness(brightness: number): number {
  return Math.min(200, Math.max(100, Math.trunc(brightness)));
}

/**
 * Build the same max-channel gamma scale table as `asterctl-web`.
 *
 * Rust performs these operations as `f32`, so the explicit `Math.fround`
 * calls keep rounding behavior aligned at RGB565 quantization boundaries.
 */
function rgb565BoostScaleLut(brightness: number): Float32Array {
  const percent = normalizedBrightness(brightness);
  const cached = previewBoostLuts.get(percent);
  if (cached) return cached;

  const gamma = Math.fround(Math.fround(100) / Math.fround(percent));
  const lut = new Float32Array(256);
  for (let value = 0; value < lut.length; value += 1) {
    if (value === 0) {
      lut[value] = 1;
      continue;
    }
    const max = Math.fround(Math.fround(value) / Math.fround(255));
    const curved = Math.fround(Math.pow(max, gamma));
    lut[value] = Math.fround(curved / max);
  }
  previewBoostLuts.set(percent, lut);
  return lut;
}

/** Apply the backend's brightness algorithm to one packed RGB565 pixel. */
export function boostRgb565Pixel(packed: number, brightness: number): number {
  const pixel = packed & 0xffff;
  const percent = normalizedBrightness(brightness);
  if (percent === 100) return pixel;

  const red = (pixel >> 11) & 0x1f;
  const green = (pixel >> 5) & 0x3f;
  const blue = pixel & 0x1f;
  const red8 = (red << 3) | (red >> 2);
  const green8 = (green << 2) | (green >> 4);
  const blue8 = (blue << 3) | (blue >> 2);
  const scale = rgb565BoostScaleLut(percent)[Math.max(red8, green8, blue8)];
  const boostedRed = Math.min(255, Math.round(Math.fround(red8 * scale))) >> 3;
  const boostedGreen = Math.min(255, Math.round(Math.fround(green8 * scale))) >> 2;
  const boostedBlue = Math.min(255, Math.round(Math.fround(blue8 * scale))) >> 3;
  return (boostedRed << 11) | (boostedGreen << 5) | boostedBlue;
}

/**
 * Quantize a canvas RGBA buffer to RGB565, apply the backend brightness boost,
 * then expand the result back to displayable 8-bit channels for the preview.
 */
export function applyRgb565PreviewInPlace(data: Uint8ClampedArray, brightness: number): void {
  const percent = normalizedBrightness(brightness);
  const scaleLut = percent === 100 ? null : rgb565BoostScaleLut(percent);

  for (let index = 0; index + 3 < data.length; index += 4) {
    let red = data[index] >> 3;
    let green = data[index + 1] >> 2;
    let blue = data[index + 2] >> 3;

    if (scaleLut) {
      const red8 = (red << 3) | (red >> 2);
      const green8 = (green << 2) | (green >> 4);
      const blue8 = (blue << 3) | (blue >> 2);
      const scale = scaleLut[Math.max(red8, green8, blue8)];
      red = Math.min(255, Math.round(Math.fround(red8 * scale))) >> 3;
      green = Math.min(255, Math.round(Math.fround(green8 * scale))) >> 2;
      blue = Math.min(255, Math.round(Math.fround(blue8 * scale))) >> 3;
    }

    data[index] = (red << 3) | (red >> 2);
    data[index + 1] = (green << 2) | (green >> 4);
    data[index + 2] = (blue << 3) | (blue >> 2);
  }
}

export function createOledCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = OLED_SPEC.width;
  canvas.height = OLED_SPEC.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return [canvas, ctx];
}

export function rgb565FromCanvas(canvas: HTMLCanvasElement): Uint8Array<ArrayBuffer> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return rgb565FromImageData(ctx.getImageData(0, 0, OLED_SPEC.width, OLED_SPEC.height));
}

function sourceSize(el: CanvasImageSource): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight };
  if (el instanceof HTMLImageElement) return { w: el.naturalWidth, h: el.naturalHeight };
  if (el instanceof HTMLCanvasElement) return { w: el.width, h: el.height };
  if (typeof OffscreenCanvas !== 'undefined' && el instanceof OffscreenCanvas) {
    return { w: el.width, h: el.height };
  }
  return { w: OLED_SPEC.width, h: OLED_SPEC.height };
}

/** Draw `el` into a w×h canvas honoring the requested fit (black letterbox bars). */
export function drawFit(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  w: number,
  h: number,
  fit: FitMode = 'contain',
) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const { w: sw, h: sh } = sourceSize(el);
  if (!sw || !sh) return;
  if (fit === 'stretch') {
    ctx.drawImage(el, 0, 0, w, h);
    return;
  }
  const scale = fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/* ------------------------------------------------------------------ */
/* File loaders                                                        */
/* ------------------------------------------------------------------ */

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name}`));
    };
    img.src = url;
  });
}

const videoObjectUrls = new WeakMap<HTMLVideoElement, string>();

function abortError(): DOMException {
  return new DOMException('Operation cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Pause a loaded file video and release the Blob URL retained for playback. */
export function disposeVideoFile(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
  const url = videoObjectUrls.get(video);
  if (url) {
    URL.revokeObjectURL(url);
    videoObjectUrls.delete(video);
  }
}

export function loadVideoFile(file: File, signal?: AbortSignal): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const removeListeners = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const releasePendingVideo = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    const fail = (error: Error | DOMException) => {
      if (settled) return;
      settled = true;
      removeListeners();
      releasePendingVideo();
      reject(error);
    };
    const onLoaded = () => {
      if (settled) return;
      settled = true;
      removeListeners();
      videoObjectUrls.set(video, url);
      resolve(video);
    };
    const onError = () => fail(new Error(`Could not decode ${file.name}`));
    const onAbort = () => fail(abortError());

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    video.src = url;
  });
}

/** Load a same-origin video URL prepared by the bridge for browser seeking. */
export function loadVideoUrl(url: string, label: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const removeListeners = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const release = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: Error | DOMException) => {
      if (settled) return;
      settled = true;
      removeListeners();
      release();
      reject(error);
    };
    const onLoaded = () => {
      if (settled) return;
      settled = true;
      removeListeners();
      resolve(video);
    };
    const onError = () => fail(new Error(`Could not decode ${label}`));
    const onAbort = () => fail(abortError());

    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    video.src = url;
  });
}

export interface ExtractOptions {
  fps: number;
  maxSeconds: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

function seekVideo(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (Math.abs(video.currentTime - time) < 0.001) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      signal?.removeEventListener('abort', onAbort);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = window.setTimeout(onSeeked, 2500);
    try {
      video.currentTime = time;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Seek through a loaded video and collect RGB565 frames (contain fit). */
export async function extractVideoFrames(
  video: HTMLVideoElement,
  opts: ExtractOptions,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const seconds = Math.max(0.1, Math.min(duration, opts.maxSeconds));
  const total = Math.max(1, Math.floor(seconds * opts.fps));
  const frames: Uint8Array<ArrayBuffer>[] = [];
  const [, ctx] = createOledCanvas();
  const resumeAt = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  try {
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw abortError();
      const t = (i / Math.max(total - 1, 1)) * seconds;
      await seekVideo(video, t, opts.signal);
      if (opts.signal?.aborted) throw abortError();
      drawFit(ctx, video, OLED_SPEC.width, OLED_SPEC.height, 'contain');
      frames.push(rgb565FromImageData(ctx.getImageData(0, 0, OLED_SPEC.width, OLED_SPEC.height)));
      opts.onProgress?.(i + 1, total);
    }
    return frames;
  } finally {
    if (!opts.signal?.aborted) {
      video.currentTime = resumeAt;
      if (!wasPaused) void video.play().catch(() => {});
    }
  }
}

/** Seek and deliver one RGB565 frame at a time without retaining the clip in memory. */
export async function streamVideoFrames(
  video: HTMLVideoElement,
  opts: ExtractOptions,
  onFrame: (frame: Uint8Array<ArrayBuffer>, index: number, total: number) => Promise<void>,
): Promise<number> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const requestedSeconds = opts.maxSeconds > 0 ? opts.maxSeconds : duration;
  const seconds = Math.max(0.1, Math.min(duration, requestedSeconds));
  const total = Math.max(1, Math.floor(seconds * opts.fps));
  const [, ctx] = createOledCanvas();
  const resumeAt = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  try {
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw abortError();
      const time = (i / Math.max(total - 1, 1)) * seconds;
      await seekVideo(video, time, opts.signal);
      if (opts.signal?.aborted) throw abortError();
      drawFit(ctx, video, OLED_SPEC.width, OLED_SPEC.height, 'contain');
      const frame = rgb565FromImageData(ctx.getImageData(0, 0, OLED_SPEC.width, OLED_SPEC.height));
      await onFrame(frame, i, total);
      opts.onProgress?.(i + 1, total);
    }
    return total;
  } finally {
    if (!opts.signal?.aborted) {
      video.currentTime = resumeAt;
      if (!wasPaused) void video.play().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* Bridge client + in-browser simulator                                */
/* ------------------------------------------------------------------ */

// A first full frame can take several seconds on a conservative UART path;
// match the Rust bridge command deadline instead of aborting a valid transfer.
const FETCH_TIMEOUT_MS = 35_000;
const STATUS_TIMEOUT_MS = 5_000;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class BridgeClient implements OledClient {
  readonly kind = 'bridge' as const;

  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private async request(path: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(this.url(path), { ...init, signal: ctrl.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }

  async status(): Promise<BridgeStatus> {
    try {
      const res = await this.request('/api/status', undefined, STATUS_TIMEOUT_MS);
      if (!res.ok) {
        return { live: true, connected: false, displayOn: false, brightness: 100, job: 'unknown', simulated: false, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as Record<string, unknown>;
      const workerOk = data.ok !== false;
      return {
        live: workerOk,
        connected: true,
        displayOn: data.display_on !== false,
        brightness: typeof data.brightness === 'number' ? data.brightness : 100,
        job: (data.job as BridgeStatus['job']) ?? 'unknown',
        simulated: data.simulated === true,
        device: typeof data.device === 'string' ? data.device : undefined,
        uptimeSec: typeof data.uptime_sec === 'number' ? data.uptime_sec : undefined,
        error: typeof data.error === 'string' ? data.error : workerOk ? undefined : 'display worker reported an error',
      };
    } catch (e) {
      return { live: true, connected: false, displayOn: false, brightness: 100, job: 'unknown', simulated: false, error: errMessage(e) };
    }
  }

  async setPower(on: boolean): Promise<BridgeStatus> {
    const base = await this.status();
    if (!base.connected) return base;
    try {
      const res = await this.request(`/api/display/${on ? 'on' : 'off'}`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ...base,
        live: res.ok && data.ok !== false,
        connected: res.ok,
        displayOn: typeof data.display_on === 'boolean' ? data.display_on : on,
        job: (data.job as BridgeStatus['job']) ?? base.job,
        simulated: typeof data.simulated === 'boolean' ? data.simulated : base.simulated,
        error: res.ok
          ? undefined
          : typeof data.error === 'string'
            ? data.error
            : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ...base, connected: false, error: errMessage(e) };
    }
  }

  async setBrightness(percent: number): Promise<BridgeStatus> {
    const base = await this.status();
    if (!base.connected) return base;
    try {
      const res = await this.request('/api/display/brightness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ...base,
        live: res.ok && data.ok !== false,
        connected: res.ok,
        brightness: typeof data.brightness === 'number' ? data.brightness : base.brightness,
        job: (data.job as BridgeStatus['job']) ?? base.job,
        error: res.ok
          ? undefined
          : typeof data.error === 'string'
            ? data.error
            : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ...base, connected: false, error: errMessage(e) };
    }
  }

  async sendFrame(bytes: Uint8Array<ArrayBuffer>): Promise<SendResult> {
    try {
      const res = await this.request('/api/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return res.ok
        ? { ok: true, simulated: data.simulated === true }
        : {
            ok: false,
            simulated: data.simulated === true,
            error: typeof data.error === 'string' ? data.error : `Bridge returned HTTP ${res.status}`,
          };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }

  async sendFile(file: File): Promise<SendResult> {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await this.request('/api/image', { method: 'POST', body: fd });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return res.ok
        ? { ok: true, simulated: data.simulated === true }
        : {
            ok: false,
            simulated: data.simulated === true,
            error: typeof data.error === 'string' ? data.error : `Bridge returned HTTP ${res.status}`,
          };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }

  async resolveYoutube(url: string): Promise<YoutubeVideo> {
    const res = await this.request(
      '/api/youtube',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
      130_000,
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : `Bridge returned HTTP ${res.status}`);
    }
    if (typeof data.token !== 'string' || typeof data.stream_url !== 'string') {
      throw new Error('Bridge returned an invalid YouTube video response');
    }
    return {
      token: data.token,
      title: typeof data.title === 'string' && data.title ? data.title : 'YouTube video',
      streamUrl: this.url(data.stream_url),
    };
  }

  async releaseYoutube(token: string): Promise<void> {
    try {
      await this.request('/api/youtube/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      /* Runtime files are also removed on service restart. */
    }
  }

  async stop(): Promise<void> {
    try {
      await this.request('/api/stop', { method: 'POST' });
    } catch {
      /* best effort */
    }
  }
}

const simulatorClient: OledClient = {
  kind: 'simulator',
  status: async () => ({ live: false, connected: true, displayOn: true, brightness: 100, job: 'idle', simulated: true }),
  setPower: async (on) => ({ live: false, connected: true, displayOn: on, brightness: 100, job: 'idle', simulated: true }),
  setBrightness: async (brightness) => ({ live: false, connected: true, displayOn: true, brightness, job: 'idle', simulated: true }),
  sendFrame: async () => ({ ok: true, simulated: true }),
  sendFile: async () => ({ ok: true, simulated: true }),
  resolveYoutube: async () => {
    throw new Error('Connect to asterctl-web before loading a YouTube link');
  },
  releaseYoutube: async () => {},
  stop: async () => {},
};

export function createOledClient(baseUrl: string | null): OledClient {
  const url = baseUrl?.trim();
  return url ? new BridgeClient(url) : simulatorClient;
}

/* ------------------------------------------------------------------ */
/* Stats dashboard frame renderer (960×376 canvas)                     */
/* ------------------------------------------------------------------ */

export type StatsTheme = 'dark' | 'light' | 'cyan' | 'amber';

export interface StatsWidgets {
  cpu: boolean;
  ram: boolean;
  temp: boolean;
  net: boolean;
  clock: boolean;
  hostname: boolean;
  uptime: boolean;
  load: boolean;
}

interface StatsThemeColors {
  bg: string;
  panel: string;
  text: string;
  sub: string;
  accent: string;
  tick: string;
  line: string;
  danger: string;
}

/** Card-style palettes — orange is the primary accent (per the card reference). */
const THEMES: Record<StatsTheme, StatsThemeColors> = {
  dark: { bg: '#0b0f1a', panel: '#151b2e', text: '#f4f5f7', sub: '#8b95ab', accent: '#ef4d23', tick: 'rgba(255,255,255,0.12)', line: '#232b3f', danger: '#f87171' },
  light: { bg: '#f5f2ee', panel: '#ffffff', text: '#111827', sub: '#6b7280', accent: '#ef4d23', tick: 'rgba(17,24,39,0.1)', line: '#e7e3dc', danger: '#dc2626' },
  cyan: { bg: '#04101a', panel: '#0a2030', text: '#d7f3fb', sub: '#5e9db4', accent: '#22d3ee', tick: 'rgba(34,211,238,0.16)', line: '#0e3142', danger: '#fb7185' },
  amber: { bg: '#150f04', panel: '#241a09', text: '#fdf3d7', sub: '#a8885a', accent: '#f59e0b', tick: 'rgba(245,158,11,0.18)', line: '#3a2a10', danger: '#f87171' },
};

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export interface StatsFrameOptions {
  widgets: StatsWidgets;
  theme: StatsTheme;
  hostname: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Ring gauge — a smooth 180° arc (π → 2π, over the top) drawn as a stroked
 * ring with rounded caps, instead of discrete ticks. `value` is a 0-100
 * percentage; the active arc sweeps clockwise from the left end.
 */
function drawRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  width: number,
  value: number,
  activeColor: string,
  trackColor: string,
  centerText: string,
  centerColor: string,
  danger = false,
) {
  const frac = Math.min(1, Math.max(0, value / 100));
  const start = Math.PI;
  const end = start + frac * Math.PI;
  ctx.lineCap = 'round';
  // Track ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, Math.PI * 2);
  ctx.strokeStyle = trackColor;
  ctx.lineWidth = width;
  ctx.stroke();
  // Active arc
  if (frac > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = danger ? '#f87171' : activeColor;
    ctx.stroke();
  }
  // Value inside the ring's opening
  ctx.fillStyle = centerColor;
  let valueSize = 22;
  ctx.font = `600 ${valueSize}px "Space Grotesk", sans-serif`;
  const valueWidth = r * 1.55;
  while (valueSize > 15 && ctx.measureText(centerText).width > valueWidth) {
    valueSize -= 1;
    ctx.font = `600 ${valueSize}px "Space Grotesk", sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(centerText, cx, cy + 16);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Render the card-style stats dashboard into a 960×376 canvas. */
export function renderStatsFrame(ctx: CanvasRenderingContext2D, t: TelemetryLike, opts: StatsFrameOptions) {
  const { widgets, theme, hostname } = opts;
  const th = THEMES[theme];
  const W = OLED_SPEC.width;
  const H = OLED_SPEC.height;

  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);

  const now = new Date();
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });

  // Header card
  if (widgets.hostname || widgets.clock) {
    ctx.fillStyle = th.panel;
    roundRectPath(ctx, 24, 20, W - 48, 58, 16);
    ctx.fill();
    if (widgets.hostname) {
      ctx.fillStyle = th.text;
      ctx.font = '600 22px "Space Grotesk", "Figtree", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(hostname, 42, 49);
    }
    if (widgets.clock) {
      ctx.textAlign = 'right';
      ctx.fillStyle = th.accent;
      ctx.font = '500 26px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(timeStr, W - 42, 42);
      ctx.fillStyle = th.sub;
      ctx.font = '500 14px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(dateStr, W - 42, 66);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = th.line;
    ctx.fillRect(24, 94, W - 48, 1);
  }

  // Metric cards — each a rounded panel with a semicircle gauge.
  // `gauge` is a normalized 0-100 value; `minLabel`/`maxLabel` describe the
  // card's real scale so the readout stays honest (like the card reference's
  // "389K / 425K" end labels).
  interface MetricCard {
    key: 'cpu' | 'ram' | 'temp' | 'net';
    x: number;
    y: number;
    w: number;
    h: number;
    gauge: number;
    minLabel: string;
    maxLabel: string;
    unitLabel?: string;
  }
  const observedNetworkMbps = Math.max(1, t.rx, t.tx);
  const requestedNetworkScale = t.networkScaleMbps;
  const networkMaxMbps =
    requestedNetworkScale != null && Number.isFinite(requestedNetworkScale) && requestedNetworkScale >= 1
      ? requestedNetworkScale
      : 10 ** Math.ceil(Math.log10(observedNetworkMbps));
  const cards: MetricCard[] = [];
  const active = [widgets.cpu, widgets.ram, widgets.temp, widgets.net].filter(Boolean).length || 1;
  const gap = 16;
  const cw = (W - 48 - gap * (active - 1)) / active;
  const cy = 110;
  const chh = 186;
  let cx0 = 24;
  const ramPct = t.memTotalGb > 0 ? (t.memUsedGb / t.memTotalGb) * 100 : 0;
  if (widgets.cpu) cards.push({ key: 'cpu', x: cx0, y: cy, w: cw, h: chh, gauge: t.cpu, minLabel: '0', maxLabel: '100%' }), (cx0 += cw + gap);
  if (widgets.ram) cards.push({ key: 'ram', x: cx0, y: cy, w: cw, h: chh, gauge: ramPct, minLabel: '0', maxLabel: '100%' }), (cx0 += cw + gap);
  if (widgets.temp) cards.push({ key: 'temp', x: cx0, y: cy, w: cw, h: chh, gauge: (t.cpuTemp - 30) / 0.6, minLabel: '30°', maxLabel: '90°' }), (cx0 += cw + gap);
  if (widgets.net) cards.push({ key: 'net', x: cx0, y: cy, w: cw, h: chh, gauge: (t.rx / networkMaxMbps) * 100, minLabel: '0', maxLabel: `${networkMaxMbps}`, unitLabel: 'MB/s' });

  const networkRate = (mbps: number, compact = false) => {
    if (mbps < 1) {
      const kbps = mbps * 1000;
      if (kbps === 0) return compact ? '0K' : '0 KB/s';
      if (kbps < 0.1) return compact ? '<0.1K' : '<0.1 KB/s';
      const value = kbps < 10 ? kbps.toFixed(1) : kbps.toFixed(0);
      return compact ? `${value}K` : `${value} KB/s`;
    }
    return compact ? mbps.toFixed(1) : `${mbps.toFixed(1)} MB/s`;
  };

  for (const card of cards) {
    ctx.fillStyle = th.panel;
    roundRectPath(ctx, card.x, card.y, card.w, card.h, 16);
    ctx.fill();

    // Keep every label/value inside its own metric card even if a future font
    // fallback measures wider than the bundled fonts.
    ctx.save();
    roundRectPath(ctx, card.x, card.y, card.w, card.h, 16);
    ctx.clip();

    const gcx = card.x + card.w / 2;
    const gcy = card.y + 88;
    const r = Math.min(56, card.w * 0.26);
    const ringWidth = Math.max(9, Math.round(r * 0.2));

    ctx.fillStyle = th.accent;
    ctx.font = '600 13px "Space Grotesk", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(card.key.toUpperCase(), card.x + 20, card.y + 26);
    if (card.unitLabel) {
      ctx.fillStyle = th.sub;
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(card.unitLabel, card.x + card.w - 20, card.y + 25);
      ctx.textAlign = 'left';
    }

    if (card.key === 'cpu') {
      drawRing(ctx, gcx, gcy, r, ringWidth, card.gauge, th.accent, th.tick, `${t.cpu.toFixed(0)}%`, th.text, t.cpu > 90);
      ctx.fillStyle = th.sub;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`load ${t.loadAvg[0].toFixed(2)}`, gcx, card.y + 156);
      ctx.textAlign = 'left';
    } else if (card.key === 'ram') {
      drawRing(ctx, gcx, gcy, r, ringWidth, card.gauge, th.accent, th.tick, `${t.memUsedGb.toFixed(1)}G`, th.text, ramPct > 85);
      ctx.fillStyle = th.sub;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${ramPct.toFixed(0)}% of ${t.memTotalGb.toFixed(0)}G`, gcx, card.y + 156);
      ctx.textAlign = 'left';
    } else if (card.key === 'temp') {
      drawRing(ctx, gcx, gcy, r, ringWidth, card.gauge, th.accent, th.tick, `${t.cpuTemp.toFixed(0)}°`, th.text, t.cpuTemp > 82);
      ctx.fillStyle = th.sub;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`nvme ${t.nvmeTemp.toFixed(0)}°C`, gcx, card.y + 156);
      ctx.textAlign = 'left';
    } else if (card.key === 'net') {
      drawRing(ctx, gcx, gcy, r, ringWidth, card.gauge, th.accent, th.tick, `↓${networkRate(t.rx, true)}`, th.text);
      ctx.fillStyle = th.sub;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`↑ ${networkRate(t.tx)}`, gcx, card.y + 156);
      ctx.textAlign = 'left';
    }

    // Min/max end labels at the ring's two ends (like the card reference)
    ctx.fillStyle = th.sub;
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(card.minLabel, card.x + 18, gcy + 4);
    ctx.textAlign = 'right';
    ctx.fillText(card.maxLabel, card.x + card.w - 18, gcy + 4);
    ctx.restore();
  }

  // Footer strip
  ctx.fillStyle = th.panel;
  roundRectPath(ctx, 24, H - 62, W - 48, 42, 16);
  ctx.fill();
  const footItems: string[] = [];
  if (widgets.uptime) {
    footItems.push(
      t.uptimeSec != null
        ? `up ${Math.floor(t.uptimeSec / 86400)}d ${pad(Math.floor((t.uptimeSec % 86400) / 3600))}:${pad(Math.floor((t.uptimeSec % 3600) / 60))}`
        : 'up 00:00:00',
    );
  }
  if (widgets.load) footItems.push(`load ${t.loadAvg.join(' / ')}`);
  ctx.fillStyle = th.sub;
  ctx.font = '500 15px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let fx = 42;
  for (const item of footItems) {
    ctx.fillText(item, fx, H - 41);
    fx += ctx.measureText(item).width + 36;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Minimal telemetry shape consumed by the stats renderer. */
export interface TelemetryLike {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  cpuTemp: number;
  nvmeTemp: number;
  rx: number;
  tx: number;
  loadAvg: [number, number, number];
  networkLive: boolean;
  networkScaleMbps?: number;
  uptimeSec?: number;
}

export function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
