/** Ajuda para quando o navegador não deixa ligar o aviso com o site fechado. Texto puro, sem React (testável). */

export type PushDeviceKind = "android-chrome" | "iphone-safari" | "desktop" | "other";

/** Pura: que aparelho é, pelo `userAgent` (só para escolher o passo a passo). */
export function pushDeviceKind(userAgent: string): PushDeviceKind {
  const ua = userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return "iphone-safari";
  if (/Android/.test(ua) && /Chrome\//.test(ua) && !/EdgA|OPR\/|SamsungBrowser|Firefox/.test(ua)) return "android-chrome";
  if (/Android/.test(ua)) return "other";
  if (/Windows NT|Macintosh|Mac OS X|X11|Linux x86_64|CrOS/.test(ua)) return "desktop";
  return "other";
}

export type PushHelp = {
  title: string;
  /** Uma linha que explica por que o navegador não perguntou (ou null). */
  why: string | null;
  steps: string[];
};

const GENERAL_STEPS = [
  "Abra as configurações do navegador e procure as permissões ou notificações do site.",
  "Deixe as notificações deste site como Permitir (se estiver em Bloqueado, mude).",
  "Volte aqui, recarregue a página e toque em Tentar de novo.",
];

/** Pura: o passo a passo curto para o aparelho. Um site não consegue se desbloquear sozinho: quem libera é a pessoa, no navegador. */
export function pushHelpFor(kind: PushDeviceKind): PushHelp {
  switch (kind) {
    case "android-chrome":
      return {
        title: "Como liberar no Chrome do Android",
        why: "“Bloqueada automaticamente” quer dizer que o próprio Chrome escondeu o pedido de permissão, sem perguntar a você.",
        steps: [
          "No celular: Configurações, Apps, Chrome, Notificações. Deixe ligadas.",
          "No Chrome: toque nos três pontinhos (⋮), Configurações, Configurações do site, Notificações. Deixe os sites pedirem para enviar notificações e desligue “Usar mensagens mais silenciosas”. Se este site estiver na lista de Bloqueados, toque nele e escolha Permitir (ou “Limpar e redefinir”).",
          "Volte aqui, recarregue a página e toque em Ligar ou em Tentar de novo. Se aparecer um sininho riscado na barra de endereço, toque nele e em Permitir.",
          "Não vale em aba anônima, nem abrindo o Cyno por dentro de outro aplicativo: abra direto no Chrome.",
        ],
      };
    case "iphone-safari":
      return {
        title: "Como liberar no iPhone",
        why: null,
        steps: [
          "No Safari, toque em Compartilhar e em Adicionar à Tela de Início. Depois abra o Cyno pelo ícone novo, não pelo Safari.",
          "No iPhone: Ajustes, Notificações, Cyno. Deixe Permitir Notificações ligado.",
          "Volte aqui e toque em Ligar ou em Tentar de novo.",
        ],
      };
    case "desktop":
      return {
        title: "Como liberar no computador",
        why: null,
        steps: [
          "Clique no cadeado (ou no ícone de ajustes) ao lado do endereço, na barra do navegador.",
          "Em Notificações, escolha Permitir (se estiver em Bloquear, mude).",
          "Volte aqui, recarregue a página e clique em Tentar de novo.",
        ],
      };
    default:
      return { title: "Como liberar as notificações", why: null, steps: GENERAL_STEPS };
  }
}

/** O que dizer sobre ser opcional. */
export const PUSH_OPTIONAL_NOTE = "Este aviso é opcional. Sem ele, o contador, o sino e o aviso na tela continuam funcionando normalmente.";
