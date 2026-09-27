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

/**
 * Live browser recognizer with language auto-detection.
 *
 * Flip policy (iOS-tuned): zh-TW recognition can take 4-6s before its FIRST
 * interim (server-assisted on Safari), so we NEVER flip on a blind timer —
 * only on strong signals: Latin words in an interim transcript, or an explicit
 * no-speech error after the session has matured. Flips are reversible (zh → en
 * → zh) but capped at 2 total, and an empty final after a flip re-tries the
 * other language once so Chinese never loses to a premature English switch.
 */
export class BrowserRecognizer {
  private rec: any = null;
  private switches = 0;
  private matured = false;
  private matureTimer: ReturnType<typeof setTimeout> | null = null;
  private gotFinal = false;
  private cbs: { onInterim: (t: string) => void; onFinal: (t: string, confidence?: number) => void; onError: (m: string) => void; onLang: (l: SttLang) => void } | null = null;

  startAuto(
    onInterim: (text: string) => void,
    onFinal: (text: string, confidence?: number) => void,
    onError: (msg: string) => void,
    onLang?: (lang: SttLang) => void,
  ): void {
    this.switches = 0;
    this.gotFinal = false;
    this.matured = false;
    this.cbs = { onInterim, onFinal, onError, onLang: onLang ?? (() => {}) };
    this.spinUp("zh-TW");
    // only after 5s is a no-speech signal trusted enough to flip
    this.matureTimer = setTimeout(() => (this.matured = true), 5000);
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
      // Latin words while listening as zh → they're speaking English.
      // Mixed interim (latin + CJK) stays on zh: the zh recognizer embeds
      // English words far better than en handles Chinese.
      if (lang === "zh-TW" && interim && /[A-Za-z]{2,}/.test(interim) && !/\p{Script=Han}/u.test(interim)) {
        this.trySwitch("en-US");
        return;
      }
      if (interim) this.cbs?.onInterim(interim);
      if (final) {
        this.gotFinal = true;
        const conf = typeof e.results[e.results.length - 1][0]?.confidence === "number"
          ? (e.results[e.results.length - 1][0].confidence as number)
          : undefined;
        this.cbs?.onFinal(final.trim(), conf && conf > 0 ? conf : undefined);
      }
    };
    rec.onerror = (e: any) => {
      const err = e?.error ?? "unknown";
      // only trust no-speech once the session has had time to warm up,
      // and only flip if we haven't already burned our switches
      if (err === "no-speech" && this.matured && this.switches === 0) {
        this.trySwitch("en-US");
        return;
      }
      if (err === "no-speech" || err === "aborted") return; // benign
      this.cbs?.onError(err === "not-allowed" ? "Microphone permission denied" : `Recognition error: ${err}`);
    };
    rec.onend = () => {
      // session ended without any final: flip once if we can, else finish clean
      if (!this.gotFinal && this.switches < 2 && this.switches === 0) {
        this.trySwitch(this.lastLang === "zh-TW" ? "en-US" : "zh-TW");
        return;
      }
      if (!this.gotFinal) this.cbs?.onFinal("");
    };
    this.lastLang = lang;
    this.cbs?.onLang(lang);
  }

  private lastLang: SttLang = "zh-TW";

  private trySwitch(lang: SttLang): void {
    if (this.switches >= 2 || lang === this.lastLang) return;
    this.switches++;
    this.spinUp(lang);
  }

  stop(): void {
    if (this.matureTimer) { clearTimeout(this.matureTimer); this.matureTimer = null; }
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

  /** the active capture stream — shared with LevelMeter (one mic consumer on iOS) */
  getStream(): MediaStream | null {
    return this.stream;
  }

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

/** Live mic amplitude for the in-input waveform while listening. */
export class LevelMeter {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;

  /** Attach to an EXISTING mic stream — never opens a second getUserMedia
   *  (iOS Safari kills a live SpeechRecognition session when a second audio
   *  consumer takes the mic). */
  attach(stream: MediaStream, onLevels: (bars: number[]) => void): void {
    try {
      this.stream = stream;
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser);
      this.data = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      const BARS = 24;
      let last = 0;
      const tick = () => {
        this.raf = requestAnimationFrame(tick);
        const now = performance.now();
        if (now - last < 66) return; // ~15fps is plenty
        last = now;
        this.analyser!.getByteFrequencyData(this.data!);
        const bars: number[] = [];
        const step = Math.floor(this.data!.length / BARS);
        for (let i = 0; i < BARS; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += this.data![i * step + j]!;
          bars.push(Math.min(1, sum / step / 140));
        }
        onLevels(bars);
      };
      this.raf = requestAnimationFrame(tick);
    } catch {
      /* visualizer is best-effort */
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
  }
}
