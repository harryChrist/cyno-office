import { KIND_ICON_PATHS, type PaceIcon } from "./gestaoView";
import type { RoutineKind } from "@cyno/shared";

const PATHS = {
  check: ["M20 6 9 17l-5-5"],
  up: ["M7 17 17 7", "M8 7h9v9"],
  alert: ["M12 3 2 20h20z", "M12 10v4", "M12 17h.01"],
  pause: ["M8 5v14", "M16 5v14"],
  flag: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  info: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 16v-4", "M12 8h.01"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  plus: ["M12 5v14", "M5 12h14"],
  play: ["M6 4l14 8-14 8z"],
  skip: ["M5 4l10 8-10 8z", "M19 5v14"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  target: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12Z", "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z"],
  sparkles: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 3v4", "M21 5h-4"],
} satisfies Record<string, string[]>;

export type GIconName = keyof typeof PATHS;

/** Ícone de traço decorativo (o texto ao lado diz o que é). */
export function GIcon({ name, size = 14, className }: { name: GIconName | PaceIcon; size?: number; className?: string }) {
  return (
    <svg className={`gi${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function KindIcon({ kind, size = 16 }: { kind: RoutineKind; size?: number }) {
  return (
    <svg className="gi" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {KIND_ICON_PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
