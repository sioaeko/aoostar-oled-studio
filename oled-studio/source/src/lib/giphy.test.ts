import { afterEach, describe, expect, test } from 'bun:test';
import { normalizeGiphyItem, normalizeGiphyPage, requestGiphy } from './giphy';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const item = {
  id: 'abc123',
  title: 'Test GIF',
  alt_text: 'A test animation',
  url: 'https://giphy.com/gifs/abc123',
  user: { display_name: 'Studio' },
  images: {
    fixed_width_small: { url: 'https://media.giphy.com/preview.gif', width: '100', height: '80' },
    downsized: { url: 'https://media.giphy.com/display.gif', width: '500', height: '400', size: '12345' },
  },
  analytics: {
    onload: { url: 'https://giphy-analytics.giphy.com/v2/pingback_simple?action_type=SEEN' },
    onclick: { url: 'https://example.com/not-allowed' },
  },
};

describe('GIPHY response normalization', () => {
  test('keeps provider order and selects GIF renditions', () => {
    const page = normalizeGiphyPage({
      data: [item, { ...item, id: 'second' }],
      pagination: { offset: 18, count: 2, total_count: 25 },
      meta: { status: 200, msg: 'OK', response_id: 'request-id' },
    });

    expect(page.items.map((gif) => gif.id)).toEqual(['abc123', 'second']);
    expect(page.items[0].downloadUrl).toBe('https://media.giphy.com/display.gif');
    expect(page.items[0].sizeBytes).toBe(12345);
    expect(page.nextOffset).toBe(20);
  });

  test('drops malformed items and untrusted analytics URLs', () => {
    expect(normalizeGiphyItem({ id: 'missing-images' })).toBeNull();
    const normalized = normalizeGiphyItem(item);
    expect(normalized?.analytics.onload).toContain('giphy-analytics.giphy.com');
    expect(normalized?.analytics.onclick).toBeUndefined();
  });

  test('surfaces provider errors', () => {
    expect(() => normalizeGiphyPage({ meta: { status: 403, msg: 'Forbidden' } })).toThrow('Forbidden');
  });

  test('calls GIPHY directly with encoded Korean search and a safe rating', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          data: [item],
          pagination: { offset: 0, count: 1, total_count: 1 },
          meta: { status: 200, msg: 'OK', response_id: 'request-id' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const page = await requestGiphy('web-key', {
      query: '고양이 & cat',
      customerId: 'anonymous-browser-id',
    });
    const url = new URL(requestedUrl);
    expect(url.origin).toBe('https://api.giphy.com');
    expect(url.pathname).toBe('/v1/gifs/search');
    expect(url.searchParams.get('q')).toBe('고양이 & cat');
    expect(url.searchParams.get('rating')).toBe('g');
    expect(url.searchParams.get('lang')).toBe('ko');
    expect(url.searchParams.get('bundle')).toBe('messaging_non_clips');
    expect(url.searchParams.get('customer_id')).toBe('anonymous-browser-id');
    expect(url.searchParams.get('api_key')).toBe('web-key');
    expect(page.items).toHaveLength(1);
  });
});
