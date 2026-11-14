import type { CynoStatus } from "@cyno/shared";

/** Pose do bichinho do Cyno: o que o desenho mostra e o que se mexe em cada estado. */
export type CynoPetPose = {
  /** Olhos fechados (dormindo). */
  eyesClosed: boolean;
  /** Orelhas em pé (trabalhando) ou de repouso. */
  earsUp: boolean;
  /** Cabeça levemente inclinada (esperando você). */
  tilted: boolean;
  /** Rabo balançando devagar. */
  tailWag: boolean;
  /** "Respirar" leve do corpo. */
  breathing: boolean;
  /** Pisca de vez em quando (só acordado e parado). */
  blinking: boolean;
  /** "z" subindo (só dormindo). */
  zzz: boolean;
  /** Cores um pouco mais apagadas. */
  dim: boolean;
  /** Nome da pose, também usado em `data-pose`. */
  name: "sleeping" | "idle" | "working" | "waiting";
};

/**
 * Escolhe a pose a partir do estado do Cyno. `waiting` = há algo esperando o dono (um bloqueio ou uma
 * decisão pendente): o bichinho inclina a cabeça, mas nunca enquanto dorme ou trabalha.
 */
export function cynoPetPose(status: CynoStatus | undefined, waiting = false): CynoPetPose {
  const base = { eyesClosed: false, earsUp: false, tilted: false, tailWag: false, breathing: false, blinking: false, zzz: false, dim: false };
  const current = status ?? "sleeping";
  if (current === "sleeping") return { ...base, eyesClosed: true, zzz: true, dim: true, breathing: true, name: "sleeping" };
  if (current === "working" || current === "waking") return { ...base, earsUp: true, tailWag: true, breathing: true, name: "working" };
  if (waiting) return { ...base, tilted: true, blinking: true, name: "waiting" };
  return { ...base, blinking: true, name: "idle" };
}
