import { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import {
  OLED_SPEC,
  createOledCanvas,
  fmtBytes,
  rgb565FromCanvas,
} from '../lib/oled';
import type { OledClient } from '../lib/oled';
import type { PanelSource } from './OledPanel';
import type { PushLog } from './OledShared';

const COLORS = [
  { id: 'cyan', value: '#22d3ee' },
  { id: 'green', value: '#34d399' },
  { id: 'amber', value: '#f59e0b' },
  { id: 'red', value: '#f87171' },
  { id: 'violet', value: '#a78bfa' },
  { id: 'white', value: '#f3f4f6' },
];

const FRAME_GAP_MS = 650;

interface OledTextTabProps {
  client: OledClient;
  pushLog: PushLog;
  onSource: (s: PanelSource | null) => void;
}

export default function OledTextTab({ client, pushLog, onSource }: OledTextTabProps) {
  const [text, setText] = useState('Hello, WTR MAX!');
  const [size, setSize] = useState(56);
  const [color, setColor] = useState('#22d3ee');
  const [scroll, setScroll] = useState(true);
  const [streaming, setStreaming] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const colorRef = useRef(color);
  colorRef.current = color;

  // Render loop — static centered text, or a right-to-left marquee when
  // scrolling is enabled.
  useEffect(() => {
    const [canvas, ctx] = createOledCanvas();
    canvasRef.current = canvas;
    ctxRef.current = ctx;
    onSource({ el: canvas });
    let raf = 0;
    let x = OLED_SPEC.width;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, OLED_SPEC.width, OLED_SPEC.height);
      ctx.font = `600 ${sizeRef.current}px "Space Grotesk", "Figtree", sans-serif`;
      ctx.fillStyle = colorRef.current;
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(textRef.current).width;
      if (scroll) {
        x -= 2.4;
        if (x + w < 0) x = OLED_SPEC.width;
        ctx.fillText(textRef.current, x, OLED_SPEC.height / 2);
      } else {
        ctx.fillText(textRef.current, (OLED_SPEC.width - w) / 2, OLED_SPEC.height / 2);
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      onSource(null);
      canvasRef.current = null;
      ctxRef.current = null;
    };
  }, [scroll, onSource]);

  // Streaming — push frames while scrolling text across the panel.
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    let timer = 0;
    let nextTarget = performance.now();
    const send = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bytes = rgb565FromCanvas(canvas);
      const r = await client.sendFrame(bytes);
      if (cancelled) return;
      pushLog('Scrolling text', fmtBytes(bytes.length) + ' frame', r.ok, r.simulated ?? client.kind === 'simulator', r.error);
      nextTarget += FRAME_GAP_MS;
      if (nextTarget < performance.now()) {
        const missed = Math.floor((performance.now() - nextTarget) / FRAME_GAP_MS) + 1;
        nextTarget += missed * FRAME_GAP_MS;
      }
      timer = window.setTimeout(send, Math.max(0, nextTarget - performance.now()));
    };
    void send();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void client.stop();
    };
  }, [streaming, client, pushLog]);

  const sendStatic = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bytes = rgb565FromCanvas(canvas);
    const r = await client.sendFrame(bytes);
    pushLog('Text', `${textRef.current} · ${fmtBytes(bytes.length)}`, r.ok, r.simulated ?? client.kind === 'simulator', r.error);
  };

  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={80}
        placeholder="Text to show on the panel…"
        className="w-full resize-none rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-2 text-sm text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-3)] focus:border-emerald-500"
      />

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--c-text-2)]">
        <label className="flex items-center gap-2">
          Size
          <input
            type="range"
            min={24}
            max={120}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-28 accent-emerald-500"
          />
          <span className="w-8 font-mono tabular-nums text-[var(--c-text-3)]">{size}px</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={scroll}
            onChange={(e) => setScroll(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          Scroll (marquee)
        </label>
      </div>

      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--c-text-3)]">Color</p>
        <div className="flex gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setColor(c.value)}
              aria-pressed={color === c.value}
              aria-label={`Text color ${c.id}`}
              className={`h-7 w-7 rounded-full transition-transform ${
                color === c.value ? 'scale-110 ring-2 ring-[var(--c-accent-text)] ring-offset-2 ring-offset-[var(--c-surface)]' : 'hover:scale-105'
              }`}
              style={{ backgroundColor: c.value }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void sendStatic()}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600"
        >
          <Play className="h-3 w-3" strokeWidth={2} />
          {client.kind === 'simulator' ? 'Simulate' : 'Send to display'}
        </button>
        {scroll && (
          <button
            type="button"
            onClick={() => setStreaming((v) => !v)}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold transition-colors ${
              streaming
                ? 'bg-[var(--c-danger-bg)] text-[var(--c-danger-text)] hover:opacity-90'
                : 'bg-[var(--c-soft)] text-[var(--c-text-2)] hover:bg-[var(--c-border-strong)]'
            }`}
          >
            {streaming ? <Square className="h-3 w-3" strokeWidth={2} /> : <Play className="h-3 w-3" strokeWidth={2} />}
            {streaming ? 'Stop streaming' : client.kind === 'simulator' ? 'Simulate scroll' : 'Stream scrolling text'}
          </button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
        Static text is one frame; scrolling text streams frames at link cadence so the marquee moves on the real panel.
      </p>
    </div>
  );
}
