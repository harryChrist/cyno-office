import { JOINT_PART_STATE_LABELS, type JointPartState, type JointPartView, type JointView } from "@cyno/shared";

/** Funções puras do cartão do projeto conjunto (o chat do Cyno e a tela Trabalho). */

export type JointTone = "info" | "wait" | "ok" | "bad" | "idle";

const TONES: Record<JointPartState, JointTone> = {
  esperando: "idle",
  enviado: "info",
  andando: "info",
  esperando_voce: "wait",
  pausado: "idle",
  concluida: "ok",
  falhou: "bad",
  cancelada: "idle",
  bloqueada: "bad",
};

export const partTone = (state: JointPartState): JointTone => TONES[state];

/** O selo do estado de uma parte ("andando", "esperando você", "concluída"…). */
export const partLabel = (part: Pick<JointPartView, "state">): string => JOINT_PART_STATE_LABELS[part.state];

/** "1/3 partes". */
export function jointProgress(joint: Pick<JointView, "parts">): string {
  const done = joint.parts.filter((part) => part.state === "concluida").length;
  return `${done}/${joint.parts.length} ${joint.parts.length === 1 ? "parte" : "partes"}`;
}

/** O que o conjunto está fazendo, em uma frase ("andando", "travado: a parte P1 falhou", "concluído"…). */
export function jointStatusLabel(joint: JointView): string {
  if (joint.status === "concluido") return "concluído";
  if (joint.status === "cancelado") return "cancelado";
  if (joint.status === "travado") {
    const bad = joint.parts.find((part) => part.state === "falhou" || part.state === "cancelada");
    return bad ? `travado: a parte ${bad.ref} ${bad.state === "falhou" ? "falhou" : "foi cancelada"}` : "travado";
  }
  return joint.paused ? "pausado" : "andando";
}

export const isJointOpen = (joint: Pick<JointView, "status">): boolean => joint.status === "ativo" || joint.status === "travado";

/** "esperando a parte P1 (Design)" para uma parte que ainda espera; vazio nas outras. */
export function waitingLine(joint: Pick<JointView, "parts">, part: JointPartView): string {
  if (part.waitingFor.length === 0 || (part.state !== "esperando" && part.state !== "bloqueada")) return "";
  const names = part.waitingFor.map((ref) => {
    const other = joint.parts.find((candidate) => candidate.ref === ref);
    return other ? `${ref} (${other.workspaceName})` : ref;
  });
  return part.waitingFor.length === 1 ? `esperando a parte ${names[0]}` : `esperando as partes ${names.join(" e ")}`;
}

/** Uma parte que falhou ou foi cancelada pode ser refeita quando as que ela espera já terminaram. */
export function canRetry(joint: JointView, part: JointPartView): boolean {
  if (joint.status !== "travado" || (part.state !== "falhou" && part.state !== "cancelada")) return false;
  return part.dependsOn.every((ref) => joint.parts.find((candidate) => candidate.ref === ref)?.state === "concluida");
}

/** "Veio da P1 (Design): Arte do café" — o que a parte recebeu da anterior, em uma linha. */
export function receivedLine(joint: Pick<JointView, "parts">, part: JointPartView): string {
  const items = part.received?.items ?? [];
  if (items.length === 0) return "";
  return items
    .map((item) => {
      const from = joint.parts.find((candidate) => candidate.ref === item.from);
      const media = item.media.length > 0 ? `${item.media.length} ${item.media.length === 1 ? "mídia" : "mídias"}: ${item.media.map((entry) => entry.title).join(", ")}` : "";
      // O resumo vem em Markdown do Maestro: aqui é uma linha de texto, sem asteriscos nem cercas.
      const summary = item.summary ? item.summary.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
      return `Veio da ${item.from} (${from?.workspaceName ?? item.workspace})${[media, summary].filter(Boolean).length > 0 ? `: ${[media, summary].filter(Boolean).join(" · ")}` : ""}`;
    })
    .join(" | ");
}
