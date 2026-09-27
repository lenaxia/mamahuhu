import { useEffect, useState } from "react";
import type { HistoryDetail, HistoryItem, HanziRes, Interpretation, OcrRes, SttRes, TranslateRes } from "../../shared/api";
import { api, ApiError } from "../api";
import { InterpretationCard, HanziWordCard, PhraseCard } from "../components/Cards";
import { ResultCard } from "../components/ResultCard";
import { OcrView } from "../components/OcrView";
import { Sheet } from "../components/Sheet";
import { FullScreen } from "../components/FullScreen";
import { IconCamera, IconKeyboard, IconTrash } from "../components/Icons";
import { useToast } from "../components/Toast";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function HistoryScreen(): React.JSX.Element {
  const show = useToast().show;
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<HistoryDetail | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setItems(await api.history());
    } catch {
      show("Couldn't load history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function clearAll(): Promise<void> {
    if (!confirm("Clear all history? Saved words are kept.")) return;
    try {
      await api.clearHistory();
      setOpen(null);
      void load();
    } catch {
      show("Clear failed");
    }
  }

  async function removeOne(id: string): Promise<void> {
    try {
      await api.deleteHistory(id);
      setOpen(null);
      void load();
    } catch {
      show("Delete failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400">everything you asked — saved or not</p>
        {items.length > 0 && (
          <button onClick={() => void clearAll()} className="text-xs text-red-500 underline underline-offset-2">
            clear all
          </button>
        )}
      </div>

      {loading && <div className="animate-pulse text-sm text-neutral-400">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center text-sm text-neutral-400">
          Nothing yet — ask something first!
        </div>
      )}

      <div className="space-y-2">
        {items.map((it) => (
          <button
            key={it.id}
            data-history-item={it.kind}
            onClick={async () => {
              try {
                setOpen(await api.historyDetail(it.id));
              } catch (e) {
                show(e instanceof ApiError ? e.message : "Couldn't open");
              }
            }}
            className="flex w-full items-center gap-3 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 text-left shadow-sm active:scale-[0.99] transition"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
              {it.kind === "ocr" ? <IconCamera className="h-4 w-4" /> : <IconKeyboard className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{it.input || "(photo)"}</span>
              <span className="block text-[11px] text-neutral-400">
                {it.kind} · {ago(it.createdAt)}
              </span>
            </span>
            {it.hasPhoto && <span className="text-[10px] uppercase text-neutral-400">photo</span>}
          </button>
        ))}
      </div>

      {/* photos get the full screen; text stays in the drawer */}
      {open?.kind === "ocr" && open.photoUrl ? (
        <FullScreen
          open
          onClose={() => setOpen(null)}
          label="photo"
          actions={
            <button
              aria-label="Delete entry"
              onClick={() => void removeOne(open.id)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-red-400"
            >
              <IconTrash className="h-5 w-5" />
            </button>
          }
        >
          <OcrView ocrResult={open.result as OcrRes} photoUrl={open.photoUrl} w={open.photoW} h={open.photoH} />
        </FullScreen>
      ) : (
        <Sheet open={open !== null} onClose={() => setOpen(null)} title="From history">
          {open && (
            <div className="space-y-3">
              {open.kind === "translate" && <ResultCard card={open.result as TranslateRes} />}
              {open.kind === "pinyin" &&
                ((open.result as { interpretations: Interpretation[] }).interpretations ?? []).map((it, i) => (
                  <InterpretationCard key={i} interp={it} rank={i + 1} />
                ))}
              {open.kind === "hanzi" &&
                ((open.result as HanziRes).words ?? []).map((wd, i) => <HanziWordCard key={i} word={wd} />)}
              {open.kind === "ocr" && !open.photoUrl && (
                <p className="text-sm text-neutral-400">photo no longer stored</p>
              )}
              <button
                onClick={() => void removeOne(open.id)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-50 dark:bg-red-950/50 py-2.5 text-sm font-medium text-red-500"
              >
                <IconTrash className="h-4 w-4" /> delete this entry
              </button>
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}
