import { describe, expect, test } from 'bun:test';
import { SPOTIFY_CALLBACK, spotifyAuthorizationUrl, spotifyEndpoint, validClientId } from './spotify';

describe('read-only Spotify connection', () => {
  test('uses a fixed loopback callback and normalizes bridge paths', () => {
    expect(SPOTIFY_CALLBACK).toBe('http://127.0.0.1:17879/callback');
    expect(spotifyEndpoint('http://192.168.1.10:8787/', 'status')).toBe('http://192.168.1.10:8787/api/spotify/status');
  });
  test('validates client ids and restricts authorization links', () => {
    expect(validClientId('a'.repeat(32))).toBe(true);
    expect(validClientId('not a client id')).toBe(false);
    expect(spotifyAuthorizationUrl('https://accounts.spotify.com/authorize?state=x')).toContain('/authorize?');
    for (const url of ['javascript:alert(1)', 'http://accounts.spotify.com/authorize', 'https://accounts.spotify.com.evil.test/authorize']) {
      expect(() => spotifyAuthorizationUrl(url)).toThrow();
    }
  });
});
