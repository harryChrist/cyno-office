/** As abas da Gestão: o Painel (a tela da manhã: a semana e o "Meu dia"), Rotinas e metas, Pessoas e as duas páginas que viraram abas (Gastos e Atividade) e os Relatórios (o resumo do dia, a revisão da semana e o mensal). */
export const GESTAO_TABS = [
  { id: "painel", label: "Painel", sub: "" },
  { id: "visao-geral", label: "Rotinas e metas", sub: "rotinas" },
  { id: "pessoas", label: "Pessoas", sub: "pessoas" },
  { id: "gastos", label: "Gastos", sub: "gastos" },
  { id: "atividade", label: "Atividade", sub: "atividade" },
  { id: "relatorios", label: "Relatórios", sub: "relatorios" },
] as const;
export type GestaoTabId = (typeof GESTAO_TABS)[number]["id"];

/**
 * A aba que o final do endereço (`#/<ws>/gestao/gastos`) pede. O endereço sem final abre o Painel; o `visao-geral`
 * de antes continua valendo como Rotinas e metas (nenhum link guardado quebra); qualquer outra coisa é o Painel.
 */
export function gestaoTabFromSub(sub: string): GestaoTabId {
  const first = sub.split("/")[0] ?? "";
  if (first === "visao-geral") return "visao-geral";
  return GESTAO_TABS.find((tab) => tab.sub !== "" && tab.sub === first)?.id ?? "painel";
}

/** Sem workspace só a Atividade (aba Sistema) abre: o resto é de um workspace. */
export function gestaoTabEnabled(tab: GestaoTabId, hasWorkspace: boolean): boolean {
  return hasWorkspace || tab === "atividade";
}
