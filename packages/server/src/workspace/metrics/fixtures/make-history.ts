import {
  dayKeyOf,
  dayStart,
  DAY_MS,
  emptyAvulsas,
  periodKey,
  projectDefaults,
  projectTaskDefaults,
  type ActivityEntry,
  type BlockedSpan,
  type ForYouItem,
  type Project,
  type ProjectTask,
  type Routine,
  type RoutineEntry,
  type Task,
  type UsageRecord,
} from "@cyno/shared";
import { spIso } from "../../activity/time";

/**
 * Histórico fabricado de vários dias, DETERMINÍSTICO (gerador mulberry32 com a semente): a mesma entrada dá o
 * mesmo histórico, sem relógio e sem fuso da máquina. Os testes unitários usam em memória (com `now` fixo);
 * `dev/history-seed.ts` grava o mesmo histórico em disco para o app de teste. Tudo que ele cria leva a marca de
 * semente: ids com prefixo `seed-` (e `A-` nos itens do Para você, com `meta.seed`), `source: "seed"` no gasto e
 * `data.seed: true` na Atividade.
 *
 * Os agentes ganham, na ordem, estes perfis (repetem se houver mais que cinco):
 * 1. `rapido`: bom e rápido, quase não é recusado;
 * 2. `editado`: o dono mexe muito (corta emoji: `originalText` com emoji, `text` sem);
 * 3. `recusado`: recusado por "tom formal demais";
 * 4. `lento`: demora para começar e para fazer;
 * 5. `cota`: falha por cota e tem uma tarefa travada sem cota.
 * Os dados novos da fatia 3 entram sempre (`queuedAt`, `blockedSpans`, `failureKind`, `rejection.category`);
 * `stripNewFields` os tira para provar que registros antigos continuam valendo.
 * Mais: a espera do dono em 3 faixas (minutos, horas, mais de 1 dia) e um item pendente há 2 dias; quatro
 * projetos (um atrasado, um no prazo, dois concluídos); uma rotina com entregas; custo variando pelo modelo.
 */

export type HistoryAgent = { id: string; name: string; roomId?: string; teamId?: string };
export type HistoryOptions = {
  /** O "agora" do histórico (ms). */
  now: number;
  /** Quantos dias para trás (o dia de hoje conta como o primeiro). */
  days: number;
  seed: number;
  agents: readonly HistoryAgent[];
  /** Dono dos registros de pedido (o Maestro); padrão "seed-maestro". */
  maestroId?: string;
  workspaceId?: string;
  /** Liga as metas da semente (uma que fecha no ritmo atual e uma que não): ficam de fora por padrão para não mexer nas contas dos testes antigos. */
  goals?: boolean;
  /** Liga o padrão da retrospectiva (cinco recusas de "tom formal demais" do agente recusado): fora por padrão, para não mexer nas contas dos testes antigos. */
  retro?: boolean;
};

export type History = {
  tasks: Task[];
  projects: Project[];
  forYou: ForYouItem[];
  usage: UsageRecord[];
  routines: Routine[];
  entries: RoutineEntry[];
  activity: ActivityEntry[];
};

/** A rotina da semente (um id alto para não colidir com as do app de teste). */
export const SEED_ROUTINE_ID = "R-0900";
/** Todas as rotinas da semente (a de comentários e as duas metas de `goals: true`). */
export const SEED_ROUTINE_IDS: readonly string[] = [SEED_ROUTINE_ID, "R-0901", "R-0902"];

/** Categoria rápida da recusa pelo motivo que o perfil dá. */
const CATEGORY_OF_REASON: Record<string, string> = { "tom formal demais": "tom", "fora do assunto": "fora_do_pedido", "faltou um exemplo": "texto", "ficou longo": "formato" };

/** Tira os dados novos da fatia 3 (como se os registros fossem antigos): `queuedAt`, `blockedSpans`, `failureKind` e `rejection.category`. */
export function stripNewFields(history: History): History {
  const copy = structuredClone(history);
  for (const task of copy.tasks) delete task.failureKind;
  for (const item of copy.forYou) if (item.rejection) delete item.rejection.category;
  for (const project of copy.projects) {
    for (const task of project.tasks) {
      delete task.queuedAt;
      delete task.blockedSpans;
    }
  }
  return copy;
}

export const PROFILE_IDS = ["rapido", "editado", "recusado", "lento", "cota"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

type Profile = {
  /** Pedidos por dia útil. */
  rate: number;
  queueMin: [number, number];
  workMin: [number, number];
  types: string[];
  reject: number;
  rejectReason: string;
  edit: number;
  editKind: "emoji" | "leve";
  fail: number;
  provider: "claude" | "gemini";
  model: string;
  engine: "claude" | "gemini";
};

export const PROFILES: Record<ProfileId, Profile> = {
  rapido: { rate: 1.3, queueMin: [1, 4], workMin: [8, 22], types: ["comentario", "post"], reject: 0.05, rejectReason: "faltou um exemplo", edit: 0.1, editKind: "leve", fail: 0.02, provider: "claude", model: "claude-sonnet-5-5", engine: "claude" },
  editado: { rate: 1.1, queueMin: [2, 8], workMin: [10, 30], types: ["comentario"], reject: 0.08, rejectReason: "fora do assunto", edit: 0.65, editKind: "emoji", fail: 0.03, provider: "claude", model: "claude-haiku-5-5", engine: "claude" },
  recusado: { rate: 1.0, queueMin: [2, 10], workMin: [12, 35], types: ["comentario", "convite"], reject: 0.4, rejectReason: "tom formal demais", edit: 0.15, editKind: "leve", fail: 0.03, provider: "claude", model: "claude-sonnet-5-5", engine: "claude" },
  lento: { rate: 0.7, queueMin: [30, 180], workMin: [60, 190], types: ["post"], reject: 0.1, rejectReason: "ficou longo", edit: 0.2, editKind: "leve", fail: 0.04, provider: "gemini", model: "gemini-3.8-flash", engine: "gemini" },
  cota: { rate: 0.8, queueMin: [3, 15], workMin: [10, 40], types: ["comentario", "post"], reject: 0.1, rejectReason: "faltou um exemplo", edit: 0.15, editKind: "leve", fail: 0.28, provider: "gemini", model: "gemini-3.8-flash", engine: "gemini" },
};

/** Gerador mulberry32: uma função que devolve números em [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;
/** Prazo (horas a partir de agora) do projeto "apertado" da semente. */
const WEBINAR_DUE_H = 10;
const iso = (ms: number): string => new Date(Math.round(ms)).toISOString();

const SUBJECTS = ["o lançamento", "a nova versão", "o evento de sexta", "o relatório do trimestre", "a parceria com a loja", "o webinar de terça", "a pesquisa de clima", "o programa de mentoria"];
const PLAIN = ["Obrigado por compartilhar, achei muito útil.", "Concordo com o ponto sobre prioridades, vale testar.", "Boa leitura, principalmente a parte dos números.", "Fez sentido para o nosso caso, vou aplicar."];
const FORMAL = ["Prezado, agradeço a oportunidade de contribuir com a presente discussão.", "Cumprimento pela publicação e sigo à disposição para eventuais esclarecimentos.", "Venho, respeitosamente, parabenizar pelo conteúdo compartilhado."];
const EMOJIS = ["🎉", "🚀", "🔥", "👏"];

type Maker = {
  rng: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(list: readonly T[]) => T;
  chance: (p: number) => boolean;
};

function makerOf(seed: number): Maker {
  const rng = mulberry32(seed);
  return {
    rng,
    int: (min, max) => min + Math.floor(rng() * (max - min + 1)),
    pick: (list) => list[Math.floor(rng() * list.length)]!,
    chance: (p) => rng() < p,
  };
}

/** Quanto o dono demora para decidir: minutos, horas ou mais de um dia. */
function ownerWait(maker: Maker): number {
  const roll = maker.rng();
  if (roll < 0.55) return maker.int(2, 40) * MIN;
  if (roll < 0.92) return maker.int(60, 480) * MIN;
  return maker.int(26, 40) * HOUR;
}

export function makeHistory(options: HistoryOptions): History {
  const { now, days, agents } = options;
  const maker = makerOf(options.seed);
  const maestroId = options.maestroId ?? "seed-maestro";
  const workspaceId = options.workspaceId ?? "laboratorio";
  const history: History = { tasks: [], projects: [], forYou: [], usage: [], routines: [], entries: [], activity: [] };
  const agentsOf = agents.map((agent, index) => ({ ...agent, roomId: agent.roomId ?? "seed-quarto", teamId: agent.teamId ?? "seed-time", profileId: PROFILE_IDS[index % PROFILE_IDS.length]! }));
  const profileOf = (agentId: string): Profile => PROFILES[agentsOf.find((agent) => agent.id === agentId)!.profileId];

  const avulsas = emptyAvulsas(iso(now - days * DAY_MS));
  let forYouCounter = 0;
  let usageCounter = 0;
  let activityCounter = 0;

  const activity = (ms: number, input: Pick<ActivityEntry, "category" | "action" | "actor" | "summary"> & { refs?: ActivityEntry["refs"]; data?: Record<string, unknown> }) => {
    history.activity.push({ id: `seed-act-${String((activityCounter += 1)).padStart(5, "0")}`, at: spIso(ms), workspaceId, ...input, data: { ...input.data, seed: true } });
  };

  const usage = (input: { at: number; agentId: string; taskId: string; title: string; rootTaskId: string; durationMs: number }) => {
    const profile = profileOf(input.agentId);
    const agent = agentsOf.find((candidate) => candidate.id === input.agentId)!;
    const scale = Math.max(0.4, input.durationMs / (20 * MIN));
    history.usage.push({
      v: 1,
      id: `seed-u-${String((usageCounter += 1)).padStart(5, "0")}`,
      at: iso(input.at),
      agentId: input.agentId,
      agentName: agent.name,
      provider: profile.provider,
      model: profile.model,
      modelSource: "cli",
      taskId: input.taskId,
      taskTitle: input.title,
      parentTaskId: input.rootTaskId,
      rootTaskId: input.rootTaskId,
      channel: "task",
      source: "seed",
      turns: 1,
      measured: true,
      tokens: { input: Math.round(maker.int(3000, 12_000) * scale), output: Math.round(maker.int(400, 2500) * scale), cacheRead: Math.round(maker.int(20_000, 80_000) * scale), cacheCreation: Math.round(maker.int(2000, 8000) * scale) },
      durationMs: Math.round(input.durationMs),
      costUsd: null,
      priceVersion: "seed",
    });
  };

  const request = (id: string, title: string, at: number, status: Task["status"], updatedAt: number, roomId: string, teamId: string): Task => ({
    id,
    roomId,
    teamId,
    agentId: maestroId,
    role: "request",
    prompt: title,
    status,
    createdAt: iso(at),
    updatedAt: iso(updatedAt),
  });

  const draftText = (profile: Profile, kind: "emoji" | "leve" | "formal"): { original: string; edited: string } => {
    const subject = maker.pick(SUBJECTS);
    if (profile.rejectReason === "tom formal demais") {
      const text = `${maker.pick(FORMAL)} Sobre ${subject}, sigo atento.`;
      return { original: text, edited: text.replace("Prezado, ", "").replace("respeitosamente, ", "") };
    }
    if (kind === "emoji") {
      const original = `${maker.pick(PLAIN)} ${maker.pick(EMOJIS)}${maker.pick(EMOJIS)} Sobre ${subject}, adorei. ${maker.pick(EMOJIS)}`;
      return { original, edited: original.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").replace(/\s+/g, " ").replace(" .", ".").trim() };
    }
    const original = `${maker.pick(PLAIN)} Sobre ${subject}, vale acompanhar os próximos passos.`;
    return { original, edited: original.replace("vale acompanhar", "queremos acompanhar").replace("Obrigado", "Valeu") };
  };

  // ---------- Pedidos simples (o Avulsas), por agente e por dia ----------
  let leafCounter = 0;
  const failedRecent: { task: Task; at: number }[] = [];

  for (let back = days - 1; back >= 0; back -= 1) {
    const day = dayKeyOf(now - back * DAY_MS);
    const start = dayStart(day);
    const weekday = new Date(start + 12 * HOUR).getUTCDay(); // 0 domingo ... 6 sábado (meio-dia de SP cai no mesmo dia em UTC)
    const factor = weekday === 0 || weekday === 6 ? 0.25 : 1;
    for (const agent of agentsOf) {
      const profile = PROFILES[agent.profileId];
      const count = Math.floor(profile.rate * factor + maker.rng());
      for (let i = 0; i < count; i += 1) {
        const createdAt = Math.round(start + 8 * HOUR + maker.rng() * 10 * HOUR);
        if (createdAt > now - 30 * MIN) continue;
        leafCounter += 1;
        const seq = leafCounter;
        const requestId = `seed-r${seq}`;
        const taskId = `seed-t${seq}`;
        const ref = `S${seq}`;
        const type = maker.pick(profile.types);
        const title = `${type === "post" ? "Post" : type === "convite" ? "Convite" : "Comentário"} sobre ${maker.pick(SUBJECTS)}`;
        const queueMs = maker.int(...profile.queueMin) * MIN;
        const workMs = maker.int(...profile.workMin) * MIN;
        const startedAt = createdAt + queueMs;
        const workEnd = startedAt + workMs;
        const ranWith = { engine: profile.engine, model: profile.model } as const;
        const base = { roomId: agent.roomId, teamId: agent.teamId };
        const task: Task = { id: taskId, ...base, agentId: agent.id, projectId: requestId, prompt: title, status: "done", ranWith, work: { projectId: avulsas.id, ref, step: 0 }, createdAt: iso(createdAt), updatedAt: iso(workEnd) };
        const leaf: ProjectTask = {
          ...projectTaskDefaults(),
          ref,
          title,
          briefing: title,
          ownerId: agent.id,
          steps: [{ agentId: agent.id, what: title, status: "feita", taskId, startedAt: iso(startedAt), finishedAt: iso(workEnd) }],
          current: 0,
          dependsOn: [],
          priority: "normal",
          status: "concluida",
          approvalType: type,
          queuedAt: iso(createdAt),
          startedAt: iso(startedAt),
          finishedAt: iso(workEnd),
          updatedAt: iso(workEnd),
          meta: { requestId, origin: "usuario", createdAt: iso(createdAt) },
        };
        history.tasks.push(request(requestId, title, createdAt, "done", workEnd, agent.roomId, agent.teamId));
        activity(createdAt, { category: "tarefa", action: "pedida", actor: "usuario", summary: `Pedido: ${title}`, refs: { taskId: requestId } });
        avulsas.tasks.push(leaf);

        // Em andamento ou na fila agora.
        if (startedAt > now) {
          task.status = "queued";
          task.updatedAt = iso(createdAt);
          leaf.status = "a_fazer";
          leaf.steps[0] = { agentId: agent.id, what: title, status: "pendente" };
          delete leaf.startedAt;
          delete leaf.finishedAt;
          leaf.waitingSince = iso(createdAt);
          history.tasks.push(task);
          history.tasks.find((candidate) => candidate.id === requestId)!.status = "in_progress";
          continue;
        }
        if (workEnd > now) {
          task.status = "in_progress";
          task.updatedAt = iso(startedAt);
          leaf.status = "em_andamento";
          leaf.steps[0] = { agentId: agent.id, what: title, status: "em_andamento", taskId, startedAt: iso(startedAt) };
          delete leaf.finishedAt;
          history.tasks.push(task);
          history.tasks.find((candidate) => candidate.id === requestId)!.status = "in_progress";
          continue;
        }
        usage({ at: workEnd, agentId: agent.id, taskId, title, rootTaskId: requestId, durationMs: workMs });

        // Falhou (por cota, no perfil `cota`): a tarefa fica registrada como falha; a folha só fica `falhou` se for recente.
        if (maker.chance(profile.fail)) {
          task.status = "failed";
          // Origem da falha: o perfil `cota` falha por cota, salvo uma em cada três (do agente); os demais, do agente.
          task.failureKind = agent.profileId === "cota" && seq % 3 !== 0 ? "cota" : "agente";
          history.tasks.push(task);
          history.tasks.find((candidate) => candidate.id === requestId)!.status = "failed";
          leaf.status = "falhou";
          leaf.failure = agent.profileId === "cota" ? "Sem cota no motor" : "O agente não conseguiu concluir";
          leaf.steps[0] = { agentId: agent.id, what: title, status: "falhou", taskId, startedAt: iso(startedAt), finishedAt: iso(workEnd) };
          activity(workEnd, { category: "tarefa", action: "falhou", actor: agent.id, summary: `Falhou: ${title}`, refs: { taskId } });
          failedRecent.push({ task, at: workEnd });
          continue;
        }

        // Aprovação do dono.
        const approvalAt = workEnd;
        const decide = (final: boolean, at: number, wait: number, rework: boolean) => {
          const decidedAt = at + wait;
          const refused = !final && maker.chance(profile.reject);
          const texts = draftText(profile, profile.editKind);
          const edited = !refused && maker.chance(profile.edit);
          forYouCounter += 1;
          const item: ForYouItem = {
            id: `A-${String(forYouCounter).padStart(4, "0")}`,
            taskId,
            agentId: agent.id,
            roomId: agent.roomId,
            type,
            status: decidedAt > now ? "pendente" : refused ? "rejeitado" : "aprovado",
            title,
            meta: { seed: "1" },
            text: edited ? texts.edited : texts.original,
            originalText: texts.original,
            editedByUser: edited && decidedAt <= now,
            projectId: requestId,
            createdAt: iso(at),
            ...(decidedAt <= now ? { decidedAt: iso(decidedAt), decidedBy: "usuario" as const } : {}),
            ...(refused && decidedAt <= now ? { rejection: { reason: profile.rejectReason, ...(CATEGORY_OF_REASON[profile.rejectReason] ? { category: CATEGORY_OF_REASON[profile.rejectReason]! } : {}) } } : {}),
          };
          if (item.status === "pendente") {
            item.text = item.originalText;
            item.editedByUser = false;
          }
          history.forYou.push(item);
          if (item.decidedAt) activity(decidedAt, { category: "aprovacao", action: refused ? "recusada" : "aprovada", actor: "usuario", summary: `${refused ? "Recusou" : "Aprovou"}: ${title}`, refs: { taskId, forYouId: item.id } });
          return { item, refused, decidedAt, rework };
        };

        const first = decide(false, approvalAt, ownerWait(maker), false);
        if (first.item.status === "pendente") {
          task.status = "waiting_approval";
          task.updatedAt = iso(approvalAt);
          leaf.status = "esperando_voce";
          leaf.waitingSince = iso(approvalAt);
          delete leaf.finishedAt;
          leaf.steps[0] = { agentId: agent.id, what: title, status: "em_andamento", taskId, startedAt: iso(startedAt) };
          history.tasks.push(task);
          history.tasks.find((candidate) => candidate.id === requestId)!.status = "in_progress";
          continue;
        }
        let finishedAt = first.decidedAt + 30_000;
        if (first.refused) {
          // Recusado: o agente refaz (uma vez) e o dono aprova mais rápido.
          const redoMs = Math.round(workMs * 0.6);
          const redoEnd = first.decidedAt + 2 * MIN + redoMs;
          usage({ at: redoEnd, agentId: agent.id, taskId, title, rootTaskId: requestId, durationMs: redoMs });
          if (redoEnd > now) {
            leaf.status = "em_andamento";
            task.status = "in_progress";
            delete leaf.finishedAt;
          } else {
            const second = decide(true, redoEnd, maker.int(2, 30) * MIN, true);
            finishedAt = second.item.decidedAt ? second.decidedAt + 30_000 : redoEnd;
            if (second.item.status === "pendente") {
              leaf.status = "esperando_voce";
              task.status = "waiting_approval";
              delete leaf.finishedAt;
            }
          }
          leaf.rework = { count: 1, last: { reason: profile.rejectReason, at: iso(first.decidedAt), itemId: first.item.id } };
        }
        if (leaf.status === "concluida") {
          finishedAt = Math.min(finishedAt, now);
          leaf.finishedAt = iso(finishedAt);
          leaf.updatedAt = iso(finishedAt);
          task.updatedAt = iso(finishedAt);
          activity(finishedAt, { category: "tarefa", action: "concluida", actor: agent.id, summary: `Concluída: ${title}`, refs: { taskId }, data: { durationMs: workMs } });
        }
        history.tasks.push(task);
        const requestTask = history.tasks.find((candidate) => candidate.id === requestId)!;
        requestTask.status = task.status === "done" ? "done" : "in_progress";
        requestTask.updatedAt = task.updatedAt;
      }
    }
  }

  // Só a falha mais recente de cada agente continua "falhou" na folha (as outras já foram refeitas).
  const keepFailed = new Set<string>();
  for (const agent of agentsOf) {
    const latest = failedRecent.filter((entry) => entry.task.agentId === agent.id).sort((a, b) => b.at - a.at)[0];
    if (latest && now - latest.at < 3 * DAY_MS) keepFailed.add(latest.task.work!.ref);
  }
  avulsas.tasks = avulsas.tasks.filter((leaf) => leaf.status !== "falhou" || keepFailed.has(leaf.ref));

  // Um pedido cancelado: não é falha (tem de ficar fora da taxa).
  const firstAgent = agentsOf[0];
  if (firstAgent && days >= 3) {
    const at = now - 2 * DAY_MS + 3 * HOUR;
    history.tasks.push({ id: "seed-cancelado", roomId: firstAgent.roomId, teamId: firstAgent.teamId, agentId: firstAgent.id, prompt: "Pedido cancelado pelo dono", status: "failed", outcome: "cancelled", ranWith: { engine: PROFILES.rapido.engine, model: PROFILES.rapido.model }, createdAt: iso(at), updatedAt: iso(at + 5 * MIN) });
  }

  // Uma tarefa travada sem cota (o agente do perfil `cota`) e um item pendente há 2 dias (o agente `recusado`).
  const quotaAgent = agentsOf.find((agent) => agent.profileId === "cota");
  if (quotaAgent) {
    leafCounter += 1;
    const requestId = `seed-r${leafCounter}`;
    const since = now - 5 * HOUR;
    history.tasks.push(request(requestId, "Post sobre o evento de sexta", since - HOUR, "in_progress", since, quotaAgent.roomId, quotaAgent.teamId));
    history.tasks.push({ id: `seed-t${leafCounter}`, roomId: quotaAgent.roomId, teamId: quotaAgent.teamId, agentId: quotaAgent.id, projectId: requestId, prompt: "Post sobre o evento de sexta", status: "queued", work: { projectId: avulsas.id, ref: `S${leafCounter}`, step: 0 }, createdAt: iso(since - HOUR), updatedAt: iso(since) });
    avulsas.tasks.push({
      ...projectTaskDefaults(),
      ref: `S${leafCounter}`,
      title: "Post sobre o evento de sexta",
      briefing: "Post sobre o evento de sexta",
      ownerId: quotaAgent.id,
      steps: [{ agentId: quotaAgent.id, what: "Post sobre o evento de sexta", status: "pendente" }],
      current: 0,
      dependsOn: [],
      priority: "normal",
      status: "a_fazer",
      approvalType: "post",
      waitingSince: iso(since),
      queuedAt: iso(since - HOUR),
      blocked: { type: "cota", by: `${workspaceId}/${quotaAgent.id}`, note: `${quotaAgent.name} sem cota`, since: iso(since) },
      updatedAt: iso(since),
      meta: { requestId, origin: "usuario", createdAt: iso(since - HOUR) },
    });
  }
  const refusedAgent = agentsOf.find((agent) => agent.profileId === "recusado") ?? agentsOf[0];
  if (refusedAgent) {
    leafCounter += 1;
    const requestId = `seed-r${leafCounter}`;
    const createdAt = now - 49 * HOUR;
    forYouCounter += 1;
    history.tasks.push(request(requestId, "Convite para a mentoria", createdAt - HOUR, "in_progress", createdAt, refusedAgent.roomId, refusedAgent.teamId));
    history.tasks.push({ id: `seed-t${leafCounter}`, roomId: refusedAgent.roomId, teamId: refusedAgent.teamId, agentId: refusedAgent.id, projectId: requestId, prompt: "Convite para a mentoria", status: "waiting_approval", work: { projectId: avulsas.id, ref: `S${leafCounter}`, step: 0 }, createdAt: iso(createdAt - HOUR), updatedAt: iso(createdAt) });
    avulsas.tasks.push({
      ...projectTaskDefaults(),
      ref: `S${leafCounter}`,
      title: "Convite para a mentoria",
      briefing: "Convite para a mentoria",
      ownerId: refusedAgent.id,
      steps: [{ agentId: refusedAgent.id, what: "Convite para a mentoria", status: "em_andamento", taskId: `seed-t${leafCounter}`, startedAt: iso(createdAt - 30 * MIN) }],
      current: 0,
      dependsOn: [],
      priority: "normal",
      status: "esperando_voce",
      approvalType: "convite",
      queuedAt: iso(createdAt - HOUR),
      waitingSince: iso(createdAt),
      updatedAt: iso(createdAt),
      meta: { requestId, origin: "usuario", createdAt: iso(createdAt - HOUR) },
    });
    history.forYou.push({
      id: `A-${String(forYouCounter).padStart(4, "0")}`,
      taskId: `seed-t${leafCounter}`,
      agentId: refusedAgent.id,
      roomId: refusedAgent.roomId,
      type: "convite",
      status: "pendente",
      title: "Convite para a mentoria",
      meta: { seed: "1" },
      text: "Prezado, convido-o respeitosamente a participar do programa de mentoria.",
      originalText: "Prezado, convido-o respeitosamente a participar do programa de mentoria.",
      editedByUser: false,
      projectId: requestId,
      createdAt: iso(createdAt),
    });
  }

  // ---------- Projetos de verdade: dois concluídos, um atrasado e um no prazo ----------
  const worker = (index: number) => agentsOf[index % agentsOf.length]!;
  type TaskSpec = { title: string; agent: number; startOffsetH: number; workH: number; waitH: number; status: ProjectTask["status"]; dependsOn?: string[]; /** Bloqueios que já acabaram: tipo, quando começou e quando acabou (horas depois do começo do trabalho; negativo = antes). */ spans?: [BlockedSpan["type"], number, number][]; /** Horas na fila antes de começar (padrão 1). */ queueH?: number; approval?: boolean };
  const project = (spec: { id: string; title: string; createdAt: number; status: Project["status"]; dueAt?: number; finishedAt?: number; tasks: TaskSpec[] }): void => {
    const owner = worker(0);
    const tasks: ProjectTask[] = spec.tasks.map((task, index) => {
      const ref = `T${index + 1}`;
      const agent = worker(task.agent);
      const started = spec.createdAt + task.startOffsetH * HOUR;
      const workMs = task.workH * HOUR;
      const ended = started + workMs;
      const taskId = `${spec.id}-${ref.toLowerCase()}`;
      const done = task.status === "concluida";
      const decidedAt = ended + task.waitH * HOUR;
      const projectTask: ProjectTask = {
        ...projectTaskDefaults(),
        ref,
        title: task.title,
        briefing: task.title,
        ownerId: agent.id,
        steps: [{ agentId: agent.id, what: task.title, status: done ? "feita" : task.status === "em_andamento" ? "em_andamento" : "pendente", ...(task.status === "concluida" || task.status === "em_andamento" ? { taskId, startedAt: iso(started) } : {}), ...(done ? { finishedAt: iso(ended) } : {}) }],
        current: 0,
        dependsOn: task.dependsOn ?? [],
        priority: "normal",
        status: task.status,
        ...(task.approval === false ? {} : { approvalType: "post" }),
        ...(task.status === "backlog" ? {} : { queuedAt: iso(task.status === "a_fazer" ? now - HOUR : started - (task.queueH ?? 1) * HOUR) }),
        ...(task.spans ? { blockedSpans: task.spans.map(([type, from, to]) => ({ type, since: iso(started + from * HOUR), until: iso(started + to * HOUR) })) } : {}),
        updatedAt: iso(done ? decidedAt : started),
        ...(done ? { startedAt: iso(started), finishedAt: iso(decidedAt) } : {}),
        ...(task.status === "em_andamento" ? { startedAt: iso(started) } : {}),
        ...(task.status === "a_fazer" ? { waitingSince: iso(now - HOUR) } : {}),
      };
      if (done) {
        history.tasks.push({ id: taskId, roomId: agent.roomId, teamId: agent.teamId, agentId: agent.id, projectId: spec.id, prompt: task.title, status: "done", ranWith: { engine: profileOf(agent.id).engine, model: profileOf(agent.id).model }, work: { projectId: spec.id, ref, step: 0 }, createdAt: iso(started), updatedAt: iso(decidedAt) });
        usage({ at: ended, agentId: agent.id, taskId, title: task.title, rootTaskId: spec.id, durationMs: workMs });
        forYouCounter += 1;
        history.forYou.push({ id: `A-${String(forYouCounter).padStart(4, "0")}`, taskId, agentId: agent.id, roomId: agent.roomId, type: "post", status: "aprovado", title: task.title, meta: { seed: "1" }, text: "Texto aprovado do projeto.", originalText: "Texto aprovado do projeto.", editedByUser: false, projectId: spec.id, createdAt: iso(ended), decidedAt: iso(decidedAt), decidedBy: "usuario" });
        activity(decidedAt, { category: "tarefa", action: "concluida", actor: agent.id, summary: `Concluída: ${task.title}`, refs: { taskId, rootTaskId: spec.id } });
      }
      return projectTask;
    });
    history.tasks.push(request(spec.id, spec.title, spec.createdAt, spec.status === "concluido" ? "done" : "in_progress", spec.finishedAt ?? now, owner.roomId, owner.teamId));
    history.projects.push({
      ...projectDefaults(),
      id: spec.id,
      kind: "projeto",
      title: spec.title,
      origin: "maestro",
      status: spec.status,
      version: 1,
      priority: "normal",
      mode: { kind: "pede-ok" },
      tasks,
      createdAt: iso(spec.createdAt),
      updatedAt: iso(spec.finishedAt ?? now),
      approvedAt: iso(spec.createdAt + 10 * MIN),
      ...(spec.dueAt ? { dueAt: iso(spec.dueAt) } : {}),
      ...(spec.finishedAt ? { finishedAt: iso(spec.finishedAt) } : {}),
    });
  };
  if (days >= 21) {
    project({ id: "seed-p1", title: "Campanha de outubro", createdAt: now - 20 * DAY_MS, status: "concluido", finishedAt: now - 13 * DAY_MS, tasks: [{ title: "Roteiro da campanha", agent: 0, startOffsetH: 2, workH: 3, waitH: 5, status: "concluida" }, { title: "Textos dos posts", agent: 1, startOffsetH: 30, workH: 4, waitH: 20, status: "concluida", dependsOn: ["T1"], spans: [["cota", -3, -1], ["agente", -1, 0]] }, { title: "Calendário de publicação", agent: 0, startOffsetH: 100, workH: 2, waitH: 3, status: "concluida", dependsOn: ["T2"] }] });
    project({ id: "seed-p2", title: "Revisão do site", createdAt: now - 9 * DAY_MS, status: "concluido", finishedAt: now - 5 * DAY_MS, tasks: [{ title: "Auditoria das páginas", agent: 3, startOffsetH: 3, workH: 6, waitH: 4, status: "concluida", spans: [["agente", -2, -0.5]] }, { title: "Lista de correções", agent: 0, startOffsetH: 40, workH: 2, waitH: 1, status: "concluida", dependsOn: ["T1"] }] });
    project({ id: "seed-p3", title: "Site novo", createdAt: now - 12 * DAY_MS, status: "ativo", dueAt: now - DAY_MS, tasks: [{ title: "Estrutura das páginas", agent: 0, startOffsetH: 3, workH: 4, waitH: 2, status: "concluida" }, { title: "Textos da home", agent: 1, startOffsetH: 60, workH: 3, waitH: 6, status: "concluida", dependsOn: ["T1"] }, { title: "Textos de produtos", agent: 3, startOffsetH: 12 * 24 - 2, workH: 2, waitH: 0, status: "em_andamento", dependsOn: ["T2"] }, { title: "Revisão final", agent: 0, startOffsetH: 0, workH: 1, waitH: 0, status: "backlog", dependsOn: ["T3"] }] });
    // Apertado: o fim provável cabe no prazo, o fim lento não (o prazo foi ajustado olhando a previsão desta semente).
    project({ id: "seed-p5", title: "Lançamento do webinar", createdAt: now - 3 * DAY_MS, status: "ativo", dueAt: now + WEBINAR_DUE_H * HOUR, tasks: [{ title: "Roteiro do webinar", agent: 0, startOffsetH: 70, workH: 2, waitH: 0, status: "em_andamento" }, { title: "Slides", agent: 1, startOffsetH: 0, workH: 2, waitH: 0, status: "a_fazer", dependsOn: ["T1"] }, { title: "Convites", agent: 3, startOffsetH: 0, workH: 1, waitH: 0, status: "backlog", dependsOn: ["T2"] }] });
    project({ id: "seed-p4", title: "Relatório do mês", createdAt: now - 4 * DAY_MS, status: "ativo", dueAt: now + 6 * DAY_MS, tasks: [{ title: "Levantar os números", agent: 1, startOffsetH: 2, workH: 2, waitH: 3, status: "concluida" }, { title: "Escrever o resumo", agent: 0, startOffsetH: 0, workH: 2, waitH: 0, status: "a_fazer", dependsOn: ["T1"] }, { title: "Diagramar", agent: 3, startOffsetH: 0, workH: 1, waitH: 0, status: "backlog", dependsOn: ["T2"] }] });
  }

  // ---------- Uma rotina com entregas: a tarefa da rotina NÃO conta como entrega de projeto (só a entrada) ----------
  const routineAgent = agentsOf[0];
  if (routineAgent && days >= 7) {
    const routine: Routine = {
      id: SEED_ROUTINE_ID,
      title: "Comentários no LinkedIn",
      unit: "comentário",
      kind: "comment",
      site: "linkedin.com",
      target: 8,
      period: "week",
      agentId: routineAgent.id,
      teamId: routineAgent.teamId,
      instruction: "Comentar posts relevantes da rede.",
      status: "ativa",
      needsApproval: true,
      skipPeriods: [],
      createdBy: "usuario",
      seed: true,
      createdAt: iso(now - days * DAY_MS),
      updatedAt: iso(now - days * DAY_MS),
      type: "meta",
      mode: { kind: "pede-ok" },
      schedules: [],
      lastRuns: [],
      periodStats: {},
    };
    history.routines.push(routine);
    for (let back = Math.min(days, 21) - 1; back >= 1; back -= 1) {
      if (!maker.chance(0.55)) continue;
      const day = dayKeyOf(now - back * DAY_MS);
      const at = dayStart(day) + 9 * HOUR + maker.int(0, 240) * MIN;
      leafCounter += 1;
      const requestId = `seed-r${leafCounter}`;
      const taskId = `seed-t${leafCounter}`;
      const title = "Comentários no LinkedIn";
      const end = at + 25 * MIN;
      history.tasks.push(request(requestId, title, at, "done", end, routineAgent.roomId, routineAgent.teamId));
      history.tasks.push({ id: taskId, roomId: routineAgent.roomId, teamId: routineAgent.teamId, agentId: routineAgent.id, projectId: requestId, routineId: routine.id, prompt: title, status: "done", ranWith: { engine: PROFILES.rapido.engine, model: PROFILES.rapido.model }, work: { projectId: avulsas.id, ref: `S${leafCounter}`, step: 0 }, createdAt: iso(at), updatedAt: iso(end) });
      avulsas.tasks.push({
        ...projectTaskDefaults(),
        ref: `S${leafCounter}`,
        title,
        briefing: title,
        ownerId: routineAgent.id,
        steps: [{ agentId: routineAgent.id, what: title, status: "feita", taskId, startedAt: iso(at), finishedAt: iso(end) }],
        current: 0,
        dependsOn: [],
        priority: "normal",
        status: "concluida",
        queuedAt: iso(at),
        startedAt: iso(at),
        finishedAt: iso(end),
        updatedAt: iso(end),
        meta: { requestId, origin: "rotina", routineRef: { routineId: routine.id, period: periodKey(new Date(at)) }, createdAt: iso(at) },
      });
      usage({ at: end, agentId: routineAgent.id, taskId, title, rootTaskId: requestId, durationMs: 25 * MIN });
      history.entries.push({ id: `seed-e${history.entries.length + 1}`, routineId: routine.id, periodKey: periodKey(new Date(at)), url: `https://www.linkedin.com/feed/update/seed-${leafCounter}`, taskId, agentId: routineAgent.id, stage: "entregue", at: iso(end), settledAt: iso(end + 5 * MIN) });
      activity(end + 5 * MIN, { category: "rotina", action: "entregue", actor: routineAgent.id, summary: "Comentário entregue", refs: { taskId, routineId: routine.id } });
    }
    // Um link só registrado e um descartado: não são entrega.
    history.entries.push({ id: "seed-e-reg", routineId: routine.id, periodKey: periodKey(new Date(now)), url: "https://www.linkedin.com/feed/update/seed-registrado", taskId: "seed-t1", agentId: routineAgent.id, stage: "registrado", at: iso(now - HOUR) });
    history.entries.push({ id: "seed-e-desc", routineId: routine.id, periodKey: periodKey(new Date(now)), url: "https://www.linkedin.com/feed/update/seed-descartado", taskId: "seed-t1", agentId: routineAgent.id, stage: "descartado", at: iso(now - 2 * HOUR), settledAt: iso(now - HOUR) });
  }

  // ---------- Metas: uma que fecha no ritmo atual e uma que não (só com `goals: true`) ----------
  if (options.goals && routineAgent && days >= 7) {
    const goal = (id: string, title: string, target: number, preferredDays: number[] | undefined): Routine => ({
      id,
      title,
      unit: "item",
      kind: "post",
      site: "linkedin.com",
      target,
      period: "week",
      agentId: routineAgent.id,
      teamId: routineAgent.teamId,
      instruction: title,
      status: "ativa",
      needsApproval: true,
      skipPeriods: [],
      createdBy: "usuario",
      seed: true,
      createdAt: iso(now - days * DAY_MS),
      updatedAt: iso(now - days * DAY_MS),
      type: "meta",
      mode: { kind: "pede-ok" },
      schedules: [],
      lastRuns: [],
      periodStats: {},
      ...(preferredDays ? { goal: { target, period: "week" as const, stopOnHit: true, prepareFactor: 1, preferredDays: preferredDays as never } } : {}),
    });
    const deliver = (routineId: string, daysAgo: number, hour: number, label: string) => {
      const when = dayStart(dayKeyOf(now - daysAgo * DAY_MS)) + hour * HOUR;
      if (when > now) return;
      history.entries.push({ id: `seed-e-${routineId}-${history.entries.length + 1}`, routineId, periodKey: periodKey(new Date(when)), url: `https://www.linkedin.com/feed/update/seed-${label}`, taskId: "seed-t1", agentId: routineAgent.id, stage: "entregue", at: iso(when), settledAt: iso(when + 5 * MIN) });
    };
    // "Posts do blog": 6 entregas nos últimos 7 dias para um alvo de 5 por semana -> fecha.
    history.routines.push(goal("R-0901", "Posts do blog", 5, [2, 4]));
    [0, 1, 2, 3, 4, 5].forEach((back) => deliver("R-0901", back, 10, `blog${back}`));
    // "Conexões": 3 entregas em 7 dias para um alvo de 12 -> não fecha.
    history.routines.push(goal("R-0902", "Conexões", 12, undefined));
    [1, 3, 6].forEach((back) => deliver("R-0902", back, 15, `conexao${back}`));
  }

  // ---------- Retrospectiva (só com `retro: true`): o agente "recusado" leva recusas de "tom formal demais" em 4 dias da última quinzena ----------
  const toneAgent = agentsOf.find((agent) => agent.profileId === "recusado");
  if (options.retro && toneAgent && days >= 10) {
    const reasons: [number, string, string | undefined][] = [
      [2, "tom formal demais", "tom"],
      [3, "muito formal, queria algo mais leve", "tom"],
      [5, "formal demais para o LinkedIn", "tom"],
      [6, "ficou formal demais", undefined],
      [9, "tom formal e distante", undefined],
    ];
    reasons.forEach(([back, reason, category], index) => {
      forYouCounter += 1;
      const decided = dayStart(dayKeyOf(now - back * DAY_MS)) + (11 + index) * HOUR;
      const text = `${FORMAL[index % FORMAL.length]!} Sobre ${SUBJECTS[index % SUBJECTS.length]!}, sigo atento.`;
      history.forYou.push({
        id: `A-${String(forYouCounter).padStart(4, "0")}`,
        agentId: toneAgent.id,
        roomId: toneAgent.roomId,
        type: "comentario",
        status: "rejeitado",
        title: "Comentário (semente da retrospectiva)",
        meta: { seed: "1" },
        text,
        originalText: text,
        editedByUser: false,
        createdAt: iso(decided - 2 * HOUR),
        decidedAt: iso(decided),
        decidedBy: "usuario",
        rejection: { reason, ...(category ? { category } : {}) },
      });
    });
  }

  history.projects.unshift(avulsas);
  avulsas.updatedAt = iso(now);
  avulsas.nextRef = leafCounter + 1;
  history.tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  history.usage.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  history.forYou.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  history.activity.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return history;
}
