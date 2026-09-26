import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Annotations, Me } from "../shared/api";
import { api } from "./api";

interface MeState {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me) => void;
}

const MeCtx = createContext<MeState>({ me: null, loading: true, setMe: () => {} });

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  return <MeCtx.Provider value={{ me, loading, setMe }}>{children}</MeCtx.Provider>;
}

export const useMe = (): MeState => useContext(MeCtx);
export const useAnnotations = (): Annotations => useMe().me?.annotations ?? "both";
