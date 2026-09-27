import { api } from "./api";

/**
 * STT strategy mirrors TTS: gateway whisper-class model when configured
 * (MODEL_STT), else browser SpeechRecognition (iOS Safari / Android Chrome).
 */

let serverStt: boolean | null = null;

export async function initStt(): Promise<void> {
  try {
    serverStt = (await api.sttStatus()).available;
  } catch {
    serverStt = false;
  }
}

export const sttServerMode = (): boolean => serverStt === true;

/* eslint-disable @typescript-eslint/no-explicit-any */
function Recognition(): any {
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

export function browserSttSupported(): boolean {
  return Recognition() !== null;
}

export type SttLang = "zh-TW" | "en-US";

/** Live browser recognizer with auto language detection: starts zh-TW, flips to
 *  en-US on Latin interim text (or after 3s of silence), once per session. */
export class BrowserRecognizer {
  private rec: any = null;
  private switched = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private cbs: { onInterim: (t: string) => void; onFinal: (t: string, confidence?: number) => void; onError: (m: string) => void; onLang: (l: SttLang) => void } | null = null;

  startAuto(
    onInterim: (text: string) => void,
    onFinal: (text: string, confidence?: number) => void,
    onError: (msg: string) => void,
    onLang?: (lang: SttLang) => void,
  ): void {
    this.switched = false;
    this.cbs = { onInterim, onFinal, onError, onLang: onLang ?? (() => {}) };
    this.spinUp("zh-TW");
    // no interim after 3s → maybe they're speaking English into a zh recognizer
    this.silenceTimer = setTimeout(() => this.trySwitch("en-US"), 3000);
  }

  private spinUp(lang: SttLang): void {
    const R = Recognition();
    if (!R) {
      this.cbs?.onError("Speech recognition is not supported in this browser");
      return;
    }
    try {
      this.rec?.abort();
    } catch { /* noop */ }
    const rec = new R();
    this.rec = rec;
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
        // Latin words while listening as zh → they're speaking English
        if (!this.switched && lang === "zh-TW" && /[A-Za-z]{2,}/.test(interim)) {
          this.trySwitch("en-US");
          return;
        }
        this.cbs?.onInterim(interim);
      }
      if (final) {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
        // final results carry a 0-1 confidence (Chrome; Safari often 0 = unknown)
        const conf = typeof e.results[e.results.length - 1][0]?.confidence === "number"
          ? e.results[e.results.length - 1][0].confidence as number
          : undefined;
        this.cbs?.onFinal(final.trim(), conf && conf > 0 ? conf : undefined);
      }
    };
    rec.onerror = (e: any) => {
      const err = e?.error ?? "unknown";
      if (err === "no-speech" && !this.switched) {
        this.trySwitch("en-US"); // zh recognizer heard nothing — try English once
        return;
      }
      this.cbs?.onError(err === "not-allowed" ? "Microphone permission denied" : `Recognition error: ${err}`);
    };
    rec.start();
    this.cbs?.onLang(lang);
  }

  private trySwitch(lang: SttLang): void {
    if (this.switched) return;
    this.switched = true;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.spinUp(lang);
  }

  stop(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
  }
}

/** Records via MediaRecorder until stopped or 15s; resolves the audio blob (server mode). */
export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(onError: (msg: string) => void): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError("Microphone permission denied");
      return false;
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    setTimeout(() => this.stopIfActive(), 15000);
    return true;
  }

  private stopIfActive(): void {
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  /** resolves when stopped; rejects if nothing recorded */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec || rec.state === "inactive") {
        this.cleanup();
        reject(new Error("not recording"));
        return;
      }
      rec.onstop = () => {
        this.cleanup();
        if (this.chunks.length === 0) reject(new Error("nothing recorded"));
        else resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
      };
      rec.stop();
    });
  }

  get active(): boolean {
    return this.recorder?.state === "recording";
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
