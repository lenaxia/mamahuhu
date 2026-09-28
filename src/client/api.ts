import type {
  CreateEntryReq,
  Entry,
  HanziRes,
  HistoryDetail,
  HistoryItem,
  ListEntriesRes,
  Me,
  OcrRes,
  PatchEntryReq,
  PatchMeReq,
  PinyinRes,
  SttRes,
  TranslateRes,
} from "../shared/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Dev identity switcher. Sent whenever present; the server only honors
 * x-dev-user when TRUST_PROXY_HEADERS=0 (dev/test). Behind a real forward-auth
 * proxy the header is ignored, so this is safe in production builds.
 */
function devUser(): string | null {
  return localStorage.getItem("devUser");
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const du = devUser();
  if (du) headers.set("x-dev-user", du);
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `${res.status}`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => req<Me>("/api/me"),
  patchMe: (p: PatchMeReq) =>
    req<Me>("/api/me", { method: "PATCH", body: JSON.stringify(p) }),

  translate: (text: string, audience?: string | null, variety?: "zh-Hant" | "zh-HK") =>
    req<TranslateRes>("/api/ask/translate", {
      method: "POST",
      body: JSON.stringify({ text, ...(audience ? { audience } : {}), ...(variety ? { variety } : {}) }),
    }),
  pinyin: (text: string) =>
    req<PinyinRes>("/api/ask/pinyin", { method: "POST", body: JSON.stringify({ text }) }),
  hanzi: (text: string) =>
    req<HanziRes>("/api/ask/hanzi", { method: "POST", body: JSON.stringify({ text }) }),
  ocr: async (image: Blob): Promise<OcrRes> => {
    const headers = new Headers();
    const du = devUser();
    if (du) headers.set("x-dev-user", du);
    const form = new FormData();
    form.append("image", image, "page.jpg");
    const res = await fetch("/api/ask/ocr", { method: "POST", headers, body: form });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `${res.status}`);
    return (await res.json()) as OcrRes;
  },

  entries: (scope: "mine" | "all", q?: string) =>
    req<ListEntriesRes>(`/api/entries?scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  createEntry: (e: CreateEntryReq) =>
    req<Entry & { duplicate?: boolean }>("/api/entries", { method: "POST", body: JSON.stringify(e) }),
  patchEntry: (id: string, p: PatchEntryReq) =>
    req<Entry>(`/api/entries/${id}`, { method: "PATCH", body: JSON.stringify(p) }),
  deleteEntry: (id: string) => req<void>(`/api/entries/${id}`, { method: "DELETE" }),

  ttsStatus: () => req<{ available: boolean; cantoAvailable?: boolean }>("/api/tts/status"),

  sttStatus: () => req<{ available: boolean; mode: string }>("/api/stt/status"),
  stt: (audio: Blob): Promise<SttRes> =>
    (async () => {
      const headers = new Headers();
      const du = devUser();
      if (du) headers.set("x-dev-user", du);
      const form = new FormData();
      form.append("audio", audio, "clip.webm");
      const res = await fetch("/api/ask/stt", { method: "POST", headers, body: form });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `${res.status}`);
      return (await res.json()) as SttRes;
    })(),

  identify: async (image: Blob): Promise<{ tags: import("../shared/api").Identify[]; identify?: import("../shared/api").Identify }> => {
    const headers = new Headers();
    const du = devUser();
    if (du) headers.set("x-dev-user", du);
    const form = new FormData();
    form.append("image", image, "crop.jpg");
    const res = await fetch("/api/ask/identify", { method: "POST", headers, body: form });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `${res.status}`);
    return (await res.json()) as { tags: import("../shared/api").Identify[]; identify?: import("../shared/api").Identify };
  },

  followUp: (body: { question: string; hanzi?: string; gloss?: string; askId?: string; variety?: "zh-Hant" | "zh-HK" }) =>
    req<{ answer: string; answerWritten?: string; variety?: "zh-Hant" | "zh-HK" }>("/api/ask/followup", { method: "POST", body: JSON.stringify(body) }),

  reviewDue: () => req<Entry[]>("/api/review/due"),
  review: (id: string, outcome: "again" | "hard" | "good" | "easy") =>
    req<{ id: string; srsBox: number; srsDue: string; reviewed: number }>("/api/review", {
      method: "POST",
      body: JSON.stringify({ id, outcome }),
    }),

  history: () => req<HistoryItem[]>("/api/history"),
  historyDetail: (id: string) => req<HistoryDetail>(`/api/history/${id}`),
  deleteHistory: (id: string) => req<void>(`/api/history/${id}`, { method: "DELETE" }),
  clearHistory: () => req<void>("/api/history", { method: "DELETE" }),
};
