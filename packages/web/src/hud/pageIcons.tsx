import type { PageIconName } from "../store/navStore";

/** Cérebro de traço (grade 24×24, no estilo da engrenagem e do sino da barra). Também aparece na página Cérebro. */
export const BRAIN_ICON_PATHS = [
  "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
  "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
  "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4",
  "M17.599 6.5a3 3 0 0 0 .399-1.375",
  "M6.003 5.125A3 3 0 0 0 6.401 6.5",
  "M3.477 10.896a4 4 0 0 1 .585-.396",
  "M19.938 10.5a4 4 0 0 1 .585.396",
  "M6 18a4 4 0 0 1-1.967-.516",
  "M19.967 17.484A4 4 0 0 1 18 18",
];

const PAGE_ICON_PATHS: Record<PageIconName, string[]> = { brain: BRAIN_ICON_PATHS };

/** Ícone de uma aba (decorativo: o botão leva o nome no aria-label). */
export function PageIcon({ name }: { name: PageIconName }) {
  return (
    <svg className="topbar__tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PAGE_ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
