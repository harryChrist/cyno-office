import { BRAIN_ICON_PATHS } from "./pageIcons";

/**
 * Ícones de traço da navegação lateral (grade 24×24, traço 2, pontas redondas: o mesmo desenho
 * do sino, da engrenagem e do cérebro da barra). Sem biblioteca de ícones.
 */
const NAV_ICON_PATHS = {
  office: ["M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z", "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2", "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2", "M10 6h4", "M10 10h4", "M10 14h4", "M10 18h4"],
  tarefas: ["M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", "m9 11 3 3L22 4"],
  "para-voce": ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  midia: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 8a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
  gestao: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12Z", "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z"],
  calendario: ["M8 2v4", "M16 2v4", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M3 10h18", "M8 14h.01", "M12 14h.01", "M16 14h.01", "M8 18h.01", "M12 18h.01"],
  navegador: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  cerebro: BRAIN_ICON_PATHS,
  // A Biblioteca: três livros em pé.
  biblioteca: ["m16 6 4 14", "M12 6v14", "M8 8v12", "M4 4v16"],
  // O Cyno: um "C" dentro de um círculo (o orbe do agente da plataforma).
  // O Cyno: a cabeça do bichinho (duas orelhas, olhos e focinho), em traço como os outros.
  cyno: ["M4.6 11C4 8 4.3 5 5.4 3.2c.3-.5.9-.5 1.3-.2L10 5.4c1.3-.3 2.7-.3 4 0L17.3 3c.4-.3 1-.3 1.3.2 1.1 1.800 1.400 4.800.8 7.800C20 15 16.500 20 12 20s-8-5-7.400-9Z", "M9 12h.01", "M15 12h.01", "M12 15.500h.01"],
  gastos: ["M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1", "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"],
  logs: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  configuracoes: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z",
  ],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  // O uso do plano: um medidor de meia-volta com o ponteiro.
  uso: ["M3.34 19a10 10 0 1 1 17.32 0", "m12 14 4-4"],
  hoje: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z", "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"],
  agentes: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  // A mão levantada: o agente (ou o terminal) espera você.
  mao: ["M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2", "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2", "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8", "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  chevron: ["m6 9 6 6 6-6"],
  "rail-close": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 3v18", "m16 15-3-3 3-3"],
  "rail-open": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 3v18", "m14 9 3 3-3 3"],
} satisfies Record<string, string[]>;

export type NavIconName = keyof typeof NAV_ICON_PATHS;

/** Ícone decorativo (o nome vai no texto do item ou no aria-label do botão). */
export function NavIcon({ name, className = "nav-icon" }: { name: NavIconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {NAV_ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
