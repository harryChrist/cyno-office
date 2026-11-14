import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";

/** O que errou: a senha, um código (2FA/recuperação) ou o código de configuração inicial. */
export type AttemptKind = "senha" | "codigo" | "configuracao";

export type GuardOptions = {
  /** Falhas seguidas (sem acerto) que bloqueiam o IP. */
  maxFails: number;
  /** As falhas só contam dentro desta janela. */
  failWindowMs: number;
  /** Primeiro bloqueio; cada novo bloqueio do mesmo IP dentro de `strikeWindowMs` dobra o tempo. */
  baseBlockMs: number;
  maxBlockMs: number;
  strikeWindowMs: number;
  /** Quantas falhas recentes ficam guardadas para a tela de Segurança. */
  recentLimit: number;
};

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
  maxFails: 5,
  failWindowMs: 30 * 60_000,
  baseBlockMs: 15 * 60_000,
  maxBlockMs: 24 * 3_600_000,
  strikeWindowMs: 24 * 3_600_000,
  recentLimit: 100,
};

const ipStateSchema = z.object({
  fails: z.array(z.number()),
  /** Quando cada bloqueio começou (a escalada olha os das últimas 24 h). */
  strikes: z.array(z.number()),
  blockedUntil: z.number(),
  /** Quantas falhas levaram ao bloqueio atual. */
  blockedFails: z.number(),
});
type IpState = z.infer<typeof ipStateSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  ips: z.record(z.string(), ipStateSchema),
  recent: z.array(z.object({ ip: z.string(), at: z.number(), kind: z.enum(["senha", "codigo", "configuracao"]) })),
});

export type GuardLog = (level: "warn" | "info", data: Record<string, unknown>, message: string) => void;

export type ActiveBlock = { ip: string; until: number; attempts: number };
export type RecentFailure = { ip: string; at: number; kind: AttemptKind };

/**
 * Bloqueio temporário por IP com escalada, gravado em `DATA_DIR/auth-blocks.json` (0600) para que
 * reiniciar o server não libere ninguém. 5 falhas (senha, código de 2FA ou de configuração) bloqueiam
 * o IP por 15 min; cada novo bloqueio do mesmo IP em até 24 h dobra o tempo (15 min, 30, 1 h, 2 h… até 24 h).
 * Acertar zera as falhas, não o histórico de bloqueios.
 *
 * Não há freio global que tranque todo mundo: com o IP real confiável (veja client-ip.ts) ele só
 * serviria para trancar o próprio dono durante um ataque distribuído. Em vez disso, uma onda de falhas
 * de muitos IPs diferentes só é avisada no log; o custo do scrypt e a fila de verificações limitam o estrago.
 */
export class IpGuard {
  private ips = new Map<string, IpState>();
  private recent: RecentFailure[] = [];
  private writing: Promise<void> = Promise.resolve();
  private lastGlobalAlert = Number.NEGATIVE_INFINITY;
  private readonly options: GuardOptions;

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
    private readonly log: GuardLog = () => undefined,
    options: Partial<GuardOptions> = {},
  ) {
    this.options = { ...DEFAULT_GUARD_OPTIONS, ...options };
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.ips = new Map(Object.entries(parsed.ips));
      this.recent = parsed.recent;
    } catch {
      this.ips = new Map();
      this.recent = [];
    }
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    this.prune();
    const data = { version: 1, ips: Object.fromEntries(this.ips), recent: this.recent };
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(file), { recursive: true });
        await writeJsonAtomic(file, data, 0o600);
      })
      .catch(() => undefined);
  }

  private prune(): void {
    const now = this.now();
    for (const [ip, state] of this.ips) {
      state.fails = state.fails.filter((at) => at > now - this.options.failWindowMs);
      state.strikes = state.strikes.filter((at) => at > now - this.options.strikeWindowMs);
      if (state.blockedUntil <= now && state.fails.length === 0 && state.strikes.length === 0) this.ips.delete(ip);
    }
  }

  /** Segundos até este IP poder tentar de novo (0 = liberado). */
  retryAfterSeconds(ip: string): number {
    const until = this.ips.get(ip)?.blockedUntil ?? 0;
    const wait = until - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  /** Registra uma falha; devolve os segundos de bloqueio se esta falha bloqueou o IP (0 = não bloqueou). */
  fail(ip: string, kind: AttemptKind): number {
    const now = this.now();
    const { maxFails, failWindowMs, baseBlockMs, maxBlockMs, strikeWindowMs, recentLimit } = this.options;
    const state = this.ips.get(ip) ?? { fails: [], strikes: [], blockedUntil: 0, blockedFails: 0 };
    state.fails = [...state.fails.filter((at) => at > now - failWindowMs), now];
    this.ips.set(ip, state);
    this.recent = [{ ip, at: now, kind }, ...this.recent].slice(0, recentLimit);
    this.log("warn", { ip, kind, falhas: state.fails.length }, "tentativa de acesso falhou");
    this.checkGlobal(now);

    let blockedSeconds = 0;
    if (state.fails.length >= maxFails) {
      state.strikes = state.strikes.filter((at) => at > now - strikeWindowMs);
      const duration = Math.min(maxBlockMs, baseBlockMs * 2 ** state.strikes.length);
      state.strikes.push(now);
      state.blockedUntil = now + duration;
      state.blockedFails = state.fails.length;
      state.fails = [];
      blockedSeconds = Math.ceil(duration / 1000);
      this.log("warn", { ip, minutos: Math.round(duration / 60_000), ate: new Date(state.blockedUntil).toISOString(), bloqueiosEm24h: state.strikes.length }, "IP bloqueado por tentativas erradas");
    }
    this.persist();
    return blockedSeconds;
  }

  /** Acerto: zera as falhas do IP (o histórico de bloqueios fica). */
  success(ip: string): void {
    const state = this.ips.get(ip);
    if (!state || state.fails.length === 0) return;
    state.fails = [];
    this.persist();
  }

  /** O dono libera o IP à mão: some o bloqueio e o histórico de escalada dele. */
  unblock(ip: string): boolean {
    const state = this.ips.get(ip);
    if (!state) return false;
    const was = state.blockedUntil > this.now();
    this.ips.delete(ip);
    this.log("info", { ip }, "IP desbloqueado pelo dono");
    this.persist();
    return was;
  }

  blocks(): ActiveBlock[] {
    const now = this.now();
    return [...this.ips.entries()]
      .filter(([, state]) => state.blockedUntil > now)
      .map(([ip, state]) => ({ ip, until: state.blockedUntil, attempts: state.blockedFails }))
      .sort((a, b) => b.until - a.until);
  }

  failures(limit = 50): RecentFailure[] {
    return this.recent.slice(0, limit);
  }

  /** Muitos IPs diferentes errando ao mesmo tempo: só avisa (no máximo 1 vez por minuto), não tranca ninguém. */
  private checkGlobal(now: number): void {
    const windowMs = 60_000;
    const lately = this.recent.filter((entry) => entry.at > now - windowMs);
    const distinct = new Set(lately.map((entry) => entry.ip));
    if (lately.length >= 30 && distinct.size >= 10 && now - this.lastGlobalAlert > windowMs) {
      this.lastGlobalAlert = now;
      this.log("warn", { falhas: lately.length, ips: distinct.size }, "muitas falhas de acesso vindas de IPs diferentes (possível ataque distribuído)");
    }
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
