import { useEffect, useState, type ReactNode } from "react";
import { IconClose } from "./Icons";

/** Full-screen overlay for media (photo viewer) — immersive, scrollable body. */
export function FullScreen({
  open,
  onClose,
  children,
  label,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  /** quiet action buttons (e.g. delete) rendered in the top bar */
  actions?: ReactNode;
}): React.JSX.Element {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!mounted) return <></>;

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950">
      <div
        className={`absolute inset-0 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
            <span className="px-2 text-[11px] uppercase tracking-widest text-neutral-500">{label}</span>
            <div className="flex items-center gap-1.5">
              {actions}
              <button
                aria-label="Close"
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white"
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
        </div>
      </div>
    </div>
  );
}
