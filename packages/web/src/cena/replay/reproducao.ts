// A reconstrução do dia gravado num instante qualquer. A lógica de buscar por instante (do quadro completo anterior
// em diante), a regra do "sem dados", o gráfico por minuto e os picos vêm do `TimelineReplay` do Habblaud
// (client/src/net/timeline.ts, MIT, Copyright 2026 Márcio Junior), trocando o retrato do Habblaud pelo quadro do Cyno:
// o retrato que a cena desenha sai do mesmo adaptador do ao vivo (`montarRetrato`).
import { applyChanges, cloneFrame, emptyFrame, frameOf, GAP_SLACK_MS, localHourOf, type SceneFrame, type TimelineRecord } from "@cyno/shared";
import type { OfficeSnapshot } from "@cyno/cena";
import { entradaDoQuadro, memoriaInicial, montarRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

export const BUCKET_MS = 60_000;
const PEAKS = 4;
const DEFAULT_EVERY = 300_000;
/** Distância mínima entre dois picos: 1/8 do período gravado, entre 10 min e 1 h. */
const peakSpacing = (span: number) => Math.min(60 * 60_000, Math.max(10 * 60_000, span / 8));

/** Um minuto do dia: o máximo de agentes presentes, trabalhando e esperando o dono. */
export interface Bucket {
  at: number;
  present: number;
  working: number;
  waiting: number;
}

export interface Peak {
  at: number;
  working: number;
  present: number;
}

/** O agente espera o dono (aprovação pendente, projeto parado "esperando você" ou terminal com erro)? */
export function esperandoODono(agent: SceneFrame["agents"] extends Map<string, infer A> ? A : never): boolean {
  return Boolean(agent.asking) || agent.blocked?.type === "voce" || agent.status === "waiting_approval" || agent.terminal?.status === "error";
}

export function contar(frame: SceneFrame): { present: number; working: number; waiting: number } {
  let present = 0;
  let working = 0;
  let waiting = 0;
  for (const agent of frame.agents.values()) {
    present++;
    if (esperandoODono(agent)) waiting++;
    else if (agent.status === "working" || agent.terminal?.status === "busy") working++;
  }
  return { present, working, waiting };
}

export class Reproducao {
  readonly from: number;
  readonly to: number;
  /** Índices dos quadros completos em `records`. */
  private readonly keys: number[] = [];
  private frame: SceneFrame = emptyFrame();
  /** Último registro aplicado (-1 = antes do primeiro). */
  private cursor = -1;
  private every = DEFAULT_EVERY;
  private memoria: MemoriaDaCena = memoriaInicial(0);
  private cache: Bucket[] | null = null;

  constructor(
    readonly day: string,
    readonly records: readonly TimelineRecord[],
  ) {
    records.forEach((record, index) => {
      if (record.t === "k") this.keys.push(index);
    });
    this.from = records[0]?.at ?? 0;
    this.to = records[records.length - 1]?.at ?? this.from;
  }

  get empty(): boolean {
    return this.records.length === 0;
  }

  /** Leva a reconstrução até o instante `t` (para trás ou longe: recomeça do quadro completo anterior). */
  moveTo(t: number): void {
    const target = this.indexAt(t);
    if (target === this.cursor) return;
    if (target < 0) {
      this.frame = emptyFrame();
      this.cursor = -1;
      return;
    }
    let start: number;
    if (target < this.cursor || this.cursor < 0) {
      start = this.keyAtOrBefore(target);
      if (start < 0) {
        this.frame = emptyFrame();
        start = 0;
      }
    } else {
      start = this.cursor + 1;
      const key = this.keyAtOrBefore(target);
      if (key > this.cursor) start = key;
    }
    for (let i = start; i <= target; i++) this.apply(i);
    this.cursor = target;
  }

  /** O quadro do último `moveTo` (cópia: quem recebe pode guardar). */
  quadro(): SceneFrame {
    return cloneFrame(this.frame);
  }

  /** Sem dados em `t`: antes da gravação, servidor parado (fim marcado) ou silêncio longo demais. */
  isOff(t: number): boolean {
    if (this.cursor < 0) return true;
    const last = this.records[this.cursor]!;
    if (last.t === "end") return true;
    return t - last.at > this.every * 1.5 + GAP_SLACK_MS;
  }

  /** O fim marcado mais recente foi pelo limite de tamanho do dia. */
  get limited(): boolean {
    const last = this.records[this.cursor];
    return last?.t === "end" && last.reason === "limit";
  }

  /** Esquece o que o adaptador lembra (pulo no tempo: todo mundo já aparece no lugar, sem festa do passado). */
  reiniciarMemoria(t: number): void {
    this.memoria = memoriaInicial(t);
  }

  /** O retrato do instante `t` (chame `moveTo(t)` antes), montado pelo mesmo adaptador do ao vivo. */
  retrato(t: number, workspaceId: string, workspaceName: string): OfficeSnapshot {
    const off = this.isOff(t);
    const quadro = off ? emptyFrame() : this.frame;
    const { snapshot, memoria } = montarRetrato({ ...entradaDoQuadro(quadro, t), workspaceId, workspaceName }, this.memoria);
    this.memoria = memoria;
    return snapshot;
  }

  /** Agentes presentes, trabalhando e esperando o dono, minuto a minuto (o gráfico da régua). */
  buckets(): Bucket[] {
    if (this.cache) return this.cache;
    const out: Bucket[] = [];
    if (this.empty) return (this.cache = out);
    const base = Math.floor(this.from / BUCKET_MS) * BUCKET_MS;
    const n = Math.min(2 * 1441, Math.floor((this.to - base) / BUCKET_MS) + 1);
    for (let i = 0; i < n; i++) out.push({ at: base + i * BUCKET_MS, present: 0, working: 0, waiting: 0 });
    let frame = emptyFrame();
    let every = DEFAULT_EVERY;
    let ended = false;
    let counts = { present: 0, working: 0, waiting: 0 };
    let lastAt = this.from;
    const fill = (fromAt: number, toAt: number, c: typeof counts) => {
      // Do registro anterior até este o estado não mudou (salvo silêncio longo = servidor parado).
      const until = ended ? fromAt : Math.min(toAt, fromAt + every * 1.5 + GAP_SLACK_MS);
      for (let i = Math.max(0, Math.floor((fromAt - base) / BUCKET_MS)); i < n && base + i * BUCKET_MS <= until; i++) {
        const bucket = out[i]!;
        bucket.present = Math.max(bucket.present, c.present);
        bucket.working = Math.max(bucket.working, c.working);
        bucket.waiting = Math.max(bucket.waiting, c.waiting);
      }
    };
    for (const record of this.records) {
      fill(lastAt, record.at, counts);
      if (record.t === "k") {
        frame = frameOf(record);
        every = record.every;
        ended = false;
      } else if (record.t === "d") {
        applyChanges(frame, record);
        ended = false;
      } else ended = true;
      counts = ended ? { present: 0, working: 0, waiting: 0 } : contar(frame);
      lastAt = record.at;
      fill(record.at, record.at, counts);
    }
    return (this.cache = out);
  }

  /** Os momentos de pico (mais agentes trabalhando ao mesmo tempo), espaçados, em ordem cronológica. */
  peaks(): Peak[] {
    const ranked = this.buckets()
      .filter((bucket) => bucket.working > 0)
      .sort((a, b) => b.working - a.working || b.present - a.present || a.at - b.at);
    const out: Peak[] = [];
    const spacing = peakSpacing(this.to - this.from);
    for (const bucket of ranked) {
      if (out.length >= PEAKS) break;
      if (out.some((peak) => Math.abs(peak.at - bucket.at) < spacing)) continue;
      out.push({ at: bucket.at, working: bucket.working, present: bucket.present });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------- internos

  private apply(i: number): void {
    const record = this.records[i]!;
    if (record.t === "k") {
      this.frame = frameOf(record);
      this.every = record.every;
    } else if (record.t === "d") applyChanges(this.frame, record);
  }

  /** Último registro com `at` <= t (-1 = antes do primeiro). Os registros estão em ordem de `at`. */
  private indexAt(t: number): number {
    let lo = 0;
    let hi = this.records.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.records[mid]!.at <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Índice do último quadro completo em ou antes do registro `i` (-1 = nenhum). */
  private keyAtOrBefore(i: number): number {
    let ans = -1;
    for (const key of this.keys) {
      if (key > i) break;
      ans = key;
    }
    return ans;
  }
}

/** Horas cheias (de São Paulo) para as marcas da régua: no máximo ~6. */
export function hourTicks(from: number, to: number): number[] {
  const span = (to - from) / 3_600_000;
  const step = [1, 2, 3, 4, 6].find((s) => span / s <= 6) ?? 12;
  const out: number[] = [];
  const HOUR = 3_600_000;
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) {
    if (t > from && localHourOf(t) % step === 0) out.push(t);
  }
  return out;
}
