import type { AppCard, AppRun, AppsListing, InstallJob, LibraryApp, RequirementResult, RequirementStatus, ServerEvent } from "@cyno/shared";

// ---------- Estado de um cartão ----------

/** O que o cartão mostra: o estado do app (ou do catálogo) em palavras do dono. */
export type AppView = "disponivel" | "em-breve" | "em-avaliacao" | "instalando" | "atualizando" | "desinstalando" | "precisa-do-dono" | "falhou" | "instalado-testado" | "instalado-problema";

export function appView(card: Pick<AppCard, "entry" | "app">): AppView {
  const { app, entry } = card;
  if (!app) return entry.status === "disponivel" ? "disponivel" : entry.status;
  switch (app.state) {
    case "instalando":
    case "atualizando":
    case "desinstalando":
    case "precisa-do-dono":
    case "falhou":
      return app.state;
    case "instalado":
      return app.lastTest && !app.lastTest.ok ? "instalado-problema" : "instalado-testado";
  }
}

export type Tone = "neutral" | "busy" | "attention" | "success" | "danger";

export const VIEW_BADGE: Record<AppView, { label: string; tone: Tone }> = {
  disponivel: { label: "Disponível", tone: "neutral" },
  "em-breve": { label: "Em breve", tone: "neutral" },
  "em-avaliacao": { label: "Em avaliação", tone: "neutral" },
  instalando: { label: "Instalando…", tone: "busy" },
  atualizando: { label: "Atualizando…", tone: "busy" },
  desinstalando: { label: "Desinstalando…", tone: "busy" },
  "precisa-do-dono": { label: "Precisa de você", tone: "attention" },
  falhou: { label: "Falhou", tone: "danger" },
  "instalado-testado": { label: "Instalado e testado", tone: "success" },
  "instalado-problema": { label: "Instalado, com problema", tone: "attention" },
};

/** Tem operação em andamento (instalando, atualizando, desinstalando)? */
export const isBusy = (view: AppView) => view === "instalando" || view === "atualizando" || view === "desinstalando";

// ---------- Requisitos ----------

export const REQUIREMENT_MARK: Record<RequirementStatus, { mark: string; tone: Tone; word: string }> = {
  ok: { mark: "✓", tone: "success", word: "tem" },
  baixa: { mark: "↓", tone: "busy", word: "será baixado" },
  aviso: { mark: "!", tone: "attention", word: "atenção" },
  falta: { mark: "✗", tone: "danger", word: "falta" },
};

/** O requisito não atende (✗)? */
export const missing = (requirements: readonly RequirementResult[]) => requirements.filter((requirement) => requirement.status === "falta");

// ---------- Tamanhos e tempo ----------

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".", ",")} GB` : `${mb} MB`;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1).replace(".", ",")} s` : seconds < 90 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

// ---------- Progresso ----------

/** Quantos passos terminaram e qual está andando (para a barra e o texto "passo 2 de 5"). */
export function jobProgress(job: InstallJob): { done: number; total: number; current?: string; ratio: number } {
  const done = job.steps.filter((step) => step.status === "feito").length;
  const current = job.steps.find((step) => step.status === "andando" || step.status === "precisa" || step.status === "falhou")?.label;
  return { done, total: job.steps.length, ...(current ? { current } : {}), ratio: job.steps.length === 0 ? 0 : done / job.steps.length };
}

export const PHASE_LABEL: Record<InstallJob["phase"], string> = {
  checando: "Conferindo a máquina",
  baixando: "Baixando",
  construindo: "Instalando",
  registrando: "Registrando o conector",
  testando: "Rodando o mini teste",
  pronto: "Pronto",
  falhou: "Falhou",
  "precisa-do-dono": "Esperando você",
  cancelado: "Cancelado",
  removendo: "Removendo",
};

// ---------- Eventos ao vivo ----------

type AppsEvent = Extract<ServerEvent, { type: "library:app" | "library:app-removed" | "library:job" | "library:app-run" }>;

const MAX_RUNS = 30;

/** Aplica uma execução (fila/andamento/fim) à lista de execuções: troca a de mesmo id ou entra no começo. */
export function upsertRun(runs: readonly AppRun[], run: AppRun): AppRun[] {
  const without = runs.filter((other) => other.id !== run.id);
  const known = runs.some((other) => other.id === run.id);
  return known ? runs.map((other) => (other.id === run.id ? run : other)) : [run, ...without].slice(0, MAX_RUNS);
}

/** Execuções de um app: a que está rodando, as da fila (em ordem) e as últimas terminadas. */
export function runsOfApp(runs: readonly AppRun[], appId: string): { running?: AppRun; queued: AppRun[]; last?: AppRun } {
  const mine = runs.filter((run) => run.appId === appId);
  const running = mine.find((run) => run.state === "rodando");
  const queued = mine.filter((run) => run.state === "na-fila").sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const last = mine.find((run) => run.state === "concluida" || run.state === "falhou" || run.state === "cancelada");
  return { ...(running ? { running } : {}), queued, ...(last ? { last } : {}) };
}

/** Aplica os eventos `library:app`, `library:app-removed` e `library:job` à listagem (antes do GET, ignora). */
export function applyAppsEvent(listing: AppsListing | null, event: AppsEvent): AppsListing | null {
  if (!listing) return listing;
  if (event.type === "library:app-run") return { ...listing, runs: upsertRun(listing.runs ?? [], event.run) };
  const cards = listing.cards.map((card) => {
    if (event.type === "library:app") return card.entry.id === event.app.catalogId ? { ...card, app: event.app, update: card.update && event.app.state === "instalado" ? card.update : undefined } : card;
    if (event.type === "library:app-removed") {
      if (card.entry.id !== event.id) return card;
      const { app: _app, job: _job, update: _update, ...rest } = card;
      return rest;
    }
    return card.entry.id === event.job.appId ? { ...card, job: event.job } : card;
  });
  return { ...listing, cards };
}

/** Marca "atualização disponível" quando o app instalado ficou para trás (a listagem do servidor já traz). */
export const hasUpdate = (card: AppCard): boolean => Boolean(card.update && card.app?.state === "instalado");

/** Link curto do repositório para mostrar ("github.com/microsoft/markitdown"). */
export function repoLabel(repo: string): string {
  try {
    const url = new URL(repo);
    return `${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return repo;
  }
}

/** O app tem o que mostrar no cartão "Instalado e testado" (o que o mini teste devolveu)? */
export const testSummary = (app: LibraryApp | undefined): string | undefined => app?.lastTest?.detail;
