// O modo demonstração (`?demo=1`): o app inteiro abre com um escritório de mentira e vivo, sem servidor de agentes e
// sem IA. Aqui só as decisões puras (ler o endereço) e as respostas das rotas; a instalação do `fetch` e do socket
// de mentira está em `instalar.ts`.
import { DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME, TIMELINE_PART_MS, sliceTimeline, type Card, type DayStatsDaysResponse, type DemoOffice, type TimelineDaysResponse, type WaitingItem, type WaitingResponse, waitingHref } from "@cyno/shared";

export interface ParametrosDaDemo {
  seed: number;
  /** O instante "agora" do escritório de mentira (ms); sem `now` no endereço, o relógio de verdade. */
  now: number;
}

/** O endereço pede a demonstração? (`?demo=1`; `?demo=0` desliga.) */
export function pedeDemo(search: string): boolean {
  return new URLSearchParams(search).get("demo") === "1";
}

/** "2026-11-12T14:00" (hora de São Paulo), com segundos, com fuso (`Z`, `-03:00`) ou só o dia (meio-dia); `null` se não entender. */
export function instanteDeSaoPaulo(texto: string | null): number | null {
  if (!texto) return null;
  const completo = /(?:Z|[+-]\d{2}:?\d{2})$/.test(texto) ? texto : /^\d{4}-\d{2}-\d{2}$/.test(texto) ? `${texto}T12:00:00-03:00` : /T\d{2}:\d{2}$/.test(texto) ? `${texto}:00-03:00` : `${texto}-03:00`;
  const valor = Date.parse(completo);
  return Number.isFinite(valor) ? valor : null;
}

/** `?demo=1[&seed=7][&now=2026-11-12T14:00]` (a hora de `now` é a de São Paulo). */
export function parametrosDaDemo(search: string, agora: number): ParametrosDaDemo {
  const params = new URLSearchParams(search);
  const seed = Number(params.get("seed"));
  const textoDeAgora = params.get("now");
  const now = instanteDeSaoPaulo(textoDeAgora) ?? agora;
  return { seed: Number.isInteger(seed) && seed > 0 ? seed : 7, now };
}

export interface RespostaDeMentira {
  status: number;
  body: unknown;
  /** Texto cru (NDJSON da linha do tempo). */
  texto?: string;
}

const ok = (body: unknown): RespostaDeMentira => ({ status: 200, body });

/** A ficha do workspace de mentira, no formato de `GET /api/cyno/cards` (a cidade desenha o prédio por ela). */
export function fichaDaDemo(sim: DemoOffice): Card {
  const agentes = sim.agents.filter((agente) => agente.id !== "lia");
  const esperando = sim.forYou.filter((item) => item.status === "pendente");
  const maestro = sim.agents.find((agente) => agente.id === "lia")!;
  const busca = (id: string) => (sim.terminals[id]?.status === "busy" ? "busy" : "ready");
  const ativos = sim.projects.filter((projeto) => projeto.status === "ativo");
  return {
    workspace: DEMO_WORKSPACE_ID,
    name: DEMO_WORKSPACE_NAME,
    summary: { summary: "Um escritório de mentira para ver e mostrar o Cyno sem gastar IA.", by: "dono" },
    team: {
      rooms: sim.rooms.map((sala) => ({ id: sala.id, name: sala.name })),
      agents: agentes.map((agente) => ({ id: agente.id, name: agente.name, engine: "gemini", model: agente.model ?? "", focus: agente.role, terminal: busca(agente.id) as "ready" | "busy" })),
      maestro: { engine: "gemini", model: maestro.model ?? "", status: sim.terminals.lia?.status === "busy" ? "ocupado" : "ocioso" },
    },
    engines: [{ engine: "gemini", available: true }],
    sites: [],
    connectors: [],
    routines: [],
    projects: {
      active: ativos.map((projeto) => ({ id: projeto.id, title: projeto.title, status: projeto.status, done: projeto.tasks.filter((t) => t.status === "concluida").length, total: projeto.tasks.length })),
      counts: { ativo: ativos.length, concluido: sim.projects.length - ativos.length },
    },
    deliveries: sim.tasks
      .filter((t) => t.status === "done")
      .slice(-3)
      .map((t) => ({ title: t.prompt.split("\n")[0]!, at: t.updatedAt })),
    waitingForYou: esperando.length,
    waitingIds: esperando.map((item) => item.id),
    usage: { turns5h: sim.usage.length },
    updatedAt: new Date(sim.now).toISOString(),
  };
}

/**
 * Responde a uma rota de leitura com os dados do simulador. `null` = a demonstração não tem essa rota (o chamador
 * devolve 404). Escrita nunca chega aqui: o chamador recusa antes.
 */
export function responderDaDemo(sim: DemoOffice, caminho: string, consulta: URLSearchParams): RespostaDeMentira | null {
  const base = `/api/w/${DEMO_WORKSPACE_ID}`;
  if (caminho === "/api/auth/status") return ok({ enabled: false, authenticated: true });
  if (caminho === "/__backend-health") return ok({ up: true });
  if (caminho === "/api/cyno/cards") return ok({ cards: [fichaDaDemo(sim)] });
  if (caminho === "/api/cyno/waiting") return ok({ items: esperandoDaDemo(sim) } satisfies WaitingResponse);
  if (caminho === "/api/day-stats") return ok(plataformaDaDemo(sim));
  if (caminho === `${base}/day-stats`) return ok(sim.dayStats(consulta.get("day") ?? sim.day));
  if (caminho === `${base}/day-stats/days`) return ok({ days: sim.days(), clockFrom: new Date(sim.start).toISOString() } satisfies DayStatsDaysResponse);
  if (caminho === `${base}/timeline/days`) return ok({ recording: true, days: sim.timelineDays() } satisfies TimelineDaysResponse);
  const dia = new RegExp(`^${base}/timeline/(\\d{4}-\\d{2}-\\d{2})$`).exec(caminho);
  if (dia) {
    if (dia[1] !== sim.day) return { status: 404, body: { error: "não há gravação deste dia" } };
    const de = Number(consulta.get("from") ?? sim.start - 1);
    const ate = Number(consulta.get("to") ?? sim.now);
    if (!Number.isFinite(de) || !Number.isFinite(ate) || ate - de > 2 * TIMELINE_PART_MS) return { status: 400, body: { error: "recorte inválido" } };
    return { status: 200, body: null, texto: sliceTimeline(sim.dayRecords(), de, ate).map((r) => JSON.stringify(r)).join("\n") };
  }
  return null;
}

/** `GET /api/cyno/waiting`: os itens que esperam o dono, do mais antigo para o mais novo. */
function esperandoDaDemo(sim: DemoOffice): WaitingItem[] {
  return sim.forYou
    .filter((item) => item.status === "pendente")
    .map((item): WaitingItem => ({ workspace: DEMO_WORKSPACE_ID, workspaceName: DEMO_WORKSPACE_NAME, id: item.id, type: item.type, title: item.title ?? item.type, agent: sim.agents.find((a) => a.id === item.agentId)?.name, at: item.createdAt, href: waitingHref(DEMO_WORKSPACE_ID) }));
}

/** `GET /api/day-stats` (os workspaces somados): na demonstração, o único workspace. */
function plataformaDaDemo(sim: DemoOffice): unknown {
  const stats = sim.dayStats();
  return { day: sim.day, workspaces: [{ workspace: DEMO_WORKSPACE_ID, name: DEMO_WORKSPACE_NAME, stats }], totals: stats.totals };
}
