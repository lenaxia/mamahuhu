import { api } from "./api";

/**
 * TTS strategy: server model (kokoro via gateway) when available, else browser
 * speechSynthesis with a zh-TW voice preference. `speak` never throws.
 */

let serverTts: boolean | null = null;
let currentAudio: HTMLAudioElement | null = null;

export async function initTts(): Promise<void> {
  try {
    serverTts = (await api.ttsStatus()).available;
  } catch {
    serverTts = false;
  }
}

function browserVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return (
    voices.find((v) => /^zh[-_]TW/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  );
}

export function speak(text: string, opts?: { slow?: boolean }): void {
  if (!text.trim()) return;
  const rate = opts?.slow ? 0.6 : 1;
  stopSpeak();
  if (serverTts) {
    const a = new Audio(`/api/tts?text=${encodeURIComponent(text)}&speed=${rate}`);
    currentAudio = a;
    a.play().catch(() => {
      serverTts = false;
      speakBrowser(text, rate);
    });
    return;
  }
  speakBrowser(text, rate);
}

function speakBrowser(text: string, rate: number): void {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-TW";
  u.rate = rate;
  const v = browserVoice();
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

export function stopSpeak(): void {
  currentAudio?.pause();
  currentAudio = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** For the Settings warning: browser-TTS deployments need a zh voice on the device. */
export function ttsInfo(): { server: boolean; zhVoice: boolean } {
  const zhVoice =
    ("speechSynthesis" in window) &&
    window.speechSynthesis.getVoices().some((v) => /^zh/i.test(v.lang));
  return { server: serverTts === true, zhVoice };
}
