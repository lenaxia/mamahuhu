import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconClose } from "./Icons";

/** Bottom sheet — the mobile interaction primitive for details/settings.
 *  Dismiss by tapping the backdrop, the Close button (titled sheets), or
 *  dragging/swiping DOWN on the sheet body. */
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
  const [drag, setDrag] = useState(0); // px the sheet has been pulled down
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      setDrag(0);
      const t = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!mounted) return null;

  const DRAG_CLOSE = 80; // px of downward pull that commits the dismiss

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-black/45 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        onTouchStart={(e) => {
          // only drag-to-dismiss from the top of the content — otherwise the
          // swipe is a scroll inside the sheet
          startY.current = e.currentTarget.scrollTop <= 0 ? (e.touches[0]?.clientY ?? null) : null;
        }}
        onTouchMove={(e) => {
          if (startY.current === null) return;
          const y = e.touches[0]?.clientY ?? startY.current;
          setDrag(Math.max(0, y - startY.current));
        }}
        onTouchEnd={() => {
          if (startY.current === null) return;
          startY.current = null;
          if (drag > DRAG_CLOSE) onClose();
          else setDrag(0);
        }}
        style={drag > 0 ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white dark:bg-neutral-900
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
