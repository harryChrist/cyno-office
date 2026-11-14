// A linha do tempo do escritório (o "Rever o dia"): o formato dos arquivos que o servidor grava e a reconstrução do
// estado num instante. Código puro: sem Node nem DOM.
//
// Origem: o formato (retrato a cada 5 minutos mais as mudanças entre eles, um registro por linha, leitura
// defensiva) e as funções `keyframeOf`, `frameOf`, `emptyFrame`, `diffFrames`, `applyChanges` e `parseTimeline`
// vêm de `shared/timeline.ts` do Habblaud (https://github.com/marciojr/habblaud, MIT, Copyright 2026 Márcio Junior),
// adaptadas aos dados do Cyno. Veja THIRD_PARTY/habblaud-LICENSE.txt.
//
// Arquivo: <workspace>/timeline/AAAA-MM-DD.jsonl (dia de São Paulo), um registro JSON por linha:
//   {"t":"k",...}    quadro completo (salas, times e agentes);
//   {"t":"d",...}    só o que mudou desde o registro anterior;
//   {"t":"end",...}  o servidor parou (ou o dia chegou ao limite de tamanho).
// Todo arquivo começa com um quadro completo e ele se repete a cada `every` ms; sem nenhum registro por bem mais
// que isso, o servidor estava desligado.
//
// O QUE É O QUADRO. É a entrada do adaptador `montarRetrato` do navegador, em forma compacta: os dados do Cyno de
// que o retrato precisa (estado de cada agente, sala e time, a tarefa em andamento e o que ela mostra, a espera
// pelo dono, o terminal, a ferramenta em uso, os subagentes). O retrato que a cena desenha NÃO é gravado: a
// reprodução remonta a entrada e passa pelo mesmo adaptador. Não entram tokens, custo, texto de tarefa além do
// título curto, log nem e-mail; as frases já saem mascaradas (a ferramenta usa a frase do log).
import type { Avatar, AgentStatus, RoomKind } from "./types";
import type { BlockedType } from "./projects";
import type { AgentEngine, TerminalStatus } from "./terminal";
import { dayRange, parseDayKey } from "./day-stats";

export const TIMELINE_VERSION = 1;

/** Quadro completo a cada 5 minutos. */
export const KEYFRAME_MS = 300_000;
/** No máximo uma mudança por segundo. */
export const THROTTLE_MS = 1_000;
/** Acima disto o dia fica mais ralo: mudança a cada 15 s e quadro completo a cada 15 min. */
export const SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
export const SOFT_THROTTLE_MS = 15_000;
export const SOFT_KEYFRAME_MS = 900_000;
/** Acima disto a gravação para até a virada do dia (registro `end` com `limit`). */
export const HARD_LIMIT_BYTES = 12 * 1024 * 1024;
/** Quantos dias de gravação ficam no disco. */
export const TIMELINE_RETENTION_DAYS = 7;
/** Folga sobre ~1,5 intervalo de quadro sem nenhum registro: daí em diante, "sem dados". */
export const GAP_SLACK_MS = 60_000;
/** A rota devolve o dia por partes deste tamanho (o navegador pede uma de cada vez). */
export const TIMELINE_PART_MS = 3 * 3_600_000;
export const TIMELINE_PATH = "/timeline";

const MAX_TITLE = 80;
const MAX_TEXT = 120;
/** Tarefas por agente no quadro (as que aparecem no quadro da parede dele). */
export const MAX_SCENE_TASKS = 8;
/** Subagentes por agente no quadro. */
export const MAX_SCENE_SUBS = 8;

// ------------------------------------------------------------------ tipos do quadro

export interface SceneRoom {
  id: string;
  name: string;
  kind: RoomKind;
  /** Posição antiga no mapa (só desempata a ordem das salas novas). */
  gx: number;
  gy: number;
}

export interface SceneTeam {
  id: string;
  roomId: string;
  name: string;
  lead?: string;
}

/** Código da situação de uma tarefa no quadro da parede: na fila, em andamento, esperando aprovação, feita, falhou. */
export type SceneTaskCode = "q" | "a" | "w" | "d" | "f";

export interface SceneTask {
  id: string;
  s: SceneTaskCode;
  title: string;
  /** Última mudança da tarefa (ms). */
  at: number;
  /** O registro do pedido do Maestro (não é tarefa de trabalho; só aparece no Maestro). */
  rq?: true;
}

export interface SceneTool {
  id: string;
  /** Quando começou (ms). */
  at: number;
  icon: string;
  text: string;
  /** Nome bruto da ferramenta (o adaptador escolhe a tela do monitor por ele). */
  name: string;
  error?: true;
}

export interface SceneSub {
  id: string;
  label: string;
  goal: string;
  at: number;
  model?: string;
}

export interface SceneAgent {
  id: string;
  name: string;
  role: string;
  teamId: string;
  avatar: Avatar;
  engine?: AgentEngine;
  model?: string;
  status: AgentStatus;
  terminal?: { status: TerminalStatus; chatting?: true; error?: string; at?: number };
  /** Motor sem cota ou CLI ausente: o rótulo pronto ("sem cota · volta às 14:30"). */
  unavailable?: string;
  /** Título do primeiro item do "Para você" que espera o dono (a pergunta ou a aprovação). */
  asking?: string;
  blocked?: { type: BlockedType; note: string; by?: string; since: string };
  tasks?: SceneTask[];
  /** Andamento da tarefa em andamento. */
  progress?: { message: string; pct: number };
  tool?: SceneTool;
  subs?: SceneSub[];
  /** Só o Maestro: ids dos times que seguram pedidos dele. */
  delegating?: string[];
}

export interface SceneFrame {
  rooms: Map<string, SceneRoom>;
  teams: Map<string, SceneTeam>;
  agents: Map<string, SceneAgent>;
}

export interface TimelineKeyframe {
  t: "k";
  at: number;
  v: number;
  /** Intervalo entre quadros completos em vigor (ms). */
  every: number;
  /** Primeiro registro depois de o servidor subir. */
  boot?: true;
  rooms: SceneRoom[];
  teams: SceneTeam[];
  agents: SceneAgent[];
}

/** Campos que mudaram; `null` = o campo deixou de existir. */
export type TimelinePatch<T> = { [K in keyof T]?: T[K] | null };

/** O que mudou entre dois quadros. Agente novo vem completo; `null` = saiu. */
export interface TimelineChanges {
  rooms?: [string, SceneRoom | null][];
  teams?: [string, SceneTeam | null][];
  agents?: [string, TimelinePatch<SceneAgent> | null][];
}

export interface TimelineDelta extends TimelineChanges {
  t: "d";
  at: number;
}

export interface TimelineEnd {
  t: "end";
  at: number;
  /** "limit" = o dia chegou ao limite de tamanho e a gravação parou até a virada. */
  reason?: "stop" | "limit";
}

export type TimelineRecord = TimelineKeyframe | TimelineDelta | TimelineEnd;

// ------------------------------------------------------------------ dias

/** AAAA-MM-DD que existe no calendário (é o único formato aceito como nome de arquivo). */
export function isDayKey(value: unknown): value is string {
  return typeof value === "string" && parseDayKey(value) !== null;
}

export const dayStartOf = (day: string): number => dayRange(day).start;

/** Um dia na lista de dias gravados. */
export interface TimelineDayInfo {
  day: string;
  bytes: number;
  /** Primeiro e último registro do dia (ms). */
  from: number;
  to: number;
}

export interface TimelineDaysResponse {
  /** O servidor está gravando (CYNO_TIMELINE=0 desliga). */
  recording: boolean;
  days: TimelineDayInfo[];
}

// ------------------------------------------------------------------ compactação

export const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const clipTitle = (text: string): string => clipText(text, MAX_TITLE);
export const clipPhrase = (text: string): string => clipText(text, MAX_TEXT);

export function emptyFrame(): SceneFrame {
  return { rooms: new Map(), teams: new Map(), agents: new Map() };
}

export function keyframeOf(frame: SceneFrame, at: number, every: number, boot = false): TimelineKeyframe {
  const keyframe: TimelineKeyframe = {
    t: "k",
    at,
    v: TIMELINE_VERSION,
    every,
    rooms: [...frame.rooms.values()],
    teams: [...frame.teams.values()],
    agents: [...frame.agents.values()],
  };
  if (boot) keyframe.boot = true;
  return keyframe;
}

export function frameOf(keyframe: TimelineKeyframe): SceneFrame {
  return {
    rooms: new Map(keyframe.rooms.map((room) => [room.id, room])),
    teams: new Map(keyframe.teams.map((team) => [team.id, team])),
    agents: new Map(keyframe.agents.map((agent) => [agent.id, agent])),
  };
}

/** Cópia independente do quadro (as listas e os objetos são os mesmos; os mapas não). */
export const cloneFrame = (frame: SceneFrame): SceneFrame => ({ rooms: new Map(frame.rooms), teams: new Map(frame.teams), agents: new Map(frame.agents) });

// ------------------------------------------------------------------ diferenças

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function patchOf<T extends object>(prev: T, next: T): TimelinePatch<T> | null {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  let patch: Record<string, unknown> | null = null;
  for (const key of Object.keys(n)) if (!same(p[key], n[key])) (patch ??= {})[key] = n[key];
  for (const key of Object.keys(p)) if (!(key in n)) (patch ??= {})[key] = null;
  return patch as TimelinePatch<T> | null;
}

function diffWhole<T>(prev: Map<string, T>, next: Map<string, T>): [string, T | null][] {
  const out: [string, T | null][] = [];
  for (const [id, value] of next) if (!same(prev.get(id), value)) out.push([id, value]);
  for (const id of prev.keys()) if (!next.has(id)) out.push([id, null]);
  return out;
}

/** O que mudou de `prev` para `next` (null = nada que a cena desenhe). */
export function diffFrames(prev: SceneFrame, next: SceneFrame): TimelineChanges | null {
  const out: TimelineChanges = {};
  const rooms = diffWhole(prev.rooms, next.rooms);
  if (rooms.length) out.rooms = rooms;
  const teams = diffWhole(prev.teams, next.teams);
  if (teams.length) out.teams = teams;
  const agents: [string, TimelinePatch<SceneAgent> | null][] = [];
  for (const [id, agent] of next.agents) {
    const before = prev.agents.get(id);
    if (!before) agents.push([id, agent]);
    else {
      const patch = patchOf(before, agent);
      if (patch) agents.push([id, patch]);
    }
  }
  for (const id of prev.agents.keys()) if (!next.agents.has(id)) agents.push([id, null]);
  if (agents.length) out.agents = agents;
  return out.rooms || out.teams || out.agents ? out : null;
}

const isFullAgent = (patch: TimelinePatch<SceneAgent>): patch is SceneAgent =>
  typeof patch.id === "string" && typeof patch.name === "string" && typeof patch.teamId === "string" && typeof patch.status === "string" && typeof patch.avatar === "object" && patch.avatar !== null;

function withoutNulls<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== null) out[key] = entry;
  return out as T;
}

/**
 * Aplica as mudanças (sem alterar os objetos antigos: agente alterado vira objeto novo). Patch de agente
 * desconhecido que não vem completo (linha perdida no arquivo) é ignorado: o próximo quadro completo corrige.
 */
export function applyChanges(frame: SceneFrame, changes: TimelineChanges): void {
  for (const [id, room] of changes.rooms ?? []) {
    if (room) frame.rooms.set(id, room);
    else frame.rooms.delete(id);
  }
  for (const [id, team] of changes.teams ?? []) {
    if (team) frame.teams.set(id, team);
    else frame.teams.delete(id);
  }
  for (const [id, patch] of changes.agents ?? []) {
    if (!patch) {
      frame.agents.delete(id);
      continue;
    }
    const current = frame.agents.get(id);
    if (!current) {
      if (isFullAgent(patch)) frame.agents.set(id, withoutNulls(patch) as SceneAgent);
      continue;
    }
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    frame.agents.set(id, next as unknown as SceneAgent);
  }
}

// ------------------------------------------------------------------ leitura

function isRecord(record: unknown): record is TimelineRecord {
  if (!record || typeof record !== "object") return false;
  const o = record as Record<string, unknown>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return false;
  if (o.t === "k") return Array.isArray(o.rooms) && Array.isArray(o.teams) && Array.isArray(o.agents) && typeof o.every === "number";
  if (o.t === "d") return ["rooms", "teams", "agents"].every((key) => o[key] === undefined || Array.isArray(o[key]));
  return o.t === "end";
}

/**
 * Interpreta o conteúdo de um arquivo do dia. Linha inválida (cortada, corrompida) é ignorada; um relógio que
 * voltou no tempo não desordena os registros (o horário é segurado no anterior).
 */
export function parseTimeline(text: string): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  let last = -Infinity;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.at < last) record.at = last;
    last = record.at;
    out.push(record);
  }
  return out;
}

/** O primeiro e o último `at` de um arquivo sem interpretá-lo inteiro (a lista de dias não carrega o dia). */
export function spanOfTimeline(text: string): { from: number; to: number } | null {
  const atOf = (line: string | undefined): number | null => {
    const match = line ? /^\{"t":"[a-z]+","at":(\d+)[,}]/.exec(line) : null;
    return match ? Number(match[1]) : null;
  };
  const lines = text.split("\n");
  // A última linha sem quebra depois pode estar cortada (o gravador escreveu pela metade): não vale.
  if (!text.endsWith("\n")) lines.pop();
  const from = atOf(lines.find((line) => atOf(line) !== null));
  let to: number | null = null;
  for (let i = lines.length - 1; i >= 0 && to === null; i--) to = atOf(lines[i]);
  return from === null || to === null ? null : { from, to };
}

/** O recorte de `from` (exclusive) a `to` (inclusive), com o último quadro completo que vale em `from` na frente. */
export function sliceTimeline(records: readonly TimelineRecord[], from: number, to: number): TimelineRecord[] {
  let carry = -1;
  records.forEach((record, index) => {
    if (record.t === "k" && record.at <= from) carry = index;
  });
  const out: TimelineRecord[] = [];
  if (carry >= 0) out.push(records[carry]!);
  for (const record of records) if (record.at > from && record.at <= to) out.push(record);
  return out;
}

/** Junta as partes lidas em ordem (a primeira vem inteira; nas seguintes, o quadro que vai na frente é descartado). */
export function mergeParts(parts: readonly { from: number; records: readonly TimelineRecord[] }[]): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  parts.forEach((part, index) => {
    for (const record of part.records) if (index === 0 || record.at > part.from) out.push(record);
  });
  return out;
}
