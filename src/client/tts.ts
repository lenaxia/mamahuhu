import { api } from "./api";
import type { Variety } from "../shared/api";

/**
 * TTS strategy: server model (kokoro for Mandarin, edge-tts for Cantonese) when
 * available, else browser speechSynthesis (zh-TW / zh-HK voice preference).
 * `speak` never throws.
 */

let serverTts: boolean | null = null;
let serverTtsCa: boolean | null = null;
let currentAudio: HTMLAudioElement | null = null;

export async function initTts(): Promise<void> {
  try {
    const s = await api.ttsStatus();
    serverTts = s.available;
    serverTtsCa = s.cantoAvailable ?? false;
  } catch {
    serverTts = false;
    serverTtsCa = false;
  }
}

function browserVoice(variety: Variety): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  // OSes ship legacy low-quality zh voices alongside enhanced/premium downloads;
  // tone rendering on the legacy ones is flat — always prefer the upgrades.
  const prefer = (list: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null =>
    list.find((v) => /enhanced|premium|elegant|ultimate/i.test(v.name)) ?? list[0] ?? null;
  if (variety === "zh-HK") {
    const hk = voices.filter((v) => /^zh[-_]HK/i.test(v.lang));
    const yue = voices.filter((v) => /^yue/i.test(v.lang));
    return prefer(hk) ?? prefer(yue) ?? prefer(voices.filter((v) => /^zh[-_]TW/i.test(v.lang)));
  }
  return prefer(voices.filter((v) => /^zh[-_]TW/i.test(v.lang))) ?? prefer(voices.filter((v) => /^zh/i.test(v.lang)));
}

export function speak(text: string, opts?: { slow?: boolean; variety?: Variety }): void {
  if (!text.trim()) return;
  const variety = opts?.variety ?? "zh-Hant";
  const rate = opts?.slow ? 0.6 : 1;
  const useServer = variety === "zh-HK" ? serverTtsCa === true : serverTts === true;
  stopSpeak();
  if (useServer) {
    const a = new Audio(`/api/tts?text=${encodeURIComponent(text)}&speed=${rate}&variety=${variety}`);
    currentAudio = a;
    a.play().catch(() => {
      if (variety === "zh-HK") serverTtsCa = false;
      else serverTts = false;
      speakBrowser(text, rate, variety);
    });
    return;
  }
  speakBrowser(text, rate, variety);
}

function speakBrowser(text: string, rate: number, variety: Variety): void {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = variety === "zh-HK" ? "zh-HK" : "zh-TW";
  u.rate = rate;
  const v = browserVoice(variety);
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

export function stopSpeak(): void {
  currentAudio?.pause();
  currentAudio = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** For the Settings warning: browser-TTS deployments need a zh voice on the device. */
export function ttsInfo(): { server: boolean; zhVoice: boolean; cantoServer: boolean; hkVoice: boolean } {
  const zhVoice =
    ("speechSynthesis" in window) &&
    window.speechSynthesis.getVoices().some((v) => /^zh/i.test(v.lang));
  const hkVoice =
    ("speechSynthesis" in window) &&
    window.speechSynthesis.getVoices().some((v) => /^zh[-_]HK/i.test(v.lang) || /^yue/i.test(v.lang));
  return { server: serverTts === true, zhVoice, cantoServer: serverTtsCa === true, hkVoice };
}
