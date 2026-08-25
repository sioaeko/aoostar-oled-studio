import { useEffect, useRef } from 'react';
import { OLED_SPEC, applyRgb565PreviewInPlace, drawFit } from '../lib/oled';
import type { FitMode } from '../lib/oled';

export interface PanelSource {
  /** Live-drawn source — an <img> (animated GIF), <video>, or offscreen canvas. */
  el: CanvasImageSource;
  fit?: FitMode;
}

interface OledPanelProps {
  source: PanelSource | null;
  power: boolean;
  rotate180?: boolean;
  /** Simulation hint shown on the bezel when no bridge is configured. */
  simulated?: boolean;
  softwareBrightness?: number;
}

/**
 * Simulated AOOSTAR WTR MAX front panel — a bezel-framed 960×376 display that
 * redraws the provided source every animation frame, so GIFs and videos play
 * at their native speed exactly as they will be pushed to the real panel.
 */
export default function OledPanel({ source, power, rotate180 = false, simulated = false, softwareBrightness = 100 }: OledPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Redraw loop — draws the source (or black) at 60fps so animated content
  // (GIFs, video elements, marquee canvases) stays live.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, OLED_SPEC.width, OLED_SPEC.height);
      if (power && source) {
        if (rotate180) {
          ctx.translate(OLED_SPEC.width, OLED_SPEC.height);
          ctx.rotate(Math.PI);
        }
        drawFit(ctx, source.el, OLED_SPEC.width, OLED_SPEC.height, source.fit ?? 'contain');
      }
      ctx.restore();
      if (power && source) {
        const preview = ctx.getImageData(0, 0, OLED_SPEC.width, OLED_SPEC.height);
        applyRgb565PreviewInPlace(preview.data, softwareBrightness);
        ctx.putImageData(preview, 0, 0);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [source, power, rotate180, softwareBrightness]);

  // Autoplay/pause video sources alongside the power state.
  useEffect(() => {
    const el = source?.el;
    if (!(el instanceof HTMLVideoElement)) return;
    if (power) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
    return () => el.pause();
  }, [source, power]);

  return (
    <div className="select-none">
      {/* Bezel */}
      <div className="rounded-[26px] bg-[linear-gradient(150deg,#343a36,#0e120e)] p-3 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/10 sm:p-4">
        {/* Screen */}
        <div className="relative overflow-hidden rounded-[10px] bg-black">
          <canvas
            ref={canvasRef}
            width={OLED_SPEC.width}
            height={OLED_SPEC.height}
            className="block w-full"
            style={{
              aspectRatio: `${OLED_SPEC.width} / ${OLED_SPEC.height}`,
            }}
            aria-label="OLED display preview"
          />
          {/* Glass reflection */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.02)_28%,transparent_40%,transparent_78%,rgba(255,255,255,0.05)_100%)]"
          />
          {!power && (
            <div aria-hidden className="absolute inset-0 bg-black/95" />
          )}
        </div>

        {/* Bezel footer */}
        <div className="mt-2.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                power ? (simulated ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-zinc-600'
              }`}
            />
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              {simulated ? 'Simulator' : 'WTR MAX'}
            </span>
          </div>
          <span className="font-mono text-[10px] tracking-wider text-zinc-500">
            {OLED_SPEC.width}×{OLED_SPEC.height} · RGB565
          </span>
        </div>
      </div>
    </div>
  );
}
