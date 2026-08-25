export const GIPHY_API_KEY_STORAGE = 'oled-studio.giphy-api-key.v1';
export const GIPHY_CUSTOMER_ID_STORAGE = 'oled-studio.giphy-customer-id.v1';

const GIPHY_API_ROOT = 'https://api.giphy.com/v1';
const GIPHY_RESULT_LIMIT = 18;
const MAX_GIF_BYTES = 32 * 1024 * 1024;

type GiphyAnalyticsEvent = 'onload' | 'onclick' | 'onsent';

export interface GiphyItem {
  id: string;
  title: string;
  altText: string;
  previewUrl: string;
  displayUrl: string;
  downloadUrl: string;
  width: number;
  height: number;
  sizeBytes?: number;
  pageUrl?: string;
  creator?: string;
  analytics: Partial<Record<GiphyAnalyticsEvent, string>>;
}

export interface GiphyPage {
  items: GiphyItem[];
  offset: number;
  count: number;
  totalCount: number;
  nextOffset: number | null;
}

interface GiphyRequestOptions {
  query?: string;
  offset?: number;
  customerId?: string;
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function rendition(images: Record<string, unknown>, names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    const candidate = record(images[name]);
    if (candidate && stringValue(candidate.url)) return candidate;
  }
  return null;
}

function analyticsUrl(raw: Record<string, unknown> | null, event: GiphyAnalyticsEvent): string | undefined {
  const eventValue = record(raw?.[event]);
  const url = stringValue(eventValue?.url);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'giphy-analytics.giphy.com' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeGiphyItem(value: unknown): GiphyItem | null {
  const raw = record(value);
  const images = record(raw?.images);
  const id = stringValue(raw?.id);
  if (!raw || !images || !id) return null;

  const preview = rendition(images, ['fixed_width_small', 'fixed_width', 'downsized']);
  const display = rendition(images, ['downsized', 'downsized_medium', 'fixed_width', 'original']);
  const download = rendition(images, ['downsized', 'downsized_medium', 'original']);
  const previewUrl = stringValue(preview?.url);
  const displayUrl = stringValue(display?.url);
  const downloadUrl = stringValue(download?.url);
  if (!previewUrl || !displayUrl || !downloadUrl) return null;

  const user = record(raw.user);
  const analytics = record(raw.analytics);
  const title = stringValue(raw.title) ?? 'Untitled GIF';
  return {
    id,
    title,
    altText: stringValue(raw.alt_text) ?? title,
    previewUrl,
    displayUrl,
    downloadUrl,
    width: numberValue(download?.width) ?? numberValue(display?.width) ?? 0,
    height: numberValue(download?.height) ?? numberValue(display?.height) ?? 0,
    sizeBytes: numberValue(download?.size),
    pageUrl: stringValue(raw.url),
    creator: stringValue(user?.display_name) ?? stringValue(user?.username),
    analytics: {
      onload: analyticsUrl(analytics, 'onload'),
      onclick: analyticsUrl(analytics, 'onclick'),
      onsent: analyticsUrl(analytics, 'onsent'),
    },
  };
}

export function normalizeGiphyPage(value: unknown): GiphyPage {
  const raw = record(value);
  const meta = record(raw?.meta);
  const status = numberValue(meta?.status);
  if (!raw || status !== 200) {
    throw new Error(stringValue(meta?.msg) ?? 'GIPHY returned an invalid response');
  }

  const pagination = record(raw.pagination);
  const offset = numberValue(pagination?.offset) ?? 0;
  const count = numberValue(pagination?.count) ?? 0;
  const totalCount = numberValue(pagination?.total_count) ?? count;
  const items = Array.isArray(raw.data)
    ? raw.data.map(normalizeGiphyItem).filter((item): item is GiphyItem => item !== null)
    : [];
  const next = offset + count;

  return {
    items,
    offset,
    count,
    totalCount,
    nextOffset: count > 0 && next < totalCount ? next : null,
  };
}

export async function requestGiphy(apiKey: string, options: GiphyRequestOptions = {}): Promise<GiphyPage> {
  const key = apiKey.trim();
  if (!key) throw new Error('Enter a GIPHY API key first');

  const query = options.query?.trim() ?? '';
  const endpoint = query ? 'gifs/search' : 'gifs/trending';
  const url = new URL(`${GIPHY_API_ROOT}/${endpoint}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('limit', String(GIPHY_RESULT_LIMIT));
  url.searchParams.set('offset', String(options.offset ?? 0));
  url.searchParams.set('rating', 'g');
  url.searchParams.set('bundle', 'messaging_non_clips');
  if (options.customerId?.trim()) url.searchParams.set('customer_id', options.customerId.trim());
  if (query) {
    url.searchParams.set('q', query.slice(0, 50));
    url.searchParams.set('lang', 'ko');
  }

  const response = await fetch(url, { signal: options.signal, cache: 'no-store' });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const meta = record(record(payload)?.meta);
    const detail = stringValue(meta?.msg);
    if (response.status === 401 || response.status === 403) {
      throw new Error(detail ?? 'GIPHY rejected this API key');
    }
    if (response.status === 429) throw new Error('GIPHY API limit reached. Try again later.');
    throw new Error(detail ?? `GIPHY returned HTTP ${response.status}`);
  }
  return normalizeGiphyPage(payload);
}

export async function requestGiphyCustomerId(apiKey: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(`${GIPHY_API_ROOT}/randomid`);
  url.searchParams.set('api_key', apiKey.trim());
  const response = await fetch(url, { signal, cache: 'no-store' });
  const payload = record((await response.json().catch(() => null)) as unknown);
  const randomId = stringValue(record(payload?.data)?.random_id);
  if (!response.ok || !randomId) throw new Error('Could not create a GIPHY analytics ID');
  return randomId;
}

export async function downloadGiphyGif(item: GiphyItem, signal?: AbortSignal): Promise<File> {
  const response = await fetch(item.downloadUrl, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`GIF download returned HTTP ${response.status}`);

  const advertisedSize = numberValue(response.headers.get('content-length'));
  if (advertisedSize !== undefined && advertisedSize > MAX_GIF_BYTES) {
    throw new Error('This GIF exceeds the 32 MiB upload limit');
  }

  const blob = await response.blob();
  if (blob.size > MAX_GIF_BYTES) throw new Error('This GIF exceeds the 32 MiB upload limit');
  if (blob.type && blob.type !== 'image/gif') throw new Error(`GIPHY returned ${blob.type}, not a GIF`);
  return new File([blob], `giphy-${item.id}.gif`, { type: 'image/gif', lastModified: Date.now() });
}

export function pingGiphy(item: GiphyItem, event: GiphyAnalyticsEvent, customerId: string | null): void {
  const trackingUrl = item.analytics[event];
  if (!trackingUrl || !customerId) return;
  try {
    const url = new URL(trackingUrl);
    url.searchParams.set('customer_id', customerId);
    url.searchParams.set('ts', String(Date.now()));
    void fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', keepalive: true }).catch(() => {});
  } catch {
    // Analytics must never block GIF selection or playback.
  }
}
