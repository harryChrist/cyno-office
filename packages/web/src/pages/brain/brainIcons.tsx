import type { BrainKind } from "@cyno/shared";
import { BRAIN_ICON_PATHS } from "../../hud/pageIcons";
import { circlePath, roundRectPath } from "../foryou/iconPaths";
import type { NoteKind } from "./brainView";

/** Ícones de traço da página Cérebro (grade 24×24, mesmo traço dos ícones da barra). */
const PATHS = {
  brain: BRAIN_ICON_PATHS,
  // Cérebro global: o mundo (vale para o workspace inteiro).
  globo: [circlePath(12, 12, 10), "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
  // Gerência: a nota musical do Maestro.
  maestro: ["M9 18V5l12-2v13", circlePath(6, 18, 3), circlePath(18, 16, 3)],
  // Quarto: a porta.
  porta: [
    "M13 4h3a2 2 0 0 1 2 2v14",
    "M2 20h3",
    "M13 20h9",
    "M10 12v.01",
    "M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z",
  ],
  regras: [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ],
  briefing: [
    roundRectPath(8, 2, 8, 4, 1),
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "M12 11h4",
    "M12 16h4",
    "M8 11h.01",
    "M8 16h.01",
  ],
  // Índice: o mapa das notas.
  indice: [
    "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z",
    "M15 5.764v15",
    "M9 3.236v15",
  ],
  nota: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  historico: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  busca: [circlePath(11, 11, 8), "m21 21-4.3-4.3"],
  fixa: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  voltar: ["m12 19-7-7 7-7", "M19 12H5"],
  seta: ["m9 18 6-6-6-6"],
} satisfies Record<string, string[]>;

export type BrainIconName = keyof typeof PATHS;

export const BRAIN_KIND_ICONS: Record<BrainKind, BrainIconName> = { lobby: "globo", maestro: "maestro", team: "porta" };

export const NOTE_KIND_ICONS: Record<NoteKind, BrainIconName> = {
  regras: "regras",
  briefing: "briefing",
  indice: "indice",
  historico: "historico",
  nota: "nota",
};

/** Ícone decorativo (o texto ao lado diz o que é). */
export function BrainIcon({ name, size = 16, className }: { name: BrainIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `brain-icon ${className}` : "brain-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
