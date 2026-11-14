import {
  agentEngine,
  ENGINE_LABELS,
  type AttentionKind,
  fraseDeAtividade,
  findMaestroAgent,
  isActiveTaskStatus,
  type Agent,
  type AgentLogEntry,
  type AgentLogThread,
  type AgentTerminalInfo,
  type Blocked,
  type ForYouItem,
  type OfficeState,
  type Project,
  type Room,
  type Task,
  type Team,
} from "@cyno/shared";
import type { AccountInfo, Activity, AgentInfo, OfficeSnapshot, RoomInfo, TaskItem } from "@cyno/cena";
import { runningSubagents } from "./subagentes";
import type { TaskProgressMap } from "../../store/taskProgress";
import { avatarParaPartes, parecenca, partesDoMaestro } from "./avatar";
import { calcularEfeitos } from "./efeitos";
import { decidirEstado, type EstadoDecidido } from "./estados";
import { hash32 } from "./hash";
import { RESULTADO_MS, SAIDA_MS, SUB_TERMINADO_MS, type MemoriaDaCena, type ResultadoDeTarefa } from "./memoria";
import { sementeDaSala } from "./temas";

export { memoriaInicial, memoriaDeJson, memoriaParaJson, type MemoriaDaCena } from "./memoria";

/** Quantos subagentes aparecem por agente (o resto vira "+N" na atividade do pai). */
export const MAX_SUBAGENTES = 6;
/** Quantas tarefas vão para o quadro da parede de cada agente. */
export const MAX_TAREFAS = 15;
const VINTE_E_QUATRO_HORAS = 24 * 3_600_000;
/** Id de sala que o motor não conhece: ele manda o personagem esperar na recepção. */
export const SALA_DESCONHECIDA = "?";

/** O estado do Cyno de que o adaptador precisa (já lido das lojas Zustand). */
export type EntradaDoRetrato = {
  workspaceId: string;
  workspaceName: string;
  office: OfficeState;
  progress: TaskProgressMap;
  /** "Para você" do workspace (null = ainda não carregado). */
  forYou: readonly ForYouItem[] | null;
  projects: readonly Project[];
  terminals: Readonly<Record<string, AgentTerminalInfo>>;
  /** Log recente por agente (só as últimas entradas importam). */
  logs: Readonly<Record<string, readonly AgentLogEntry[]>>;
  /** Agentes com o motor indisponível (sem cota): id -> rótulo pronto. */
  indisponiveis: Readonly<Record<string, { label: string }>>;
  /** Tokens do dia por agente, se houver (só informativo: o motor não os lê). */
  tokens?: Readonly<Record<string, { entrada: number; saida: number }>>;
  /**
   * Só na reprodução do dia: a ferramenta em uso e os subagentes de cada agente já prontos (o quadro gravado os traz;
   * não há log para ler). Sem estes campos, valem o log e as regras de sempre.
   */
  ferramentas?: Readonly<Record<string, FerramentaEmUso>>;
  subagentes?: Readonly<Record<string, readonly AgentLogThread[]>>;
  /** Metas de rotina batidas ao vivo (a festa do mapa). */
  metasBatidas?: readonly { key: string; title: string; agentId?: string; teamId?: string }[];
  /** Quem espera o dono segundo a cadeia de atenção: id do agente -> tipo e quantidade (ver `agentAttentionOf`). */
  atencao?: ReadonlyMap<string, { kind: AttentionKind; count: number }>;
  /** `Date.now()` injetado (testável). */
  agora: number;
};

export type SaidaDoRetrato = { snapshot: OfficeSnapshot; memoria: MemoriaDaCena };

/** Nome da sala na placa, com o número de itens que esperam o dono ("Dev · 2 esperam"). */
export const nomeDaPlaca = (nome: string, esperando: number): string => (esperando > 0 ? `${nome} · ${esperando} ${esperando === 1 ? "espera" : "esperam"}` : nome);

const corta = (texto: string, max: number): string => (texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto);
const primeiraLinha = (texto: string, max: number): string => corta((texto.split("\n").find((linha) => linha.trim()) ?? "").trim(), max);
const tempo = (iso: string | undefined, padrao: number): number => {
  const valor = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(valor) ? valor : padrao;
};

/** A ferramenta em uso (ou usada há pouco) por um agente: a frase pronta, o tipo de atividade e o nome bruto. */
export type FerramentaEmUso = { id: string; quando: number; icon: string; text: string; kind: Activity["kind"]; tool: string; error?: boolean };

/** Quanto tempo depois de acabar a ferramenta ainda dá a frase (o balão não pisca entre duas chamadas seguidas). */
export const FERRAMENTA_RECENTE_MS = 8_000;

/** Tipo de atividade (o motor escolhe a tela do monitor por ele) a partir do nome bruto da ferramenta. */
export function tipoDaFerramenta(nome: string): Activity["kind"] {
  const n = nome.toLowerCase();
  if (n.includes("browser") || n.includes("navegador")) return "browser";
  if (/(send_to_colleague|request_help|ask_colleague)/.test(n)) return "communicate";
  if (n.startsWith("mcp__")) return "mcp";
  if (/(todo|plan)/.test(n)) return "plan";
  if (/^(read|view|cat|ls|glob|list|open)/.test(n) || n.includes("read_file") || n.includes("list_dir")) return "read";
  if (/(grep|search_files|find|codebase_search)/.test(n)) return "search";
  if (/(websearch|webfetch|web_search|web_fetch|fetch|google)/.test(n)) return "web";
  if (/(multiedit|edit|replace|patch)/.test(n)) return "edit";
  if (/(write|create_file)/.test(n)) return "write";
  if (/(task|agent|subagent|delegate)/.test(n)) return "delegate";
  if (/(bash|shell|run_command|exec|terminal)/.test(n)) return "run";
  if (/skill/.test(n)) return "skill";
  return "other";
}

/**
 * A ferramenta em uso pelo próprio agente (não pelos subagentes), olhando só as últimas entradas do log: a que ainda
 * roda, ou a última que acabou há menos de `FERRAMENTA_RECENTE_MS`. Sem log (reinício do servidor), não há frase.
 */
export function ferramentaEmUso(log: readonly AgentLogEntry[] | undefined, agora: number): FerramentaEmUso | undefined {
  if (!log) return undefined;
  for (let i = log.length - 1; i >= Math.max(0, log.length - 50); i--) {
    const entrada = log[i]!;
    if (entrada.kind !== "tool" || entrada.thread) continue;
    if (entrada.status !== "running" && agora - tempo(entrada.at, 0) > FERRAMENTA_RECENTE_MS) return undefined;
    const frase = entrada.phrase ?? fraseDeAtividade({ name: entrada.name, input: entrada.input });
    return { id: entrada.toolUseId, quando: tempo(entrada.at, agora), icon: frase.icon, text: frase.text, kind: tipoDaFerramenta(entrada.name), tool: entrada.name, ...(entrada.status === "error" ? { error: true } : {}) };
  }
  return undefined;
}

/**
 * A frase de atividade de quem trabalha: a da ferramenta em uso ("📖 Lendo package.json") quando há; senão o texto
 * de progresso que o Cyno já tem ("Pesquisando referências · 40%"); sem progresso, o título da tarefa.
 */
export function textoDeProgresso(
  progresso: { message: string; progress: number } | undefined,
  titulo: string | undefined,
  ferramenta?: FerramentaEmUso,
): { texto: string; kind: Activity["kind"]; icone?: string; tool?: string; chave?: string } {
  if (ferramenta) return { texto: ferramenta.text, kind: ferramenta.kind, icone: ferramenta.icon, tool: ferramenta.tool, chave: ferramenta.id };
  const mensagem = progresso?.message.trim();
  if (progresso && mensagem) {
    const pct = Math.round(progresso.progress * 100);
    const sufixo = pct > 0 && pct < 100 ? ` · ${pct}%` : "";
    return { texto: corta(`${mensagem}${sufixo}`, 46), kind: "other" };
  }
  return { texto: corta(titulo ? `Trabalhando em «${titulo}»` : "Trabalhando", 46), kind: "think" };
}

/**
 * Salas na ordem do retrato: a do Maestro primeiro (vaga 0, a mais perto da recepção). As que o prédio já conhecia
 * (`ordem`, guardada entre recargas) seguem na ordem em que chegaram; as novas entram depois delas, pela posição
 * antiga no mapa (linha, coluna) e pela criação. Assim criar uma sala nunca muda a vaga das outras, nem recarregar.
 */
export function ordenarSalas(salas: readonly Room[], ordem: ReadonlyMap<string, number> = new Map()): Room[] {
  return salas
    .map((sala, indice) => ({ sala, indice }))
    .sort((a, b) => {
      const ma = a.sala.kind === "maestro" ? 0 : 1;
      const mb = b.sala.kind === "maestro" ? 0 : 1;
      const oa = ordem.get(a.sala.id) ?? Number.MAX_SAFE_INTEGER;
      const ob = ordem.get(b.sala.id) ?? Number.MAX_SAFE_INTEGER;
      return ma - mb || oa - ob || a.sala.gridPosition.y - b.sala.gridPosition.y || a.sala.gridPosition.x - b.sala.gridPosition.x || a.indice - b.indice;
    })
    .map((x) => x.sala);
}

/** A ordem de chegada depois deste retrato: só as salas que existem, as conhecidas com a mesma ordem, as novas no fim. */
export function ordemDasSalasDepois(salasEmOrdem: readonly Room[], antes: ReadonlyMap<string, number>): Map<string, number> {
  const depois = new Map<string, number>();
  let proxima = Math.max(-1, ...[...antes.values()]) + 1;
  for (const sala of salasEmOrdem) depois.set(sala.id, antes.get(sala.id) ?? proxima++);
  return depois;
}

function tarefaAtivaDe(tarefas: readonly Task[]): Task | undefined {
  const ativas = tarefas.filter((t) => t.status === "in_progress" || t.status === "waiting_approval");
  return ativas.at(-1);
}

function itensDaParede(tarefas: readonly Task[], projetos: readonly Project[], agora: number): TaskItem[] {
  const titulo = (t: Task): string => {
    const doProjeto = t.work ? projetos.find((p) => p.id === t.work!.projectId)?.tasks.find((pt) => pt.ref === t.work!.ref)?.title : undefined;
    return doProjeto ?? primeiraLinha(t.prompt, 60);
  };
  const ativas = tarefas.filter((t) => isActiveTaskStatus(t.status));
  const recentes = tarefas.filter((t) => (t.status === "done" || (t.status === "failed" && t.outcome !== "cancelled")) && agora - tempo(t.updatedAt, 0) <= VINTE_E_QUATRO_HORAS);
  const ordemAtiva = (t: Task) => (t.status === "queued" ? 1 : 0);
  const ativosOrdenados = [...ativas].sort((a, b) => ordemAtiva(a) - ordemAtiva(b));
  return [...ativosOrdenados, ...recentes].slice(0, MAX_TAREFAS).map((t) => ({
    id: t.id,
    title: titulo(t),
    status: t.status === "queued" ? ("pending" as const) : t.status === "in_progress" || t.status === "waiting_approval" ? ("in_progress" as const) : ("completed" as const),
  }));
}

function bloqueioDe(agentId: string, projetos: readonly Project[]): Blocked | undefined {
  let achado: Blocked | undefined;
  for (const projeto of projetos) {
    for (const tarefa of projeto.tasks) {
      if (tarefa.ownerId !== agentId || !tarefa.blocked) continue;
      if (tarefa.status === "concluida" || tarefa.status === "falhou" || tarefa.status === "cancelada") continue;
      if (!achado || tempo(tarefa.blocked.since, Infinity) < tempo(achado.since, Infinity)) achado = tarefa.blocked;
    }
  }
  return achado;
}

function atividadeDe(estado: EstadoDecidido, resultado: ResultadoDeTarefa | undefined, progresso: { message: string; progress: number } | undefined, titulo: string | undefined, em: number, taskKey: string, ferramenta?: FerramentaEmUso): Activity | undefined {
  if (resultado) {
    return resultado.falhou
      ? { id: `fail:${resultado.taskId}`, kind: "error", icon: "😓", text: corta(`Falhou: ${resultado.titulo}`, 46), error: true, at: em }
      : { id: `done:${resultado.taskId}`, kind: "done", icon: "✅", text: corta(`Concluiu: ${resultado.titulo}`, 46), at: em };
  }
  if (estado.status === "working") {
    if (estado.conversando) return { id: `chat:${taskKey}`, kind: "respond", icon: "💬", text: "Conversando com você", at: em };
    const { texto, kind, icone, tool, chave } = textoDeProgresso(progresso, titulo, ferramenta);
    return { id: chave ? `tool:${chave}` : `prog:${taskKey}:${texto}`, kind, icon: icone ?? "⚙️", text: texto, ...(tool ? { tool } : {}), ...(ferramenta?.error ? { error: true } : {}), at: ferramenta ? ferramenta.quando : em };
  }
  if (estado.status === "waiting" && estado.waitingFor) return { id: `ask:${taskKey}:${estado.waitingFor}`, kind: "ask", icon: "✋", text: corta(estado.waitingFor, 46), detail: estado.waitingFor, at: em };
  if (estado.status === "shell" && estado.espera) return { id: `wait:${estado.espera.id}:${estado.espera.rotulo}`, kind: "wait", icon: "⏳", text: corta(estado.espera.rotulo, 46), at: em };
  return undefined;
}

const CONTA_DO_MOTOR: Record<string, { short: string; color: string }> = {
  claude: { short: "C", color: "#d97757" },
  gemini: { short: "A", color: "#4a8bf5" },
  mock: { short: "S", color: "#8a8fb3" },
};

function contasDe(agentes: readonly AgentInfo[]): AccountInfo[] {
  const sessoes = new Map<string, number>();
  for (const a of agentes) if (a.kind === "main") sessoes.set(a.account, (sessoes.get(a.account) ?? 0) + 1);
  return [...sessoes.entries()].map(([id, n]) => {
    const conhecida = CONTA_DO_MOTOR[id];
    const nome = ENGINE_LABELS[id as keyof typeof ENGINE_LABELS] ?? id;
    return { id, short: conhecida?.short ?? id.charAt(0).toUpperCase(), name: nome, color: conhecida?.color ?? "#8a8fb3", configDir: "", sessions: n, usageStatus: "disabled" as const };
  });
}

/**
 * Estado do Cyno -> `OfficeSnapshot` do motor. Pura: o relógio entra por `agora` e a memória entra e sai sem ser
 * mutada. Identidade (id, semente, aparência) vem do id do agente; a mesa vem da ordem (sala, time, líder, chegada).
 */
export function montarRetrato(e: EntradaDoRetrato, memoria: MemoriaDaCena): SaidaDoRetrato {
  const { office, agora } = e;
  const primeira = memoria.tarefasVistas.size === 0 && memoria.presentes.size === 0 && memoria.primeiraVez.size === 0;
  const salas = ordenarSalas(office.rooms, memoria.ordemDasSalas);
  const ordemDasSalas = ordemDasSalasDepois(salas, memoria.ordemDasSalas);
  const indiceDaSala = new Map(salas.map((s, i) => [s.id, i]));
  const times = new Map<string, Team>(office.teams.map((t) => [t.id, t]));
  const indiceDoTime = new Map(office.teams.map((t, i) => [t.id, i]));
  const maestro = findMaestroAgent(office);
  const pendentesPorAgente = new Map<string, ForYouItem[]>();
  for (const item of e.forYou ?? []) {
    if (item.status !== "pendente") continue;
    pendentesPorAgente.set(item.agentId, [...(pendentesPorAgente.get(item.agentId) ?? []), item]);
  }

  // ---- memória que vai sendo reconstruída
  const primeiraVez = new Map(memoria.primeiraVez);
  const desde = new Map<string, { chave: string; em: number }>();
  const resultados = new Map<string, ResultadoDeTarefa>();
  const saindo = new Map<string, number>();
  const presentes = new Set<string>();
  const tarefasVistas = new Map<string, string>(office.tasks.map((t) => [t.id, t.status]));
  for (const [id, r] of memoria.resultados) if (r.ate > agora) resultados.set(id, r);

  // ---- a ordem de chegada: quem ainda não tinha sido visto chega agora, na ordem do array
  for (const agente of office.agents) if (!primeiraVez.has(agente.id)) primeiraVez.set(agente.id, agora);
  // Agente apagado sai da memória (ela vai ao localStorage por workspace); lista vazia pode ser só carregamento: não poda.
  if (office.agents.length > 0) {
    const vivos = new Set(office.agents.map((agente) => agente.id));
    for (const id of [...primeiraVez.keys()]) if (!vivos.has(id)) primeiraVez.delete(id);
  }

  type Montado = { info: AgentInfo; sala: number; time: number; lider: boolean; chegada: number; indice: number };
  const montados: Montado[] = [];

  office.agents.forEach((agent: Agent, indice) => {
    const time = times.get(agent.teamId);
    const salaId = time && indiceDaSala.has(time.roomId) ? time.roomId : SALA_DESCONHECIDA;
    const ehMaestro = agent.id === maestro?.id;
    const minhas = office.tasks.filter((t) => t.agentId === agent.id);
    const tarefaAtiva = tarefaAtivaDe(minhas);
    const progressoDaTarefa = tarefaAtiva ? e.progress[tarefaAtiva.id] : undefined;
    const delegando = ehMaestro
      ? office.tasks.filter((t) => t.agentId === agent.id && t.role === "request" && isActiveTaskStatus(t.status)).flatMap((pedido) => office.tasks.filter((s) => s.projectId === pedido.id && isActiveTaskStatus(s.status)).map((s) => times.get(s.teamId)?.name ?? "").filter(Boolean))
      : [];
    const unicos = [...new Set(delegando)];
    const estado = decidirEstado({
      agent,
      maestro: ehMaestro,
      temTarefaAtiva: tarefaAtiva !== undefined,
      terminal: e.terminals[agent.id],
      indisponivel: e.indisponiveis[agent.id]?.label,
      pendentes: pendentesPorAgente.get(agent.id) ?? [],
      progresso: progressoDaTarefa?.message,
      bloqueio: bloqueioDe(agent.id, e.projects),
      delegandoA: unicos,
      atencao: e.atencao?.get(agent.id),
    });

    // ---- quem desligou o terminal desce pelo elevador e some; quem nunca esteve presente nem aparece
    if (estado.status === "offline") {
      const ate = memoria.saindo.get(agent.id) ?? (memoria.presentes.has(agent.id) ? agora + SAIDA_MS : undefined);
      if (ate === undefined || ate <= agora) return;
      saindo.set(agent.id, ate);
    } else {
      presentes.add(agent.id);
    }

    // ---- transição de tarefa: o passado não comemora (sem memória, nada)
    for (const t of minhas) {
      const antes = memoria.tarefasVistas.get(t.id);
      if (!primeira && antes !== undefined && antes !== t.status && t.role !== "request") {
        if (t.status === "done") resultados.set(agent.id, { taskId: t.id, titulo: primeiraLinha(t.prompt, 40), falhou: false, ate: agora + RESULTADO_MS });
        else if (t.status === "failed" && t.outcome !== "cancelled") resultados.set(agent.id, { taskId: t.id, titulo: primeiraLinha(t.prompt, 40), falhou: true, ate: agora + RESULTADO_MS });
      }
    }

    const tituloAtivo = tarefaAtiva ? (tarefaAtiva.work ? e.projects.find((p) => p.id === tarefaAtiva.work!.projectId)?.tasks.find((pt) => pt.ref === tarefaAtiva.work!.ref)?.title : undefined) ?? primeiraLinha(tarefaAtiva.prompt, 60) : undefined;

    // ---- desde quando o estado vale
    const chave = `${estado.status}|${estado.waitingFor ?? ""}|${estado.espera?.rotulo ?? ""}|${tarefaAtiva?.id ?? ""}`;
    const anterior = memoria.desde.get(agent.id);
    let em: number;
    if (anterior && anterior.chave === chave) em = anterior.em;
    else {
      const ultimaConcluida = minhas.filter((t) => t.status === "done").map((t) => tempo(t.updatedAt, 0)).sort((a, b) => b - a)[0];
      const candidato = tarefaAtiva ? tempo(tarefaAtiva.updatedAt, agora) : estado.status === "idle" && ultimaConcluida ? ultimaConcluida : agora;
      em = Math.min(candidato, agora);
    }
    desde.set(agent.id, { chave, em });

    const resultado = resultados.get(agent.id);
    const log = e.logs[agent.id];
    const atividade = atividadeDe(estado, resultado, progressoDaTarefa, tituloAtivo, em, tarefaAtiva?.id ?? "-", e.ferramentas ? e.ferramentas[agent.id] : ferramentaEmUso(log, agora));
    const ultimoEvento = Math.max(em, log && log.length > 0 ? tempo(log[log.length - 1]!.at, 0) : 0);
    const sementeBit = hash32(agent.id) & 1;
    const ativos = e.subagentes ? (e.subagentes[agent.id] ?? []) : log ? runningSubagents(log) : [];
    const motor = agentEngine(agent);
    const tokens = e.tokens?.[agent.id];
    const extras = ativos.length - MAX_SUBAGENTES;
    const atividadeFinal = atividade && extras > 0 ? { ...atividade, detail: `${atividade.detail ?? atividade.text} (+${extras} subagentes)` } : atividade;

    const info: AgentInfo = {
      id: agent.id,
      kind: "main",
      roomId: salaId,
      name: corta(agent.name, 24),
      look: parecenca(agent.avatar, sementeBit),
      role: ehMaestro ? "Maestro" : agent.role,
      ...(tituloAtivo ? { title: tituloAtivo } : {}),
      sessionId: agent.id,
      account: motor,
      status: estado.status,
      ...(estado.waitingFor ? { waitingFor: estado.waitingFor } : {}),
      ...(atividadeFinal ? { activity: atividadeFinal } : {}),
      recent: [],
      tasks: ehMaestro ? [] : itensDaParede(minhas.filter((t) => t.role !== "request"), e.projects, agora),
      ...(estado.espera ? { shells: [{ id: estado.espera.id, label: estado.espera.rotulo, startedAt: estado.espera.desde ?? em, background: true, kind: "shell" as const }] } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      startedAt: primeiraVez.get(agent.id) ?? agora,
      lastEventAt: ultimoEvento,
      statusSince: em,
      stats: { toolCalls: 0, tokensIn: tokens?.entrada ?? 0, tokensOut: tokens?.saida ?? 0, subagents: ativos.length },
      seed: hash32(agent.id),
      parts: ehMaestro ? partesDoMaestro(agent.avatar) : avatarParaPartes(agent.avatar),
    };
    montados.push({
      info,
      sala: salaId === SALA_DESCONHECIDA ? Number.MAX_SAFE_INTEGER : (indiceDaSala.get(salaId) ?? 0),
      time: time ? (indiceDoTime.get(time.id) ?? 0) : Number.MAX_SAFE_INTEGER,
      lider: time?.leadAgentId === agent.id,
      chegada: primeiraVez.get(agent.id) ?? agora,
      indice,
    });
  });

  montados.sort((a, b) => a.sala - b.sala || a.time - b.time || Number(b.lider) - Number(a.lider) || a.chegada - b.chegada || a.indice - b.indice);

  // ---- subagentes: personagens com crachá, logo depois do pai
  const subsAtivos = new Map<string, AgentInfo>();
  const subsTerminados = new Map<string, { sub: AgentInfo; ate: number }>();
  const idsPresentes = new Set(montados.filter((m) => m.info.status !== "offline").map((m) => m.info.id));
  const subsPorPai = new Map<string, AgentInfo[]>();
  for (const m of montados) {
    const pai = m.info;
    if (!idsPresentes.has(pai.id)) continue;
    const log = e.logs[pai.id];
    const ativos = e.subagentes ? (e.subagentes[pai.id] ?? []) : log ? runningSubagents(log) : [];
    for (const thread of ativos.slice(0, MAX_SUBAGENTES)) {
      const id = `${pai.id}::${thread.id}`;
      const inicio = tempo(thread.startedAt, agora);
      const sub: AgentInfo = {
        id,
        kind: "sub",
        parentId: pai.id,
        roomId: pai.roomId,
        name: corta(thread.label, 24),
        look: parecenca({ hair: "short" }, hash32(id) & 1),
        role: corta(thread.label, 24),
        title: corta(thread.goal || thread.label, 80),
        sessionId: pai.id,
        account: pai.account,
        status: "working",
        activity: { id: `sub:${id}`, kind: "think", icon: "🧩", text: corta(thread.goal || thread.label, 46), at: inicio },
        recent: [],
        tasks: [],
        ...(thread.model ? { model: thread.model } : {}),
        startedAt: inicio,
        lastEventAt: inicio,
        statusSince: inicio,
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
        seed: hash32(id),
      };
      subsAtivos.set(id, sub);
      subsPorPai.set(pai.id, [...(subsPorPai.get(pai.id) ?? []), sub]);
    }
  }
  // Os que sumiram desde o último retrato terminaram: ficam `done` por 25 s para o motor entregar ao pai.
  for (const [id, sub] of memoria.subsAtivos) {
    if (subsAtivos.has(id) || !idsPresentes.has(sub.parentId ?? "")) continue;
    subsTerminados.set(id, { sub: { ...sub, status: "done", statusSince: agora, lastEventAt: agora }, ate: agora + SUB_TERMINADO_MS });
  }
  for (const [id, termino] of memoria.subsTerminados) {
    if (termino.ate <= agora || subsAtivos.has(id) || subsTerminados.has(id) || !idsPresentes.has(termino.sub.parentId ?? "")) continue;
    subsTerminados.set(id, termino);
  }
  for (const { sub } of subsTerminados.values()) subsPorPai.set(sub.parentId!, [...(subsPorPai.get(sub.parentId!) ?? []), sub]);

  const agentes: AgentInfo[] = [];
  for (const m of montados) {
    agentes.push(m.info);
    agentes.push(...(subsPorPai.get(m.info.id) ?? []));
  }

  const { efeitos, memoria: memoriaDeEfeitos } = calcularEfeitos({ office, forYou: e.forYou, ...(e.metasBatidas ? { metasBatidas: e.metasBatidas } : {}), projects: e.projects, terminals: e.terminals, tarefasAntes: memoria.tarefasVistas, primeira, agora }, memoria.efeitos);

  // A placa da sala mostra quantos itens esperam o dono ali (o nome da placa é o único lugar que o motor oferece).
  const esperandoPorSala = new Map<string, number>();
  for (const m of montados) {
    const n = e.atencao?.get(m.info.id)?.count ?? 0;
    if (n > 0) esperandoPorSala.set(m.info.roomId, (esperandoPorSala.get(m.info.roomId) ?? 0) + n);
  }

  const infoSalas: RoomInfo[] = salas.map((sala, posicao) => ({
    id: sala.id,
    name: nomeDaPlaca(sala.kind === "maestro" ? "Maestro" : sala.name, esperandoPorSala.get(sala.id) ?? 0),
    path: `${e.workspaceId}/${sala.id}`,
    slot: posicao,
    seed: sementeDaSala(sala),
    createdAt: posicao,
    ...(sala.kind === "maestro" ? { kind: "maestro" as const } : {}),
    ...(efeitos.has(sala.id) ? { effect: efeitos.get(sala.id) } : {}),
  }));

  const snapshot: OfficeSnapshot = {
    rev: memoria.rev + 1,
    serverTime: agora,
    rooms: infoSalas,
    agents: agentes,
    accounts: contasDe(agentes),
    meta: { demo: false, sources: [], startedAt: memoria.inicio, version: "cyno" },
  };

  return {
    snapshot,
    memoria: { primeiraVez, ordemDasSalas, desde, subsAtivos, subsTerminados, tarefasVistas, resultados, saindo, presentes, efeitos: memoriaDeEfeitos, rev: snapshot.rev, inicio: memoria.inicio },
  };
}
