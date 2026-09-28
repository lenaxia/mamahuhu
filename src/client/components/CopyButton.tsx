import { useState } from "react";
import { IconCheck, IconCopy } from "./Icons";
import { useToast } from "./Toast";

/** Copies text to the clipboard with a toast confirmation. Falls back to a
 *  hidden textarea for non-secure contexts (older iOS Safari over http). */
export function CopyButton({
  text,
  className = "",
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}): React.JSX.Element {
  const show = useToast().show;
  const [done, setDone] = useState(false);

  async function copy(): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    show(ok ? "Copied" : "Copy failed");
    if (ok) {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }
  }

  return (
    <button
      aria-label={label}
      onClick={() => void copy()}
      className={`flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 active:scale-95 transition ${className}`}
    >
      {done ? <IconCheck className="h-4 w-4 text-emerald-500" /> : <IconCopy className="h-4 w-4" />}
    </button>
  );
}
