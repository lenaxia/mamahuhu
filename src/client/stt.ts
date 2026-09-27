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

/** Live browser recognizer: emits interim + final transcript. */
export class BrowserRecognizer {
  private rec: any = null;

  start(
    lang: "zh-TW" | "en-US",
    onInterim: (text: string) => void,
    onFinal: (text: string) => void,
    onError: (msg: string) => void,
  ): void {
    const R = Recognition();
    if (!R) {
      onError("Speech recognition is not supported in this browser");
      return;
    }
    this.rec = new R();
    this.rec.lang = lang;
    this.rec.interimResults = true;
    this.rec.continuous = false;
    this.rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) onInterim(interim);
      if (final) onFinal(final.trim());
    };
    this.rec.onerror = (e: any) => onError(e?.error === "not-allowed" ? "Microphone permission denied" : `Recognition error: ${e?.error ?? "unknown"}`);
    this.rec.onend = () => {
      /* final callback handles completion */
    };
    this.rec.start();
  }

  stop(): void {
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
