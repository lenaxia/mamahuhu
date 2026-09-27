import { useCallback, useEffect, useState } from "react";
import type { Entry } from "../../shared/api";
import { api, ApiError } from "../api";
import { EntryCard } from "../components/EntryCard";
import { Segmented } from "../components/Segmented";
import { Sheet } from "../components/Sheet";
import { IconPlay, IconTrash } from "../components/Icons";
import { AnnotatedText } from "../components/AnnotatedText";
import { useAnnotations } from "../state";
import { speak } from "../tts";
import { useToast } from "../components/Toast";

export function WordsScreen(): React.JSX.Element {
  const annotations = useAnnotations();
  const show = useToast().show;
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Entry | null>(null);
  const [notesDraft, setNotesDraft] = useState("");

  const load = useCallback(async (scope: "mine" | "all", q: string): Promise<void> => {
    setLoading(true);
    try {
      setItems(await api.entries(scope, q.trim() || undefined));
    } catch (e) {
      show(e instanceof ApiError ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    const t = setTimeout(() => void load(scope, q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [scope, q, load]);

  async function remove(e: Entry): Promise<void> {
    if (!confirm("Delete this word?")) return;
    try {
      await api.deleteEntry(e.id);
      setOpen(null);
      show("Deleted");
      void load(scope, q);
    } catch {
      show("Delete failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search hanzi, pinyin, English…"
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3.5 py-2.5 text-sm outline-none focus:border-amber-500"
        />
        <Segmented<"mine" | "all">
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "mine", label: "Mine" },
            { value: "all", label: "Everyone" },
          ]}
        />
      </div>

      {loading && items.length === 0 && <div className="animate-pulse text-sm text-neutral-400">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center text-sm text-neutral-400">
          {q ? "Nothing matches that search." : scope === "mine" ? "Nothing saved yet — ask something first!" : "No one has saved words yet."}
        </div>
      )}

      <div className="space-y-2.5">
        {items.map((e) => (
          <div key={e.id} className="space-y-1">
            <EntryCard
              entry={e}
              onOpen={() => {
                setOpen(e);
                setNotesDraft(e.notes ?? "");
              }}
            />
            {scope === "all" && <div className="px-1 text-[11px] text-neutral-400">{e.userName}</div>}
          </div>
        ))}
      </div>

      <Sheet open={open !== null} onClose={() => setOpen(null)}>
        {open && (
          <div className="space-y-4">
            <AnnotatedText syllables={open.syllables.length ? open.syllables : [[{ h: open.traditional, py: open.pinyin, bpmf: open.bpmf }]]} annotations={annotations} />
            <p className="text-[15px] text-neutral-700 dark:text-neutral-300">{open.english || "—"}</p>
            {open.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {open.tags.map((t) => (
                  <span key={t} className="rounded-full bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5">{open.register}</span>
              <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5">{open.source}</span>
              <span>{new Date(open.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => speak(open.traditional)}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800"
                aria-label="Play"
              >
                <IconPlay className="h-5 w-5" />
              </button>
              <button
                onClick={() => speak(open.traditional, { slow: true })}
                className="flex h-11 items-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-3 text-xs font-semibold text-neutral-500"
              >
                0.6×
              </button>
              <button
                onClick={() => void remove(open)}
                className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-50 dark:bg-red-950/50 text-red-500"
                aria-label="Delete"
              >
                <IconTrash className="h-5 w-5" />
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-400">notes</label>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={async () => {
                  if (notesDraft !== (open.notes ?? "")) {
                    const updated = await api.patchEntry(open.id, { notes: notesDraft });
                    setOpen(updated);
                    void load(scope, q);
                  }
                }}
                rows={3}
                placeholder="e.g. he says this when…"
                className="w-full rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3 text-sm outline-none focus:border-amber-500"
              />
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
