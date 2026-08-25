import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Search, Settings2 } from 'lucide-react';
import {
  GIPHY_API_KEY_STORAGE,
  GIPHY_CUSTOMER_ID_STORAGE,
  downloadGiphyGif,
  pingGiphy,
  requestGiphy,
  requestGiphyCustomerId,
} from '../lib/giphy';
import type { GiphyItem, GiphyPage } from '../lib/giphy';

function storedValue(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function storeValue(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing/storage policy must not make the picker unusable.
  }
}

export default function GiphyPicker({
  onPick,
  onError,
}: {
  onPick: (file: File, item: GiphyItem) => void;
  onError: (message: string) => void;
}) {
  const [apiKey, setApiKey] = useState(() => storedValue(GIPHY_API_KEY_STORAGE));
  const [draftKey, setDraftKey] = useState(() => storedValue(GIPHY_API_KEY_STORAGE));
  const [customerId, setCustomerId] = useState(() => storedValue(GIPHY_CUSTOMER_ID_STORAGE));
  const [editingKey, setEditingKey] = useState(() => !storedValue(GIPHY_API_KEY_STORAGE));
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const seenIds = useRef(new Set<string>());
  const onErrorRef = useRef(onError);
  const customerIdRef = useRef(customerId);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    customerIdRef.current = customerId;
  }, [customerId]);

  const load = useCallback(
    async (searchQuery: string, offset = 0, append = false) => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      append ? setLoadingMore(true) : setLoading(true);
      setError(null);
      try {
        const page: GiphyPage = await requestGiphy(apiKey, {
          query: searchQuery,
          offset,
          customerId: customerIdRef.current,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setNextOffset(page.nextOffset);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (!append) setItems([]);
        onErrorRef.current(message);
      } finally {
        if (searchAbort.current === controller) {
          searchAbort.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [apiKey],
  );

  useEffect(() => {
    if (!apiKey) return;
    void load('', 0, false);
    return () => searchAbort.current?.abort();
  }, [apiKey, load]);

  useEffect(() => {
    if (!apiKey || customerId) return;
    const controller = new AbortController();
    requestGiphyCustomerId(apiKey, controller.signal)
      .then((id) => {
        setCustomerId(id);
        storeValue(GIPHY_CUSTOMER_ID_STORAGE, id);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [apiKey, customerId]);

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      downloadAbort.current?.abort();
    },
    [],
  );

  const saveKey = () => {
    const key = draftKey.trim();
    if (!key) return;
    storeValue(GIPHY_API_KEY_STORAGE, key);
    if (key !== apiKey) {
      storeValue(GIPHY_CUSTOMER_ID_STORAGE, '');
      setCustomerId('');
      setItems([]);
      setSelectedId(null);
    }
    setApiKey(key);
    setEditingKey(false);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey || loading) return;
    const nextQuery = query.trim().slice(0, 50);
    setSubmittedQuery(nextQuery);
    void load(nextQuery, 0, false);
  };

  const select = async (item: GiphyItem) => {
    downloadAbort.current?.abort();
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloadingId(item.id);
    setError(null);
    pingGiphy(item, 'onclick', customerId || null);
    try {
      const file = await downloadGiphyGif(item, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedId(item.id);
      onPick(file, item);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onErrorRef.current(message);
    } finally {
      if (downloadAbort.current === controller) {
        downloadAbort.current = null;
        setDownloadingId(null);
      }
    }
  };

  const markSeen = (item: GiphyItem) => {
    if (seenIds.current.has(item.id)) return;
    seenIds.current.add(item.id);
    pingGiphy(item, 'onload', customerId || null);
  };

  if (editingKey || !apiKey) {
    return (
      <div className="space-y-3 rounded-xl bg-[var(--c-soft-60)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--c-surface)] text-[var(--c-accent-text)] shadow-[var(--shadow-card)]">
            <KeyRound className="h-4 w-4" strokeWidth={1.8} />
          </div>
          <div>
            <p className="text-xs font-semibold text-[var(--c-text)]">Connect GIPHY search</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--c-text-2)]">
              Add a free Web API key once. It stays in this browser and is sent directly to GIPHY, never to the
              OLED bridge.
            </p>
          </div>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            saveKey();
          }}
        >
          <label className="sr-only" htmlFor="giphy-api-key">
            GIPHY API key
          </label>
          <input
            id="giphy-api-key"
            type="password"
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="GIPHY Web API key"
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 font-mono text-[11px] text-[var(--c-text)] outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            disabled={!draftKey.trim()}
            className="h-9 rounded-lg bg-emerald-500 px-4 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            Save &amp; browse
          </button>
          {apiKey && (
            <button
              type="button"
              onClick={() => {
                setDraftKey(apiKey);
                setEditingKey(false);
              }}
              className="h-9 rounded-lg px-3 text-[11px] font-medium text-[var(--c-text-2)] hover:bg-[var(--c-soft)]"
            >
              Cancel
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--c-text-3)]">
          <span>G-rated results · key stored locally per browser</span>
          <a
            href="https://developers.giphy.com/dashboard/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[var(--c-accent-text)] hover:underline"
          >
            Create API key <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href="https://giphy.com/"
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-black tracking-[0.08em] text-[var(--c-text)] hover:text-[var(--c-accent-text)]"
        >
          POWERED BY GIPHY
        </a>
        <button
          type="button"
          onClick={() => {
            setDraftKey(apiKey);
            setEditingKey(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium text-[var(--c-text-3)] hover:bg-[var(--c-soft)] hover:text-[var(--c-text)]"
        >
          <Settings2 className="h-3 w-3" /> Change key
        </button>
      </div>

      <form className="flex gap-2" onSubmit={submit}>
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--c-text-3)]" />
          <span className="sr-only">Search GIPHY</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 50))}
            placeholder="Search reactions, moods, characters…"
            maxLength={50}
            className="h-10 w-full rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-surface)] pl-9 pr-3 text-xs text-[var(--c-text)] outline-none focus:border-emerald-500"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="flex h-10 items-center gap-1.5 rounded-xl bg-emerald-500 px-4 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Search
        </button>
      </form>

      <div className="flex items-center justify-between text-[10px] text-[var(--c-text-3)]">
        <span>{submittedQuery ? `Results for “${submittedQuery}”` : 'Trending now'}</span>
        <span>Click a GIF to prepare it</span>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-[var(--c-danger-bg)] px-3 py-2 text-[11px] text-[var(--c-danger-text)]">
          {error}
        </p>
      )}

      {loading ? (
        <div className="grid grid-cols-3 gap-2" aria-label="Loading GIPHY results">
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index} className="aspect-[4/3] animate-pulse rounded-lg bg-[var(--c-soft)]" />
          ))}
        </div>
      ) : items.length > 0 ? (
        <div className="grid grid-cols-3 gap-2" aria-live="polite">
          {items.map((item) => {
            const selected = item.id === selectedId;
            const downloading = item.id === downloadingId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void select(item)}
                disabled={downloadingId !== null}
                aria-pressed={selected}
                aria-label={`Select ${item.title}${item.creator ? ` by ${item.creator}` : ''}`}
                className={`group relative aspect-[4/3] overflow-hidden rounded-lg bg-black text-left outline-none ring-offset-2 ring-offset-[var(--c-surface)] transition-[transform,box-shadow] hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait ${
                  selected ? 'ring-2 ring-emerald-500' : ''
                }`}
              >
                <img
                  src={item.previewUrl}
                  alt={item.altText}
                  loading="lazy"
                  onLoad={() => markSeen(item)}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-5 text-[9px] font-medium text-white/90">
                  {item.creator ?? item.title}
                </span>
                {(selected || downloading) && (
                  <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg">
                    {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        !error && <p className="py-6 text-center text-[11px] text-[var(--c-text-3)]">No GIFs found.</p>
      )}

      {nextOffset !== null && !loading && (
        <button
          type="button"
          onClick={() => void load(submittedQuery, nextOffset, true)}
          disabled={loadingMore}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--c-soft)] text-[11px] font-medium text-[var(--c-text-2)] hover:text-[var(--c-text)] disabled:opacity-50"
        >
          {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
