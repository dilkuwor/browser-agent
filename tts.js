// Text-to-Speech controller supporting AIHub Kokoro API and macOS built-in voices.

export const DEFAULT_TTS_SETTINGS = {
  ttsEngine: 'api',
  ttsServiceUrl: 'http://127.0.0.1:8091',
  ttsVoice: 'af_heart',
  ttsMacVoice: '',
  ttsSpeed: 1.0,
  ttsAutoRead: false
};

export function cleanTextForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' Code snippet omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export function splitIntoSentences(text) {
  const normalized = cleanTextForSpeech(text);
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?…]+(?:[.!?…]+|$)/g);
  return parts ? parts.map((p) => p.trim()).filter(Boolean) : [normalized];
}

export function scoreMacVoice(voice) {
  const hay = `${voice?.name || ''} ${voice?.voiceURI || ''}`.toLowerCase();
  let score = 0;
  if (hay.includes('premium')) score += 120;
  if (hay.includes('enhanced')) score += 80;
  if (hay.includes('ava')) score += 40;
  if (hay.includes('allison')) score += 35;
  if (hay.includes('samantha')) score += 30;
  if (hay.includes('nicky')) score += 25;
  if (hay.includes('alex')) score += 10;
  if (voice?.lang?.startsWith('en')) score += 15;
  if (!voice?.localService) score -= 50;
  return score;
}

export function getMacVoiceQuality(voice) {
  const hay = `${voice?.name || ''} ${voice?.voiceURI || ''}`.toLowerCase();
  if (hay.includes('premium')) return 'Premium';
  if (hay.includes('enhanced')) return 'Enhanced';
  if (voice?.localService) return 'Standard';
  return 'Remote';
}

export function resolveMacVoice(voices, preferredName) {
  const list = Array.isArray(voices) ? voices : [];
  const localVoices = list.filter((v) => v.localService);
  const pool = localVoices.length ? localVoices : list;
  if (preferredName) {
    const match = pool.find((v) => v.name === preferredName || v.voiceURI === preferredName);
    if (match) return match;
  }
  return pool.slice().sort((a, b) => scoreMacVoice(b) - scoreMacVoice(a))[0] || null;
}

export function base64ToAudioBlob(base64, mimeType = 'audio/wav') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function loadMacVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }
    const onVoicesChanged = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
    setTimeout(() => {
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    }, 800);
  });
}

export function createTtsController({ sendMessage, onStateChange } = {}) {
  let currentAudio = null;
  let currentObjectUrl = null;
  let macSession = 0;
  let activeId = null;
  let state = { playing: false, loading: false, activeId: null, error: null };

  const emit = (next) => {
    state = { ...state, ...next };
    onStateChange?.(state);
  };

  const cleanupUrl = () => {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  };

  function stop() {
    macSession += 1;
    if (typeof window !== 'undefined' && (window.speechSynthesis?.speaking || window.speechSynthesis?.pending)) {
      window.speechSynthesis.cancel();
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    cleanupUrl();
    activeId = null;
    emit({ playing: false, loading: false, activeId: null });
  }

  function speakMacSentence(sentence, voice, speed, session) {
    return new Promise((resolve, reject) => {
      if (session !== macSession) {
        resolve();
        return;
      }
      const utt = new SpeechSynthesisUtterance(sentence);
      if (voice) utt.voice = voice;
      utt.rate = Math.min(1.6, Math.max(0.5, Number(speed) || 1.0));
      utt.onend = () => resolve();
      utt.onerror = (ev) => {
        if (ev.error === 'canceled' || ev.error === 'interrupted') resolve();
        else reject(new Error(ev.error || 'macOS speech failed'));
      };
      window.speechSynthesis.speak(utt);
    });
  }

  async function speak(rawText, settings = {}, { id = null } = {}) {
    const clean = cleanTextForSpeech(rawText);
    if (!clean) return { ok: false, error: 'Nothing to read.' };

    stop();
    activeId = id || `tts_${Date.now()}`;
    const engine = settings.ttsEngine === 'macos' ? 'macos' : 'api';
    const speed = Math.min(2.0, Math.max(0.5, Number(settings.ttsSpeed) || 1.0));
    emit({ playing: true, loading: engine === 'api', activeId, error: null });

    if (engine === 'macos') {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        emit({ playing: false, loading: false, activeId: null, error: 'Web Speech API unavailable.' });
        return { ok: false, error: 'Web Speech API unavailable.' };
      }
      const session = macSession;
      try {
        const voices = await loadMacVoices();
        const voice = resolveMacVoice(voices, settings.ttsMacVoice);
        const sentences = splitIntoSentences(clean);
        emit({ playing: true, loading: false, activeId });
        for (let i = 0; i < sentences.length; i += 1) {
          if (session !== macSession) return { ok: true, canceled: true };
          await speakMacSentence(sentences[i], voice, speed, session);
        }
        if (session === macSession) {
          stop();
        }
        return { ok: true };
      } catch (err) {
        const msg = err?.message || String(err);
        stop();
        emit({ error: msg });
        return { ok: false, error: msg };
      }
    }

    // AIHub Kokoro API via background worker
    const session = macSession;
    try {
      const truncated = clean.slice(0, 8000);
      const res = await sendMessage({
        type: 'BA_TTS_SPEAK',
        text: truncated,
        serviceUrl: settings.ttsServiceUrl || DEFAULT_TTS_SETTINGS.ttsServiceUrl,
        voice: settings.ttsVoice || DEFAULT_TTS_SETTINGS.ttsVoice,
        speed
      });
      if (session !== macSession) return { ok: true, canceled: true };
      if (!res?.ok || !res.audioBase64) {
        throw new Error(res?.error || 'TTS API synthesis failed.');
      }
      const blob = base64ToAudioBlob(res.audioBase64);
      currentObjectUrl = URL.createObjectURL(blob);
      currentAudio = new Audio(currentObjectUrl);
      currentAudio.addEventListener('ended', () => {
        if (session === macSession) stop();
      });
      currentAudio.addEventListener('error', () => {
        if (session === macSession) {
          stop();
          emit({ error: 'Audio playback failed.' });
        }
      });
      emit({ playing: true, loading: false, activeId });
      await currentAudio.play();
      return { ok: true };
    } catch (err) {
      const msg = err?.message || String(err);
      stop();
      emit({ error: msg });
      return { ok: false, error: msg };
    }
  }

  return {
    speak,
    stop,
    getState: () => ({ ...state }),
    getMacVoices: loadMacVoices
  };
}
