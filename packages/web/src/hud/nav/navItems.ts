import type { WorkFolder } from "@cyno/shared";
import type { PageId } from "../../store/navStore";
import type { NavIconName } from "../navIcons";

/** Um destino dentro de uma página com abas (Gestão, Biblioteca): link direto, recuado sob o pai. */
export type NavChildDef = {
  /** Aba (`gastos`, `midia`...). Vazia = a aba de abertura da página. */
  sub: string;
  label: string;
  testId: string;
  /** A aba que vale quando o endereço não diz nenhuma (ela fica acesa nesse caso). */
  isDefault?: boolean;
  /** Aba de um workspace só: some quando não há workspace. */
  needsWorkspace?: boolean;
  /** O endereço da aba leva o workspace (`midia/<ws>`). */
  carriesWorkspace?: boolean;
};

/** Um item de página na navegação. O testId é o mesmo da barra antiga (os testes continuam valendo). */
export type NavItemDef = {
  page: PageId;
  icon: NavIconName;
  testId: string;
  /** Aba aberta ao clicar (`gastos`...). */
  sub?: string;
  /** Nome, quando não é o da página. */
  label?: string;
  /** Uma linha curta sobre o que a página tem (embaixo do nome e na dica). */
  hint?: string;
  /** Destinos mostrados logo abaixo, recuados (a Gestão e a Biblioteca). */
  children?: NavChildDef[];
};

/** Texto de cada página (a linha discreta embaixo do nome e a dica), em português simples. */
export const PAGE_HINTS: Partial<Record<PageId, string>> = {
  cyno: "Fale com o Cyno e veja os workspaces",
  office: "O time ao vivo e o chat com o Maestro",
  trabalho: "O que está sendo feito e por quem",
  "para-voce": "O que espera a sua resposta",
  quadro: "Os dados que os agentes montam para você",
  gestao: "Rotinas, metas, gastos e histórico",
  biblioteca: "Notas, mídia, apps, conectores e skills",
  agenda: "Seus compromissos e os do time",
  navegador: "O navegador que os agentes usam",
};
export const HOJE_HINT = "O trabalho do dia, ao vivo";
export const NOTIFICATIONS_HINT = "Avisos e o que aconteceu por último";

/** Os destinos da Gestão: o Painel (abertura) e, depois, o que era a "Visão geral" (Rotinas e metas). */
export const GESTAO_CHILDREN: NavChildDef[] = [
  { sub: "", label: "Painel", testId: "nav-gestao-painel", isDefault: true, needsWorkspace: true },
  { sub: "rotinas", label: "Rotinas e metas", testId: "nav-gestao-rotinas", needsWorkspace: true },
  { sub: "pessoas", label: "Pessoas", testId: "nav-gestao-pessoas", needsWorkspace: true },
  { sub: "gastos", label: "Gastos", testId: "nav-gestao-gastos", needsWorkspace: true },
  { sub: "atividade", label: "Atividade", testId: "nav-gestao-atividade" },
  { sub: "relatorios", label: "Relatórios", testId: "nav-gestao-relatorios", needsWorkspace: true },
];

/** Os destinos da Biblioteca (Mídia e Cérebro são de um workspace só). */
export const BIBLIOTECA_CHILDREN: NavChildDef[] = [
  { sub: "cerebro", label: "Cérebro (notas)", testId: "nav-biblioteca-cerebro", needsWorkspace: true, carriesWorkspace: true, isDefault: true },
  { sub: "midia", label: "Mídia", testId: "nav-biblioteca-midia", needsWorkspace: true, carriesWorkspace: true },
  { sub: "apps", label: "Apps", testId: "nav-biblioteca-apps" },
  { sub: "conectores", label: "Conectores (MCP)", testId: "nav-biblioteca-conectores" },
  { sub: "skills", label: "Skills", testId: "nav-biblioteca-skills" },
];

/** O menu: as páginas do workspace, e a Biblioteca (da plataforma) logo abaixo. Configurações fica no rodapé. */
export const NAV_SECTIONS: { title: string | null; items: NavItemDef[] }[] = [
  {
    title: null,
    items: [
      { page: "office", icon: "office", testId: "nav-office", hint: PAGE_HINTS.office },
      { page: "trabalho", icon: "tarefas", testId: "nav-trabalho", hint: PAGE_HINTS.trabalho },
      { page: "para-voce", icon: "para-voce", testId: "nav-para-voce", hint: PAGE_HINTS["para-voce"] },
      { page: "quadro", icon: "quadro", testId: "nav-quadro", hint: PAGE_HINTS.quadro },
      { page: "gestao", icon: "gestao", testId: "nav-gestao", hint: PAGE_HINTS.gestao, children: GESTAO_CHILDREN },
    ],
  },
  {
    title: null,
    items: [{ page: "biblioteca", icon: "biblioteca", testId: "nav-biblioteca", hint: PAGE_HINTS.biblioteca, children: BIBLIOTECA_CHILDREN }],
  },
];

/** Sem workspace nenhum, só as páginas do app inteiro abrem (a Biblioteca e a Atividade do sistema). */
export const APP_WIDE_SECTIONS: typeof NAV_SECTIONS = [
  {
    title: null,
    items: [
      { page: "biblioteca", icon: "biblioteca", testId: "nav-biblioteca", hint: PAGE_HINTS.biblioteca, children: BIBLIOTECA_CHILDREN },
      { page: "gestao", sub: "atividade", icon: "logs", testId: "nav-atividade", label: "Atividade", hint: "O histórico do sistema" },
    ],
  },
];

/** Atalhos (sem item de menu): a Sua agenda e o navegador dos agentes. */
export const SHORTCUTS: { item: NavItemDef; tip: string; short: string; needsWorkspace: boolean }[] = [
  { item: { page: "agenda", icon: "calendario", testId: "nav-agenda", label: "Sua agenda", hint: PAGE_HINTS.agenda }, tip: "Sua agenda", short: "Agenda", needsWorkspace: false },
  { item: { page: "navegador", icon: "navegador", testId: "nav-navegador", label: "Navegador dos agentes", hint: PAGE_HINTS.navegador }, tip: "Navegador dos agentes", short: "Navegador", needsWorkspace: true },
];

/** Os atalhos que valem agora (o navegador é do workspace: sem workspace, só a agenda). */
export function visibleShortcuts(empty: boolean): typeof SHORTCUTS {
  return SHORTCUTS.filter((shortcut) => !(empty && shortcut.needsWorkspace));
}

/** Tira as seções que ficaram sem item (e, com isso, o título delas). */
export function nonEmptySections(sections: typeof NAV_SECTIONS): typeof NAV_SECTIONS {
  return sections.filter((section) => section.items.length > 0);
}

/** As páginas que o menu mostra (com o Cyno no topo, são as seis do menu). */
export function menuPages(sections: typeof NAV_SECTIONS = NAV_SECTIONS): PageId[] {
  return sections.flatMap((section) => section.items.map((item) => item.page));
}

/** Os destinos que valem agora (sem workspace, os de um workspace só somem). */
export function visibleChildren(item: NavItemDef, empty: boolean): NavChildDef[] {
  return (item.children ?? []).filter((child) => !(empty && child.needsWorkspace));
}

/** Qual destino do grupo está aceso para a aba atual (`sub` do endereço); nenhum se a página é outra. */
export function activeChild(item: NavItemDef, page: PageId, sub: string): NavChildDef | null {
  if (page !== item.page || !item.children) return null;
  const first = sub.split("/")[0] ?? "";
  return item.children.find((child) => child.sub !== "" && child.sub === first) ?? item.children.find((child) => child.isDefault) ?? null;
}

/** A aba (`sub`) que o clique num destino abre: Mídia e Cérebro levam o workspace atual no endereço. */
export function childSub(child: NavChildDef, workspaceId: string | null): string {
  return child.carriesWorkspace && workspaceId ? `${child.sub}/${encodeURIComponent(workspaceId)}` : child.sub;
}

/**
 * Para onde o clique no ícone de um grupo leva na barra RECOLHIDA: a primeira página do grupo (Painel, Cérebro), não a
 * última aberta nem a de abertura. A barra aberta não usa isto (o item continua levando à abertura da página).
 */
export function railGroupSub(item: NavItemDef, empty: boolean, workspaceId: string | null): string | undefined {
  const first = visibleChildren(item, empty)[0];
  return first ? childSub(first, workspaceId) : item.sub;
}

export const SETTINGS_ITEM: NavItemDef = { page: "configuracoes", icon: "configuracoes", testId: "settings-button" };

export type Badge = { count: number; singular: string; plural: string; testId: string; tone?: "danger" };

/** O que o indicador de pastas de trabalho da barra mostra (função pura, para testar). */
export type FoldersSummary = {
  /** Quantas pastas o workspace tem. */
  count: number;
  /** Quantas delas os agentes podem alterar (leitura e escrita). */
  writable: number;
  /** Linha da barra: "Sem pasta de trabalho", o nome da pasta ou "Nome +N". */
  label: string;
  /** Dica (barra recolhida e `title`) e nome do botão para leitor de tela. */
  tip: string;
  aria: string;
};

export function foldersSummary(folders: readonly WorkFolder[] | undefined): FoldersSummary {
  const list = folders ?? [];
  const count = list.length;
  const writable = list.filter((folder) => folder.mode === "write").length;
  if (count === 0) {
    return { count, writable, label: "Sem pasta de trabalho", tip: "Sem pasta de trabalho. Clique para cadastrar", aria: "Pastas de trabalho: nenhuma cadastrada. Abrir para cadastrar" };
  }
  const first = list[0]!.name;
  const label = count === 1 ? first : `${first} +${count - 1}`;
  const plural = count === 1 ? "pasta" : "pastas";
  const access = writable === 0 ? "todas só de leitura" : writable === count ? (count === 1 ? "com escrita" : "todas com escrita") : `${writable} com escrita`;
  return {
    count,
    writable,
    label,
    tip: `${count} ${plural} de trabalho: ${list.map((folder) => folder.name).join(", ")}`,
    aria: `Pastas de trabalho: ${count} ${plural}, ${access}. Abrir para ver e editar`,
  };
}
