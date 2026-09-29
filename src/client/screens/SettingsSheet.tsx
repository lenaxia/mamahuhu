import { useEffect, useState } from "react";
import type { Annotations, Me, Variety } from "../../shared/api";
import { api } from "../api";
import { BpmfColumn } from "../components/AnnotatedText";
import { Segmented } from "../components/Segmented";
import { Sheet } from "../components/Sheet";
import { ttsInfo } from "../tts";
import { useMe } from "../state";

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const { me, setMe } = useMe();
  const [name, setName] = useState(me?.name ?? "");
  const [audienceDraft, setAudienceDraft] = useState(me?.audience ?? "");

  useEffect(() => {
    if (open && me) {
      setName(me.name);
      setAudienceDraft(me.audience ?? "");
    }
  }, [open, me]);

  if (!me) return <></>;

  const patch = (p: Parameters<typeof api.patchMe>[0]): void => {
    api.patchMe(p).then(setMe).catch(() => {});
  };

  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="space-y-6">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-400">name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="your name"
            className="w-full rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 outline-none focus:border-amber-500"
          />
          {me.nameFromProxy ? (
            <p className="mt-1 text-[11px] text-neutral-400">defaults to your proxy login name — editable</p>
          ) : (
            <p className="mt-1 text-[11px] text-neutral-400">
              dev identity — behind forward-auth (TRUST_PROXY_HEADERS=1 + AUTH_HEADER) this becomes your login name
            </p>
          )}
        </div>

        <AnnotationPicker value={me.annotations} onChange={(annotations) => patch({ annotations })} />

        <VarietiesPicker me={me} onChange={(p) => patch(p)} />

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-400">fine-tune translations</label>
          <input
            value={audienceDraft}
            onChange={(e) => setAudienceDraft(e.target.value)}
            onBlur={() => {
              const next = audienceDraft.trim() || null;
              if (next !== me.audience) patch({ audience: next });
            }}
            placeholder="e.g. talking to my 3-year-old"
            className="w-full rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 outline-none focus:border-amber-500"
          />
          <p className="mt-1 text-[11px] text-neutral-400">optional audience hint — shapes register without changing casual/formal</p>
        </div>

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-400">playback speed</label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.6}
              max={1.2}
              step={0.05}
              value={me.ttsSpeed}
              onChange={(e) => patch({ ttsSpeed: Number(e.target.value) })}
              className="flex-1 accent-amber-500"
            />
            <span className="w-10 text-right text-sm tabular-nums text-neutral-500">{me.ttsSpeed.toFixed(2)}×</span>
          </div>
          {!ttsInfo().server && !ttsInfo().zhVoice && (
            <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              No Chinese voice found on this device — audio may sound wrong. Install a zh-TW voice in
              your OS speech settings, or set MODEL_TTS on the server.
            </p>
          )}
        </div>

        <a
          href="/api/export.csv"
          className="block rounded-xl border border-neutral-300 dark:border-neutral-700 px-3.5 py-2.5 text-sm font-medium text-center"
        >
          Export CSV
        </a>

        {import.meta.env.DEV && <DevUserSwitcher />}

        <p className="text-center text-[11px] text-neutral-400">
          Mamahuhu 馬馬虎虎 · v0.4.5
          <br />
          identity comes from your reverse proxy ({me.name})
        </p>
      </div>
    </Sheet>
  );
}

export function AnnotationPicker({
  value,
  onChange,
}: {
  value: Annotations;
  onChange: (a: Annotations) => void;
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wide text-neutral-400">annotations</label>
      <Segmented<Annotations>
        className="w-full [&>button]:flex-1 flex"
        value={value}
        onChange={onChange}
        options={[
          { value: "both", label: "Both" },
          { value: "bpmf", label: "ㄅㄆㄇㄈ" },
          { value: "pinyin", label: "Pinyin" },
        ]}
      />
      <div className="mt-2 flex h-16 items-center justify-center rounded-xl bg-neutral-50 dark:bg-neutral-800/50 overflow-x-auto">
        <span lang="zh-Hant" className="inline-flex items-start gap-1">
          {(["你", "好"] as const).map((h, i) => (
            <span key={h} className="inline-flex flex-col items-center">
              <span className="flex items-start">
                <span className="hanzi text-2xl">{h}</span>
                {value !== "pinyin" && (
                  <BpmfColumn bpmf={["ㄋㄧˇ", "ㄏㄠˇ"][i]!} cls="ml-0.5 mt-1 text-[0.55rem] text-amber-600 dark:text-amber-400" />
                )}
              </span>
              {value !== "bpmf" && (
                <span className="mt-0.5 text-[0.6rem] text-sky-700 dark:text-sky-400">{["nǐ", "hǎo"][i]}</span>
              )}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

export function VarietiesPicker({ me, onChange }: { me: Me; onChange: (p: { varieties: Variety[]; primaryVariety: Variety }) => void }): React.JSX.Element {
  const varieties = me.varieties.length ? me.varieties : ["zh-Hant" as const];
  const both = varieties.length > 1;
  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wide text-neutral-400">varieties</label>
      <div className="space-y-2">
        {([
          { v: "zh-Hant" as const, label: "國語 Mandarin", hint: "Taiwan-style traditional + zhuyin/pinyin" },
          { v: "zh-HK" as const, label: "廣東話 Cantonese", hint: "spoken-first 口語 + jyutping, always audio" },
        ]).map(({ v, label, hint }) => (
          <label key={v} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2.5">
            <input
              type="checkbox"
              checked={varieties.includes(v)}
              onChange={(e) => {
                const next = e.target.checked ? [...varieties, v] : varieties.filter((x) => x !== v);
                if (!next.length) return; // at least one variety
                const primary = next.includes(me.primaryVariety) ? me.primaryVariety : next[0]!;
                onChange({ varieties: next, primaryVariety: primary });
              }}
              className="mt-0.5 h-4 w-4 accent-amber-500"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-[11px] text-neutral-400">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {both && (
        <div className="mt-2">
          <label className="mb-1 block text-[11px] text-neutral-400">default for new asks</label>
          <Segmented<Variety>
            className="w-full [&>button]:flex-1 flex"
            value={me.primaryVariety}
            onChange={(primaryVariety) => onChange({ varieties, primaryVariety })}
            options={[
              { value: "zh-Hant", label: "國語" },
              { value: "zh-HK", label: "粵" },
            ]}
          />
        </div>
      )}
      {varieties.includes("zh-HK") && !ttsInfo().cantoServer && !ttsInfo().hkVoice && (
        <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          No Cantonese voice found — install a zh-HK voice in your OS speech settings for spoken 廣東話.
        </p>
      )}
    </div>
  );
}

function DevUserSwitcher(): React.JSX.Element {
  const current = localStorage.getItem("devUser") ?? "dad";
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-400">dev user switcher</label>
      <div className="flex gap-2">
        {["dad", "mom"].map((u) => (
          <button
            key={u}
            onClick={() => {
              localStorage.setItem("devUser", u);
              location.reload();
            }}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm ${
              current === u ? "border-amber-500 text-amber-600 dark:text-amber-400" : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {u}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Onboarding({ me }: { me: Me }): React.JSX.Element {
  const { setMe } = useMe();
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    setBusy(true);
    try {
      setMe(await api.patchMe({ onboarded: true }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={() => {}} title={undefined}>
      <div className="space-y-5">
        <h2 className="text-lg font-semibold">
          馬馬虎虎 <span className="text-neutral-400">Mamahuhu</span>
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Hi {me.name} — two quick things. You can change them anytime in settings.
        </p>
        <VarietiesPicker me={me} onChange={(p) => void api.patchMe(p).then(setMe)} />
        <AnnotationPicker
          value={me.annotations}
          onChange={(annotations) => void api.patchMe({ annotations }).then(setMe)}
        />
        <button
          onClick={() => void start()}
          disabled={busy}
          className="w-full rounded-xl bg-amber-500 py-3 text-sm font-semibold text-white shadow active:scale-[0.99] transition disabled:opacity-50"
        >
          Start asking
        </button>
      </div>
    </Sheet>
  );
}
