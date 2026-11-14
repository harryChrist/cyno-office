// Adaptado de Habblaud (github.com/marmottajr/habblaud), MIT, Copyright (c) 2026 Márcio Junior.
// De lá vêm a ideia de sintetizar tudo com WebAudio (sem arquivo de áudio) e o desenho do sino
// (`client/src/audio/synth.ts`: duas parciais e uma terceira nota logo depois, com decaimento longo);
// o envelope e o oscilador foram reescritos, e o som discreto da falha de tarefa é nosso.
import type { AttentionSound } from "./decide";

type AudioContextCtor = typeof AudioContext;

function audioContextClass(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
}

/** Envelope percussivo: ataque curto e queda exponencial. */
function envelope(gain: GainNode, at: number, peak: number, attack: number, decay: number): void {
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
}

function tone(ac: AudioContext, out: AudioNode, type: OscillatorType, freq: number, at: number, peak: number, attack: number, decay: number, toFreq?: number): void {
  const oscillator = ac.createOscillator();
  const gain = ac.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(freq, at);
  if (toFreq) oscillator.frequency.exponentialRampToValueAtTime(toFreq, at + Math.min(decay, 0.12));
  envelope(gain, at, peak, attack, decay);
  oscillator.connect(gain).connect(out);
  oscillator.start(at);
  oscillator.stop(at + attack + decay + 0.05);
}

/** Toca um dos sons no contexto, com o ganho dado (0 a 1). Exportada para os testes montarem um contexto falso. */
export function playSynth(ac: AudioContext, kind: AttentionSound, gain: number, at: number = ac.currentTime): void {
  const out = ac.destination;
  if (kind === "chime") {
    // O sino: duas parciais juntas e uma terceira nota logo depois.
    tone(ac, out, "sine", 880, at, 0.16 * gain, 0.012, 1.1);
    tone(ac, out, "sine", 1318.5, at, 0.08 * gain, 0.012, 1.1);
    tone(ac, out, "sine", 1174.7, at + 0.14, 0.1 * gain, 0.012, 1.1);
    return;
  }
  // O som discreto (tarefa que falhou): uma nota grave e curta que desce, sem brilho.
  tone(ac, out, "triangle", 330, at, 0.12 * gain, 0.01, 0.28, 247);
  tone(ac, out, "sine", 165, at, 0.06 * gain, 0.01, 0.3);
}

/** O volume (0 a 100) vira ganho: curva quadrática, para o meio do controle ser confortável. */
export const gainOf = (volume: number): number => Math.pow(Math.min(100, Math.max(0, volume)) / 100, 2) * 2.2;

/**
 * Os sons dos avisos. O navegador só deixa tocar depois de um gesto do dono, então `unlock` precisa
 * rodar num clique ou tecla; depois disso toca mesmo com a aba escondida.
 */
export class AttentionAudio {
  private ac: AudioContext | undefined;

  /** Cria/retoma o contexto (chamar de dentro de um gesto). Devolve se pode tocar. */
  async unlock(): Promise<boolean> {
    const Ctor = audioContextClass();
    if (!Ctor) return false;
    try {
      this.ac ??= new Ctor();
      if (this.ac.state === "suspended") await this.ac.resume();
      return this.ac.state === "running";
    } catch {
      return false;
    }
  }

  /** Toca o som; sem contexto liberado, não toca (e não reclama). */
  play(kind: AttentionSound, volume: number): boolean {
    const ac = this.ac;
    if (!ac || ac.state !== "running") return false;
    try {
      playSynth(ac, kind, gainOf(volume));
      return true;
    } catch {
      return false;
    }
  }
}

export const attentionAudio = new AttentionAudio();
