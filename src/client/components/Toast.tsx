import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface ToastState {
  show: (msg: string) => void;
}

const ToastCtx = createContext<ToastState>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);

  const show = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 1800);
  }, []);

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {msg && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4">
          <div className="rounded-full bg-neutral-900/90 dark:bg-neutral-100/90 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 shadow-lg">
            {msg}
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = (): ToastState => useContext(ToastCtx);
