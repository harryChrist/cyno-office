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
  /** Contagem discreta à direita do nome (as abas do navegador, os scripts rodando). */
  counter?: NavCounterKind;
  /** Página de um workspace só: some quando não há workspace. */
  needsWorkspace?: boolean;
};

/** O que a contagem à direita de uma linha conta. */
export type NavCounterKind = "tabs" | "running";

/** Um grupo do menu: título pequeno (ou nenhum), as linhas e, se `separated`, um traço antes dele. */
export type NavSectionDef = { title: string | null; items: NavItemDef[]; separated?: boolean };

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
  scripts: "Os comandos demorados dos agentes, ao vivo",
  arquivos: "As pastas do workspace, para ler e baixar",
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

/**
 * O menu, de cima para baixo (abaixo do logo, do workspace e da pasta de trabalho): "Para você" (os quatro botões, em
 * `PARA_VOCE_BUTTONS`), Trabalho, Agentes ao vivo e, depois de um traço, Gestão e Biblioteca (grupos que abrem e fecham).
 * Configurações fica no rodapé.
 */
export const NAV_SECTIONS: NavSectionDef[] = [
  {
    title: "Trabalho",
    items: [
      { page: "office", icon: "office", testId: "nav-office", hint: PAGE_HINTS.office },
      { page: "trabalho", icon: "tarefas", testId: "nav-trabalho", hint: PAGE_HINTS.trabalho },
      { page: "para-voce", icon: "para-voce", testId: "nav-para-voce", hint: PAGE_HINTS["para-voce"] },
      { page: "quadro", icon: "quadro", testId: "nav-quadro", hint: PAGE_HINTS.quadro },
      { page: "arquivos", icon: "pasta", testId: "nav-arquivos", hint: PAGE_HINTS.arquivos, needsWorkspace: true },
    ],
  },
  {
    title: "Agentes ao vivo",
    items: [
      { page: "navegador", icon: "navegador", testId: "nav-navegador", label: "Navegador", hint: PAGE_HINTS.navegador, counter: "tabs", needsWorkspace: true },
      { page: "scripts", icon: "scripts", testId: "nav-scripts", label: "Scripts", hint: PAGE_HINTS.scripts, counter: "running", needsWorkspace: true },
    ],
  },
  {
    title: null,
    separated: true,
    items: [
      { page: "gestao", icon: "gestao", testId: "nav-gestao", hint: PAGE_HINTS.gestao, children: GESTAO_CHILDREN },
      { page: "biblioteca", icon: "biblioteca", testId: "nav-biblioteca", hint: PAGE_HINTS.biblioteca, children: BIBLIOTECA_CHILDREN },
    ],
  },
];

/** Sem workspace nenhum, só as páginas do app inteiro abrem (a Biblioteca e a Atividade do sistema). */
export const APP_WIDE_SECTIONS: NavSectionDef[] = [
  {
    title: null,
    items: [
      { page: "biblioteca", icon: "biblioteca", testId: "nav-biblioteca", hint: PAGE_HINTS.biblioteca, children: BIBLIOTECA_CHILDREN },
      { page: "gestao", sub: "atividade", icon: "logs", testId: "nav-atividade", label: "Atividade", hint: "O histórico do sistema" },
    ],
  },
];

/** Os quatro botões de "Para você": três abrem painéis (ou vão ao próximo alerta) e a Agenda vai à página "Sua agenda". */
export type ParaVoceId = "hoje" | "espera" | "avisos" | "agenda";
export type ParaVoceButtonDef = {
  id: ParaVoceId;
  /** Nome curto embaixo do ícone. */
  short: string;
  /** Nome inteiro (aria-label, dica). */
  label: string;
  icon: NavIconName;
  hint: string;
  needsWorkspace: boolean;
};

export const PARA_VOCE_BUTTONS: ParaVoceButtonDef[] = [
  { id: "hoje", short: "Hoje", label: "Hoje", icon: "hoje", hint: HOJE_HINT, needsWorkspace: true },
  { id: "espera", short: "Espera", label: "Esperando você", icon: "mao", hint: "O que espera a sua resposta", needsWorkspace: true },
  { id: "avisos", short: "Avisos", label: "Notificações", icon: "bell", hint: NOTIFICATIONS_HINT, needsWorkspace: true },
  { id: "agenda", short: "Agenda", label: "Sua agenda", icon: "calendario", hint: PAGE_HINTS.agenda ?? "", needsWorkspace: false },
];

/** Os botões de "Para você" que valem agora (sem workspace, só a Agenda). */
export function visibleParaVoce(empty: boolean): ParaVoceButtonDef[] {
  return PARA_VOCE_BUTTONS.filter((button) => !(empty && button.needsWorkspace));
}

/** As seções que valem agora: sem workspace, só as do app inteiro; sem linhas, a seção some (e o título dela). */
export function visibleSections(empty: boolean): NavSectionDef[] {
  const sections = empty ? APP_WIDE_SECTIONS : NAV_SECTIONS;
  return nonEmptySections(sections.map((section) => ({ ...section, items: section.items.filter((item) => !(empty && item.needsWorkspace)) })));
}

/** O texto da contagem à direita de uma linha; nada quando é zero. `number` e `word` separados: recolhida, só o número. */
export function counterParts(kind: NavCounterKind, count: number): { number: string; word: string; label: string } | null {
  if (count <= 0) return null;
  const word = kind === "running" ? "rodando" : count === 1 ? "aba" : "abas";
  return { number: String(count), word, label: `${count} ${word}` };
}

export function counterLabel(kind: NavCounterKind, count: number): string | null {
  return counterParts(kind, count)?.label ?? null;
}

/**
 * Um grupo (Gestão, Biblioteca) está aberto quando o dono o abriu, ou quando a página atual é dele (a não ser que o dono
 * o tenha fechado de propósito). `choice` é a escolha lembrada: `undefined` = nunca mexeu. No menu do celular (`drawer`)
 * quem nunca mexeu vê o grupo já aberto; no computador ele nasce fechado.
 */
export function isGroupOpen(item: NavItemDef, page: PageId, choice: boolean | undefined, drawer = false): boolean {
  return choice ?? (drawer || page === item.page);
}

/** Tira as seções que ficaram sem item (e, com isso, o título delas). */
export function nonEmptySections(sections: NavSectionDef[]): NavSectionDef[] {
  return sections.filter((section) => section.items.length > 0);
}

/** As páginas que o menu mostra em linhas (fora os quatro botões de "Para você" e o Cyno no topo). */
export function menuPages(sections: NavSectionDef[] = NAV_SECTIONS): PageId[] {
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

export type Badge = { count: number; singular: string; plural: string; testId: string; tone?: "danger" | "ok" };

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
