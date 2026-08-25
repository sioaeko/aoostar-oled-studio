import { useEffect, useRef, useState } from 'react';
import { Film, FolderUp, Image as ImageIcon, Link2, Loader2, Play, Sparkles, Square, Upload } from 'lucide-react';
import {
  OLED_SPEC,
  createOledCanvas,
  disposeVideoFile,
  drawFit,
  fmtBytes,
  isAbortError,
  loadImageFile,
  loadVideoFile,
  loadVideoUrl,
  rgb565FromCanvas,
  streamVideoFrames,
} from '../lib/oled';
import type { FitMode, OledClient } from '../lib/oled';
import { GIPHY_CUSTOMER_ID_STORAGE, pingGiphy } from '../lib/giphy';
import type { GiphyItem } from '../lib/giphy';
import GiphyPicker from './GiphyPicker';
import type { PanelSource } from './OledPanel';
import { FileDrop, LinkNote } from './OledShared';
import type { PushLog } from './OledShared';

const waitUntil = (target: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Operation cancelled', 'AbortError'));
      return;
    }
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Operation cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, target - performance.now()));
  });

/* ------------------------------------------------------------------ */
/* GIF                                                                 */
/* ------------------------------------------------------------------ */

export function GifTab({
  client,
  pushLog,
  onSource,
}: {
  client: OledClient;
  pushLog: PushLog;
  onSource: (s: PanelSource | null) => void;
}) {
  const [sourceMode, setSourceMode] = useState<'local' | 'giphy'>('local');
  const [file, setFile] = useState<File | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [giphyItem, setGiphyItem] = useState<GiphyItem | null>(null);
  const [sending, setSending] = useState(false);
  const [playing, setPlaying] = useState(false);

  const pick = (f: File, item: GiphyItem | null = null) => {
    setFile(f);
    setGiphyItem(item);
    setImg(null);
    loadImageFile(f)
      .then((el) => {
        setImg(el);
        onSource({ el });
      })
      .catch((e) => pushLog('GIF', e instanceof Error ? e.message : String(e), false, client.kind === 'simulator'));
  };

  useEffect(() => () => onSource(null), [onSource]);

  const send = async () => {
    if (!file) return;
    setSending(true);
    const r = await client.sendFile(file);
    setPlaying(r.ok);
    if (r.ok && giphyItem) {
      let customerId: string | null = null;
      try {
        customerId = window.localStorage.getItem(GIPHY_CUSTOMER_ID_STORAGE);
      } catch {
        // Playback succeeds even when browser storage is unavailable.
      }
      pingGiphy(giphyItem, 'onsent', customerId);
    }
    pushLog(
      'GIF',
      r.ok
        ? `${giphyItem ? `${giphyItem.title} · GIPHY` : file.name} · ${fmtBytes(file.size)} · bridge loops source-timed frames at link cadence`
        : `${file.name} — ${r.error ?? 'failed'}`,
      r.ok,
      r.simulated ?? client.kind === 'simulator',
      r.error,
    );
    setSending(false);
  };

  const stop = async () => {
    setSending(true);
    await client.stop();
    setPlaying(false);
    setSending(false);
    pushLog('GIF', 'Loop stopped', true, client.kind === 'simulator');
  };

  return (
    <div className="space-y-4">
      <div className="flex rounded-xl bg-[var(--c-soft-60)] p-1">
        {([
          { id: 'local' as const, label: 'My files', icon: FolderUp },
          { id: 'giphy' as const, label: 'Search GIPHY', icon: Sparkles },
        ]).map((option) => {
          const Icon = option.icon;
          const active = sourceMode === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setSourceMode(option.id)}
              aria-pressed={active}
              className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-[var(--c-surface)] text-[var(--c-accent-text)] shadow-[var(--shadow-card)]'
                  : 'text-[var(--c-text-2)] hover:bg-[var(--c-soft)] hover:text-[var(--c-text)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
              {option.label}
            </button>
          );
        })}
      </div>

      {sourceMode === 'local' ? (
        <FileDrop
          accept="image/gif,image/png,image/jpeg"
          onFile={(selected) => pick(selected)}
          icon={Upload}
          hint="Upload a GIF (or image)"
          compact
        />
      ) : (
        <GiphyPicker
          onPick={(selected, item) => pick(selected, item)}
          onError={(message) => pushLog('GIPHY', message, false, client.kind === 'simulator', message)}
        />
      )}
      {img && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--c-soft-60)] px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-[var(--c-text)]">
              {giphyItem?.title ?? file?.name}
            </p>
            <p className="text-[10px] text-[var(--c-text-3)]">
              {fmtBytes(file?.size ?? 0)} · {img.naturalWidth}×{img.naturalHeight}
              {giphyItem ? ' · GIPHY' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={playing ? () => void stop() : send}
            disabled={sending}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : playing ? <Square className="h-3 w-3" strokeWidth={2} /> : <Play className="h-3 w-3" strokeWidth={2} />}
            {playing ? 'Stop GIF loop' : client.kind === 'simulator' ? 'Simulate loop' : 'Loop on display'}
          </button>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
        The bridge decodes the GIF server-side and repeats every frame in source order until Stop or another mode
        replaces it. Slow UART transfers reduce animation speed but no longer skip ahead through the loop.
      </p>
      <LinkNote />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Video                                                               */
/* ------------------------------------------------------------------ */

export function VideoTab({
  client,
  pushLog,
  onSource,
}: {
  client: OledClient;
  pushLog: PushLog;
  onSource: (s: PanelSource | null) => void;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [name, setName] = useState<string>('');
  const [fps, setFps] = useState(2);
  const [maxSec, setMaxSec] = useState(30);
  const [loopVideo, setLoopVideo] = useState(true);
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'sending'>('idle');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const youtubeTokenRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      runAbortRef.current?.abort();
      runAbortRef.current = null;
      if (videoRef.current) {
        disposeVideoFile(videoRef.current);
        videoRef.current = null;
      }
      if (youtubeTokenRef.current) {
        void client.releaseYoutube(youtubeTokenRef.current);
        youtubeTokenRef.current = null;
      }
      void client.stop();
      onSource(null);
    },
    [client, onSource],
  );

  const pick = (f: File) => {
    loadAbortRef.current?.abort();
    runAbortRef.current?.abort();
    void client.stop();
    if (videoRef.current) {
      disposeVideoFile(videoRef.current);
      videoRef.current = null;
    }
    if (youtubeTokenRef.current) {
      void client.releaseYoutube(youtubeTokenRef.current);
      youtubeTokenRef.current = null;
    }
    setVideo(null);
    onSource(null);
    setName(f.name);
    const controller = new AbortController();
    loadAbortRef.current = controller;
    loadVideoFile(f, controller.signal)
      .then((el) => {
        if (controller.signal.aborted) {
          disposeVideoFile(el);
          return;
        }
        videoRef.current = el;
        setVideo(el);
        onSource({ el });
      })
      .catch((e) => {
        if (!isAbortError(e)) {
          pushLog('Video', e instanceof Error ? e.message : String(e), false, client.kind === 'simulator');
        }
      })
      .finally(() => {
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
      });
  };

  const loadYoutube = async () => {
    const url = youtubeUrl.trim();
    if (!url || youtubeLoading) return;
    loadAbortRef.current?.abort();
    runAbortRef.current?.abort();
    void client.stop();
    if (videoRef.current) {
      disposeVideoFile(videoRef.current);
      videoRef.current = null;
    }
    if (youtubeTokenRef.current) {
      await client.releaseYoutube(youtubeTokenRef.current);
      youtubeTokenRef.current = null;
    }
    setVideo(null);
    onSource(null);
    setName('Preparing YouTube video…');
    setYoutubeLoading(true);
    const controller = new AbortController();
    loadAbortRef.current = controller;
    try {
      const resolved = await client.resolveYoutube(url);
      if (controller.signal.aborted) {
        await client.releaseYoutube(resolved.token);
        return;
      }
      youtubeTokenRef.current = resolved.token;
      const el = await loadVideoUrl(resolved.streamUrl, resolved.title, controller.signal);
      if (controller.signal.aborted) {
        disposeVideoFile(el);
        await client.releaseYoutube(resolved.token);
        youtubeTokenRef.current = null;
        return;
      }
      videoRef.current = el;
      setVideo(el);
      setName(resolved.title);
      onSource({ el });
      pushLog('YouTube', `${resolved.title} · ready for OLED frame extraction`, true, false);
    } catch (e) {
      if (!isAbortError(e)) {
        const message = e instanceof Error ? e.message : String(e);
        pushLog('YouTube', message, false, client.kind === 'simulator', message);
      }
    } finally {
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
      setYoutubeLoading(false);
    }
  };

  const stream = async () => {
    if (!video) return;
    runAbortRef.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    runAbortRef.current = controller;
    setPhase('sending');
    setProgress({ done: 0, total: 0 });
    try {
      let sent = 0;
      let simulated = client.kind === 'simulator';
      let currentCycle = 0;
      let rejected: string | null = null;
      pushLog(
        'Video',
        `${maxSec === 0 ? 'Full video' : `First ${maxSec} s`} streaming${loopVideo ? ' · looping until Stop' : ''}`,
        true,
        simulated,
      );
      do {
        currentCycle += 1;
        setCycle(currentCycle);
        let nextTarget = performance.now();
        await streamVideoFrames(
          video,
          {
            fps,
            maxSeconds: maxSec,
            signal,
            onProgress: (done, total) => {
              if (!signal.aborted) setProgress({ done, total });
            },
          },
          async (frame, index, total) => {
            const r = await client.sendFrame(frame);
            if (signal.aborted) return;
            simulated = r.simulated ?? simulated;
            if (!r.ok) {
              rejected = r.error ?? 'bridge error';
              throw new Error(`frame ${index + 1}/${total} rejected — ${rejected}`);
            }
            sent += 1;
            if (simulated) {
              nextTarget += 1000 / fps;
              await waitUntil(nextTarget, signal);
            }
          },
        );
      } while (loopVideo && !signal.aborted && !rejected);
      if (signal.aborted) return;
      pushLog(
        'Video',
        `${sent} frames streamed · ${fps} fps source · ${fmtBytes(OLED_SPEC.bytesPerFrame)}/frame`,
        sent > 0,
        simulated,
      );
    } catch (e) {
      if (!isAbortError(e) && !signal.aborted) {
        pushLog('Video', e instanceof Error ? e.message : String(e), false, client.kind === 'simulator');
      }
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null;
        setPhase('idle');
      }
    }
  };

  const stop = () => {
    runAbortRef.current?.abort();
    void client.stop();
  };

  const clipSeconds = maxSec === 0 ? video?.duration ?? 0 : Math.min(video?.duration ?? 0, maxSec);
  const totalFrames = Math.max(1, Math.floor(clipSeconds * fps));
  const busy = phase !== 'idle';
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <FileDrop accept="video/mp4,video/webm,video/quicktime,video/*" onFile={pick} icon={Film} hint="Upload a video (mp4 / webm)" compact />
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--c-border)]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--c-text-3)]">or YouTube</span>
        <span className="h-px flex-1 bg-[var(--c-border)]" />
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void loadYoutube();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--c-text-3)]" strokeWidth={1.8} />
          <input
            type="url"
            value={youtubeUrl}
            onChange={(event) => setYoutubeUrl(event.target.value)}
            disabled={youtubeLoading}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube video URL"
            className="h-9 w-full rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] pl-9 pr-3 font-mono text-[11px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-3)] focus:border-emerald-500 disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={!youtubeUrl.trim() || youtubeLoading || client.kind === 'simulator'}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--c-soft)] px-3 text-[11px] font-semibold text-[var(--c-text)] transition-colors hover:bg-[var(--c-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {youtubeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" strokeWidth={2} />}
          {youtubeLoading ? 'Preparing…' : 'Load'}
        </button>
      </form>
      <p className="text-[10px] leading-relaxed text-[var(--c-text-3)]">
        The Proxmox service prepares one YouTube video at a time in private runtime storage; playlists are ignored.
      </p>
      {video && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--c-soft-60)] px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-[var(--c-text)]">{name}</p>
              <p className="text-[10px] text-[var(--c-text-3)]">
                {Number.isFinite(video.duration) ? `${video.duration.toFixed(1)} s` : '…'} · {video.videoWidth}×
                {video.videoHeight}
              </p>
            </div>
            <button
              type="button"
              onClick={busy ? stop : () => void stream()}
              disabled={!video}
              className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                busy
                  ? 'bg-[var(--c-danger-bg)] text-[var(--c-danger-text)] hover:opacity-90'
                  : 'bg-emerald-500 text-white hover:bg-emerald-600'
              }`}
            >
              {busy ? <Square className="h-3 w-3" strokeWidth={2} /> : <Play className="h-3 w-3" strokeWidth={2} />}
              {busy ? 'Stop' : client.kind === 'simulator' ? 'Simulate' : 'Stream to display'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--c-text-2)]">
            <label className="flex items-center gap-2">
              Source fps
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                disabled={busy}
                className="rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1.5 text-[11px] text-[var(--c-text)] outline-none focus:border-emerald-500 disabled:opacity-50"
              >
                {[1, 2, 5].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              Clip
              <select
                value={maxSec}
                onChange={(e) => setMaxSec(Number(e.target.value))}
                disabled={busy}
                className="rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1.5 text-[11px] text-[var(--c-text)] outline-none focus:border-emerald-500 disabled:opacity-50"
              >
                {[10, 30, 60, 0].map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? 'Full video' : `${v} s`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={loopVideo}
                onChange={(event) => setLoopVideo(event.target.checked)}
                disabled={busy}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              Loop clip
            </label>
            <span className="font-mono text-[10px] text-[var(--c-text-3)]">
              ≈ {totalFrames} frames · {fmtBytes(totalFrames * OLED_SPEC.bytesPerFrame)}
            </span>
          </div>

          {busy && (
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-[var(--c-text-3)]">
                <span>Streaming to display{loopVideo ? ` · loop ${cycle}` : ''}…</span>
                <span className="font-mono tabular-nums">
                  {progress.done}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--c-track-bar)]">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
            Frames are extracted and sent one at a time, so long clips no longer fill browser memory. Full-frame
            changes take about 1.3 s in upstream measurements; partial updates can be much faster.
          </p>
          <LinkNote />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Image                                                               */
/* ------------------------------------------------------------------ */

export function ImageTab({
  client,
  pushLog,
  onSource,
  fit,
}: {
  client: OledClient;
  pushLog: PushLog;
  onSource: (s: PanelSource | null) => void;
  fit: FitMode;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [name, setName] = useState<string>('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (img) onSource({ el: img, fit });
    return () => onSource(null);
  }, [fit, img, onSource]);

  const pick = (f: File) => {
    setName(f.name);
    loadImageFile(f)
      .then((el) => {
        setImg(el);
      })
      .catch((e) => pushLog('Image', e instanceof Error ? e.message : String(e), false, client.kind === 'simulator'));
  };

  const send = async () => {
    if (!img) return;
    setSending(true);
    try {
      const [canvas, ctx] = createOledCanvas();
      drawFit(ctx, img, OLED_SPEC.width, OLED_SPEC.height, fit);
      const bytes = rgb565FromCanvas(canvas);
      const r = await client.sendFrame(bytes);
      pushLog('Image', `${name} · ${fmtBytes(bytes.length)} frame`, r.ok, r.simulated ?? client.kind === 'simulator', r.error);
    } catch (e) {
      pushLog('Image', e instanceof Error ? e.message : String(e), false, client.kind === 'simulator');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDrop accept="image/png,image/jpeg,image/webp,image/*" onFile={pick} icon={ImageIcon} hint="Upload a static image (png / jpg)" compact />
      {img && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--c-soft-60)] px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-[var(--c-text)]">{name}</p>
            <p className="text-[10px] text-[var(--c-text-3)]">
              {img.naturalWidth}×{img.naturalHeight} · fit {fit}
            </p>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" strokeWidth={2} />}
            {client.kind === 'simulator' ? 'Simulate' : 'Send to display'}
          </button>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
        The image is resized to {OLED_SPEC.width}×{OLED_SPEC.height} honoring the fit setting and sent as one RGB565
        frame.
      </p>
    </div>
  );
}
