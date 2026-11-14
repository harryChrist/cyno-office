// Festa e alarme da cena, por diferença entre um retrato e o anterior (o Cyno não tem eventos de GitHub: os gatilhos
// são do próprio Cyno). Puro: a memória entra e sai sem ser mutada. O passado não comemora: na primeira leitura
// (memória vazia) nada dispara, então recarregar a página não repete festa nem alarme.
import type { AgentTerminalInfo, ForYouItem, OfficeState, Project, Task } from "@cyno/shared";
import type { RoomEffect } from "@cyno/cena";

/** Quanto dura a festa. */
export const FESTA_MS = 12_000;
/** O alarme de tarefa que falhou some sozinho depois disso (ou quando uma tarefa conclui na sala). */
export const ALARME_MS = 10 * 60_000;
/** Terminal com erro há mais que isso vira alarme. */
export const ERRO_DE_TERMINAL_MS = 2 * 60_000;

export type EfeitoDaSala = RoomEffect;

/** O que os efeitos lembram entre chamadas. */
export type MemoriaDeEfeitos = {
  /** Item do "Para você" -> status visto (só os de sprint). */
  forYouVistos: ReadonlyMap<string, string>;
  /** Projeto -> status visto. */
  projetosVistos: ReadonlyMap<string, string>;
  /** Metas de rotina já comemoradas ("rotina:período"). */
  metasVistas: ReadonlySet<string>;
  /** Sala -> efeito ainda valendo (festa até `until`; alarme de tarefa que falhou até concluir algo na sala ou 10 min). */
  efeitos: ReadonlyMap<string, EfeitoDaSala>;
};

export const memoriaDeEfeitosVazia = (): MemoriaDeEfeitos => ({ forYouVistos: new Map(), projetosVistos: new Map(), metasVistas: new Set(), efeitos: new Map() });

export type EntradaDeEfeitos = {
  office: OfficeState;
  forYou: readonly ForYouItem[] | null;
  projects: readonly Project[];
  terminals: Readonly<Record<string, AgentTerminalInfo>>;
  /** Metas de rotina batidas ao vivo (o servidor avisa uma vez por meta e período; a carga inicial não traz). */
  metasBatidas?: readonly { key: string; title: string; agentId?: string; teamId?: string }[];
  /** Tarefas e status vistos na chamada anterior (vazio = primeira leitura). */
  tarefasAntes: ReadonlyMap<string, string>;
  /** Na primeira leitura nada dispara (só o que já está de pé, como o terminal com erro, vale). */
  primeira: boolean;
  agora: number;
};

const tempo = (iso: string | undefined): number => {
  const valor = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(valor) ? valor : Number.NaN;
};

const corta = (texto: string, max: number): string => (texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto);

/** Salas dos agentes dados (sem repetir, na ordem em que aparecem). */
function salasDosAgentes(office: OfficeState, ids: Iterable<string | undefined>): string[] {
  const salas: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const agente = office.agents.find((a) => a.id === id);
    const sala = agente ? office.teams.find((t) => t.id === agente.teamId)?.roomId : undefined;
    if (sala && !salas.includes(sala)) salas.push(sala);
  }
  return salas;
}

function festa(salas: readonly string[], texto: string, agentId: string | undefined, agora: number, destino: Map<string, EfeitoDaSala>): void {
  for (const sala of salas) {
    if (destino.get(sala)?.kind === "alarm") continue; // o alarme manda mais que a festa
    destino.set(sala, { kind: "party", text: corta(texto, 46), at: agora, until: agora + FESTA_MS, ...(agentId ? { agentId } : {}) });
  }
}

export function calcularEfeitos(e: EntradaDeEfeitos, memoria: MemoriaDeEfeitos): { efeitos: Map<string, EfeitoDaSala>; memoria: MemoriaDeEfeitos } {
  const { office, agora } = e;
  const efeitos = new Map<string, EfeitoDaSala>();
  // O que já valia e não expirou.
  for (const [sala, efeito] of memoria.efeitos) if (efeito.until > agora && office.rooms.some((r) => r.id === sala)) efeitos.set(sala, efeito);

  const forYouVistos = new Map<string, string>(memoria.forYouVistos);
  const projetosVistos = new Map<string, string>(memoria.projetosVistos);

  // ---- tarefa concluída na sala apaga o alarme dela; tarefa que falhou de verdade acende
  if (!e.primeira) {
    for (const tarefa of office.tasks) {
      const antes = e.tarefasAntes.get(tarefa.id);
      if (antes === undefined || antes === tarefa.status) continue;
      const sala = salasDosAgentes(office, [tarefa.agentId])[0];
      if (!sala || tarefa.role === "request") continue;
      if (tarefa.status === "done") {
        if (efeitos.get(sala)?.kind === "alarm" && !alarmeDeTerminal(efeitos.get(sala)!)) efeitos.delete(sala);
      } else if (tarefa.status === "failed" && tarefa.outcome !== "cancelled") {
        efeitos.set(sala, { kind: "alarm", text: corta(`Falhou: ${tituloDe(tarefa)}`, 46), at: agora, until: agora + ALARME_MS, agentId: tarefa.agentId });
      }
    }
  }

  // ---- sprint entregue (o dono aprovou o resumo de entrega)
  for (const item of e.forYou ?? []) {
    if (item.kind !== "sprint") continue;
    const antes = memoria.forYouVistos.get(item.id);
    forYouVistos.set(item.id, item.status);
    if (e.primeira || antes === undefined || antes === item.status || item.status !== "aprovado") continue;
    const projeto = e.projects.find((p) => p.id === item.projectId);
    const sprint = projeto?.sprints?.find((s) => s.id === item.sprintId);
    const donos = new Set((projeto?.tasks ?? []).filter((t) => t.sprintId === item.sprintId).map((t) => t.ownerId));
    if (donos.size === 0) donos.add(item.agentId);
    const nome = (sprint?.name ?? item.sprintId ?? "").trim();
    festa(salasDosAgentes(office, donos), /^sprint/i.test(nome) || !nome ? `${nome || "Sprint"} entregue!` : `Sprint ${nome} entregue!`, item.agentId, agora, efeitos);
  }

  // ---- meta de rotina batida (evento ao vivo: uma festa por meta e período)
  const metasVistas = new Set(memoria.metasVistas);
  for (const meta of e.metasBatidas ?? []) {
    const nova = !metasVistas.has(meta.key);
    metasVistas.add(meta.key);
    if (e.primeira || !nova) continue;
    const salaDoTime = meta.teamId ? office.teams.find((t) => t.id === meta.teamId)?.roomId : undefined;
    const salas = meta.agentId ? salasDosAgentes(office, [meta.agentId]) : salaDoTime && office.rooms.some((r) => r.id === salaDoTime) ? [salaDoTime] : [];
    festa(salas, `Meta batida: ${meta.title}!`, meta.agentId, agora, efeitos);
  }

  // ---- projeto concluído
  for (const projeto of e.projects) {
    const antes = memoria.projetosVistos.get(projeto.id);
    projetosVistos.set(projeto.id, projeto.status);
    if (e.primeira || antes === undefined || antes === projeto.status || projeto.status !== "concluido") continue;
    const donos = [...new Set(projeto.tasks.map((t) => t.ownerId))];
    festa(salasDosAgentes(office, donos), `Projeto ${projeto.title} concluído!`, donos[0], agora, efeitos);
  }

  // ---- terminal com erro há mais de 2 min (estado, não evento: vale também na primeira leitura e some ao normalizar)
  for (const terminal of Object.values(e.terminals)) {
    if (terminal.status !== "error") continue;
    const desde = tempo(terminal.updatedAt);
    if (!Number.isFinite(desde) || agora - desde < ERRO_DE_TERMINAL_MS) continue;
    const agente = office.agents.find((a) => a.id === terminal.agentId);
    const sala = agente ? salasDosAgentes(office, [agente.id])[0] : undefined;
    if (!sala || efeitos.get(sala)?.kind === "alarm") continue;
    efeitos.set(sala, { kind: "alarm", text: corta(`Terminal com erro: ${agente!.name}`, 46), at: desde + ERRO_DE_TERMINAL_MS, until: desde + ERRO_DE_TERMINAL_MS + ALARME_MS, agentId: agente!.id });
  }
  // O alarme de terminal que já normalizou sai (o de tarefa que falhou segue até concluir algo na sala).
  for (const [sala, efeito] of [...efeitos]) {
    if (!alarmeDeTerminal(efeito)) continue;
    const ainda = Object.values(e.terminals).some((t) => t.status === "error" && t.agentId === efeito.agentId);
    if (!ainda) efeitos.delete(sala);
  }

  return { efeitos, memoria: { forYouVistos, projetosVistos, metasVistas, efeitos } };
}

const alarmeDeTerminal = (efeito: EfeitoDaSala): boolean => efeito.kind === "alarm" && efeito.text.startsWith("Terminal com erro");

function tituloDe(tarefa: Task): string {
  return corta((tarefa.prompt.split("\n").find((l) => l.trim()) ?? "tarefa").trim(), 36);
}
