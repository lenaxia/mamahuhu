import { useEffect, useState, type ReactNode } from "react";
import { IconClose } from "./Icons";

/** Bottom sheet — the mobile interaction primitive for details/settings. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
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

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-black/45 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-2xl bg-white dark:bg-neutral-900
        px-4 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl transition-transform duration-200
        ${visible ? "translate-y-0" : "translate-y-full"}`}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        {title !== undefined && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">{title}</h2>
            <button aria-label="Close" onClick={onClose} className="rounded-full p-2 -mr-2 text-neutral-500">
              <IconClose className="h-5 w-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
