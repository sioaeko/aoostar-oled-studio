export interface SpotifyTrack {
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  url: string;
}

export interface SpotifyStatus {
  connected: boolean;
  enabled: boolean;
  client_id: string;
  track: SpotifyTrack | null;
  message: string;
  error: string | null;
}

export const SPOTIFY_CALLBACK = 'http://127.0.0.1:17879/callback';

export function spotifyEndpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/api/spotify/${path}`;
}

export async function spotifyRequest<T>(base: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(spotifyEndpoint(base, path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(typeof value?.error === 'string' ? value.error : `Spotify service: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function validClientId(value: string): boolean { return /^[a-f\d]{32}$/i.test(value.trim()); }

// Never turn arbitrary API strings into navigable URLs.
export function spotifyAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://accounts.spotify.com' || url.pathname !== '/authorize') throw new Error('Unexpected Spotify sign-in address.');
  return url.href;
}
