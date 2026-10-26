import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Music2, Unplug } from 'lucide-react';
import { SPOTIFY_CALLBACK, spotifyAuthorizationUrl, spotifyEndpoint, spotifyRequest, validClientId } from '../lib/spotify';
import type { SpotifyStatus } from '../lib/spotify';
import type { PanelSource } from './OledPanel';
import type { PushLog } from './OledShared';

interface Props {
  bridgeUrl: string;
  available: boolean;
  simulated: boolean;
  onSource: (source: PanelSource | null) => void;
  pushLog: PushLog;
}

const INPUT = 'h-10 w-full min-w-0 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-soft)] px-3 text-xs text-[var(--c-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500';
const BUTTON = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-50';

export default function OledSpotifyTab({ bridgeUrl, available, simulated, onSource, pushLog }: Props) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [callback, setCallback] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [sample, setSample] = useState(false);

  useEffect(() => {
    if (!available) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const value = await spotifyRequest<SpotifyStatus>(bridgeUrl, 'status');
        if (!disposed) {
          setStatus(value);
          setPollError('');
          setClientId(previous => previous || value.client_id);
        }
      } catch {
        if (!disposed) setPollError('Spotify status unavailable. Check the bridge connection.');
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [available, bridgeUrl]);

  useEffect(() => {
    if (!available) { onSource(null); return; }
    let disposed = false;
    let timer = 0;
    let objectUrl: string | null = null;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(spotifyEndpoint(bridgeUrl, sample ? 'sample.png' : 'preview.png'), { cache: 'no-store', signal: abort.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        if (disposed) return;
        const next = URL.createObjectURL(blob);
        const image = new Image();
        image.src = next;
        try { await image.decode(); } catch { URL.revokeObjectURL(next); return; }
        if (disposed) { URL.revokeObjectURL(next); return; }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        onSource({ el: image, fit: 'contain' });
      } catch {
        // Preserve the last frame during a temporary connection failure.
      } finally {
        if (!disposed && !sample) timer = window.setTimeout(load, 2000);
      }
    };
    void load();
    return () => { disposed = true; abort.abort(); window.clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); onSource(null); };
  }, [available, bridgeUrl, sample, onSource]);

  const action = async (task: () => Promise<void>) => {
    setPending(true); setError('');
    try { await task(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Spotify request failed. Try again.'); }
    finally { setPending(false); }
  };

  return <div className="space-y-5">
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--c-text)]"><Music2 className="h-4 w-4" />Spotify display</h2>
      <p className="mt-2 text-xs leading-relaxed text-[var(--c-text-2)]">Album artwork, title, artist and a timeline. Display only — keep listening and controlling playback on your phone or PC.</p>
    </div>
    {!available ? <p className="rounded-lg bg-[var(--c-soft)] p-3 text-xs text-[var(--c-text-2)]">Connect to the OLED bridge first. Spotify runs on the server, not in this browser.</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--c-border)] py-3">
        <div className="min-w-0 text-xs" role="status">
          <p className="font-semibold text-[var(--c-text)]">{status?.enabled ? 'Spotify display active' : status?.connected ? 'Spotify connected' : 'Spotify not connected'}</p>
          <p className="mt-1 break-words text-[var(--c-text-2)] [overflow-wrap:anywhere]">{status?.track ? `${status.track.title} — ${status.track.artist}` : status?.message || 'Connect your account to get started.'}</p>
        </div>
        <button type="button" className={BUTTON} disabled={pending || !status?.connected} onClick={() => void action(async () => {
          const enabled = !status?.enabled;
          const next = await spotifyRequest<SpotifyStatus>(bridgeUrl, 'mode', { enabled });
          setStatus(next); setSample(false);
          pushLog('Spotify display', enabled ? 'Server display enabled; resumes after restart' : 'Display updates stopped', true, simulated);
        })}>{pending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{status?.enabled ? 'Stop display' : 'Show on panel'}</button>
      </div>
      <p className="text-xs leading-relaxed text-[var(--c-text-2)]">Once enabled, this screen keeps updating with the browser closed and resumes when the service starts. Sending another mode or switching the display off stops Spotify updates.</p>
      {status?.track?.url && <a className="inline-flex items-center gap-1 text-xs text-emerald-700 underline dark:text-emerald-400" href={status.track.url} target="_blank" rel="noreferrer">Open this track in Spotify <ExternalLink className="h-3 w-3" /></a>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="text-xs font-semibold text-[var(--c-text-2)] underline underline-offset-4" aria-pressed={sample} onClick={() => setSample(value => !value)}>{sample ? 'Return to live preview' : 'Preview sample layout'}</button>
        {sample && <span className="text-xs text-amber-700 dark:text-amber-400">Sample artwork · preview only · not sent to the panel</span>}
      </div>
      <details open={!status?.connected} className="border-t border-[var(--c-border)] pt-3">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--c-text)]">{status?.connected ? 'Connection settings' : 'Connect your Spotify account'}</summary>
        <div className="mt-4 space-y-4 text-xs text-[var(--c-text-2)]">
          <p className="leading-relaxed">Create a Web API app in the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-400">Spotify Developer Dashboard</a> using your Premium account. Add your account to the app’s user allowlist if needed.</p>
          <label className="block space-y-1.5"><span>Register this Redirect URI exactly</span><input className={`${INPUT} font-mono`} value={SPOTIFY_CALLBACK} readOnly onFocus={event => event.target.select()} /></label>
          <label className="block space-y-1.5"><span>Client ID <span className="text-[var(--c-text-3)]">(not the client secret)</span></span><input className={`${INPUT} font-mono`} value={clientId} onChange={event => setClientId(event.target.value)} maxLength={32} autoComplete="off" spellCheck={false} placeholder="32-character Client ID" /></label>
          <button type="button" className={BUTTON} disabled={pending || !validClientId(clientId)} onClick={() => void action(async () => {
            const value = await spotifyRequest<{ authorization_url: string }>(bridgeUrl, 'auth/start', { client_id: clientId.trim() });
            setAuthorization(spotifyAuthorizationUrl(value.authorization_url)); setCallback('');
          })}>Prepare Spotify sign-in</button>
          {authorization && <div className="space-y-3 rounded-lg bg-[var(--c-soft)] p-4">
            <a className="inline-flex items-center gap-2 font-semibold text-emerald-700 underline dark:text-emerald-400" href={authorization} target="_blank" rel="noreferrer">Sign in with Spotify <ExternalLink className="h-3.5 w-3.5" /></a>
            <p className="leading-relaxed">After approval, the new tab may show “connection refused” at 127.0.0.1. This is expected: copy that tab’s entire address and paste it below within 10 minutes. No public server or port forwarding is needed.</p>
            <label className="block space-y-1.5"><span>Returned address (contains a one-time code; do not share it)</span><input type="password" className={INPUT} value={callback} onChange={event => setCallback(event.target.value)} autoComplete="off" spellCheck={false} maxLength={8192} placeholder="Paste the full http://127.0.0.1:17879/callback?… address" /></label>
            <button type="button" className={BUTTON} disabled={pending || !callback} onClick={() => void action(async () => {
              const address = callback; setCallback(''); setAuthorization('');
              const next = await spotifyRequest<SpotifyStatus>(bridgeUrl, 'auth/complete', { callback_url: address });
              setStatus(next); pushLog('Spotify', 'Account connected with read-only playback permission', true, simulated);
            })}>Finish connection</button>
          </div>}
          <p className="leading-relaxed">Only read access to your current playback is requested. Tokens stay in the service’s private state directory, never in browser storage. Use this on a trusted LAN; the bridge has no user authentication.</p>
          {status?.connected && <button type="button" className="inline-flex min-h-10 items-center gap-2 text-xs text-red-700 dark:text-red-400" disabled={pending} onClick={() => void action(async () => {
            setStatus(await spotifyRequest<SpotifyStatus>(bridgeUrl, 'disconnect', {})); setCallback(''); setAuthorization(''); setSample(false);
            pushLog('Spotify', 'Saved connection removed; revoke app access in Spotify to invalidate old tokens', true, simulated);
          })}><Unplug className="h-3.5 w-3.5" />Disconnect and remove saved credentials</button>}
        </div>
      </details>
    </>}
    {(error || pollError || status?.error) && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-xs leading-relaxed text-red-700 dark:text-red-300">{error || pollError || status?.error}</p>}
  </div>;
}
