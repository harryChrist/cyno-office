/**
 * Transcritor do ditado por voz. Hoje: Web Speech API do navegador (`SpeechRecognition`, que no
 * Chrome/Edge/Safari usa o serviço de voz do próprio navegador). A interface `Transcriber` é o
 * ponto de troca: um transcritor no server (ex.: Whisper, gravando com MediaRecorder e mandando o
 * áudio) só precisa chamar `onUpdate` com o texto e `onEnd` quando acabar.
 */

export type TranscriberEvents = {
  /** Texto reconhecido até agora na sessão: o definitivo e o interino (ainda pode mudar). */
  onUpdate: (finalText: string, interimText: string) => void;
  /** Código do erro (os da Web Speech API: "not-allowed", "audio-capture", "no-speech"…). */
  onError: (code: string) => void;
  /** A sessão acabou (parou, deu erro ou o navegador encerrou sozinho). */
  onEnd: () => void;
};

export type Transcriber = {
  start: (events: TranscriberEvents) => void;
  /** Para de ouvir e entrega o que falta reconhecer. */
  stop: () => void;
  /** Para na hora e descarta o que ainda não foi entregue. */
  abort: () => void;
};

/** Pode ditar? Senão, por quê: sem HTTPS (contexto inseguro) ou navegador sem a API. */
export type DictationAvailability = { ok: true } | { ok: false; reason: "insecure" | "unsupported" };

export type TranscriberFactory = {
  availability: () => DictationAvailability;
  create: (lang: string) => Transcriber;
};

/* Tipos mínimos da Web Speech API (o lib.dom do TypeScript não tem o prefixo webkit). */
type SpeechAlternative = { transcript: string };
type SpeechResult = { isFinal: boolean; length: number; [index: number]: SpeechAlternative };
type SpeechResultList = { length: number; [index: number]: SpeechResult };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Regra pura da disponibilidade (testável): HTTPS primeiro, depois a API. */
export function dictationAvailability(env: { secure: boolean; hasApi: boolean }): DictationAvailability {
  if (!env.secure) return { ok: false, reason: "insecure" };
  if (!env.hasApi) return { ok: false, reason: "unsupported" };
  return { ok: true };
}

/** Separa os resultados da sessão em texto definitivo e interino. */
export function splitResults(results: SpeechResultList): { finalText: string; interimText: string } {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const text = result[0]?.transcript ?? "";
    (result.isFinal ? finals : interims).push(text);
  }
  return { finalText: finals.join(" "), interimText: interims.join(" ") };
}

/** Transcritor do navegador (Web Speech API). */
export const browserTranscriber: TranscriberFactory = {
  availability: () =>
    dictationAvailability({ secure: typeof window !== "undefined" && window.isSecureContext, hasApi: speechRecognitionCtor() !== undefined }),
  create(lang) {
    let recognition: SpeechRecognitionLike | null = null;
    return {
      start(events) {
        const Ctor = speechRecognitionCtor();
        if (!Ctor) {
          events.onError("unsupported");
          events.onEnd();
          return;
        }
        recognition = new Ctor();
        recognition.lang = lang;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
          const { finalText, interimText } = splitResults(event.results);
          events.onUpdate(finalText, interimText);
        };
        recognition.onerror = (event) => events.onError(event.error);
        recognition.onend = () => {
          recognition = null;
          events.onEnd();
        };
        try {
          recognition.start();
        } catch {
          recognition = null;
          events.onError("start-failed");
          events.onEnd();
        }
      },
      stop: () => recognition?.stop(),
      abort: () => recognition?.abort(),
    };
  },
};

/** Mensagem curta (pt-BR) para cada erro; null quando não é erro para o usuário (cancelado). */
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Permissão do microfone negada. Libere o microfone para este site no navegador.";
    case "audio-capture":
      return "Nenhum microfone encontrado.";
    case "no-speech":
      return "Não ouvi nada. Clique no microfone e fale de novo.";
    case "network":
      return "O serviço de voz do navegador não respondeu (sem internet?).";
    case "language-not-supported":
      return "O navegador não reconhece português (pt-BR).";
    case "insecure":
      return UNAVAILABLE_MESSAGES.insecure;
    case "unsupported":
      return UNAVAILABLE_MESSAGES.unsupported;
    default:
      return "O ditado falhou. Tente de novo.";
  }
}

/** Por que o microfone não está disponível (dica do botão). */
export const UNAVAILABLE_MESSAGES: Record<"insecure" | "unsupported", string> = {
  insecure: "O microfone precisa de HTTPS: abra o app por https:// (veja docs/como-rodar.md).",
  unsupported: "Este navegador não tem ditado por voz. Use Chrome, Edge ou Safari.",
};
