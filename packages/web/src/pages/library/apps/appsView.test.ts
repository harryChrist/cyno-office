import type { AppCard, AppRun, AppsListing, CatalogApp, InstallJob, LibraryApp } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useLibraryAppsStore } from "../../../store/libraryAppsStore";
import { applyAppsEvent, appView, formatBytes, formatDuration, formatMB, isBusy, jobProgress, missing, repoLabel, runsOfApp, upsertRun } from "./appsView";

const entry = (over: Partial<CatalogApp> = {}): CatalogApp => ({
  id: "markitdown",
  name: "MarkItDown",
  area: "documentos",
  status: "disponivel",
  summary: "Lê arquivos.",
  useWhen: "",
  repo: "https://github.com/microsoft/markitdown",
  version: { kind: "pypi", ref: "0.1.9" },
  recipeVersion: "1",
  license: { spdx: "MIT", level: "livre", mustAccept: false },
  warnings: [],
  requires: [],
  recipe: [],
  provides: {},
  resources: { ramMB: 300, diskMB: 450 },
  ...over,
});

const app = (over: Partial<LibraryApp> = {}): LibraryApp => ({
  id: "markitdown",
  catalogId: "markitdown",
  name: "MarkItDown",
  version: "0.1.9",
  dir: "apps/markitdown",
  state: "instalado",
  requires: [],
  license: { spdx: "MIT", level: "livre" },
  provides: { connectorIds: ["markitdown"], skillIds: [] },
  installedAt: "2026-11-11T12:00:00.000Z",
  ...over,
});

const job = (over: Partial<InstallJob> = {}): InstallJob => ({
  id: "J-0001",
  appId: "markitdown",
  kind: "install",
  phase: "construindo",
  steps: [
    { label: "a", status: "feito" },
    { label: "b", status: "andando" },
    { label: "c", status: "pendente" },
    { label: "d", status: "pendente" },
  ],
  stepIndex: 1,
  startedAt: "2026-11-11T12:00:00.000Z",
  ...over,
});

const listing = (): AppsListing => ({ stdioAllowed: true, runtimes: [], runs: [], cards: [{ entry: entry(), requirements: [] }, { entry: entry({ id: "hyperframes", name: "HyperFrames", status: "em-breve" }), requirements: [] }] });

describe("estado do cartão", () => {
  it("cada estado do app vira o que o dono vê", () => {
    const view = (over: Partial<AppCard> & { app?: LibraryApp }) => appView({ entry: entry(), ...over });
    expect(view({})).toBe("disponivel");
    expect(appView({ entry: entry({ status: "em-breve" }) })).toBe("em-breve");
    expect(appView({ entry: entry({ status: "em-avaliacao" }) })).toBe("em-avaliacao");
    expect(view({ app: app({ state: "instalando" }) })).toBe("instalando");
    expect(view({ app: app({ state: "precisa-do-dono" }) })).toBe("precisa-do-dono");
    expect(view({ app: app({ state: "falhou" }) })).toBe("falhou");
    expect(view({ app: app({ state: "desinstalando" }) })).toBe("desinstalando");
    expect(view({ app: app({ lastTest: { at: "2026-11-11T12:00:00.000Z", ok: true, tool: "t", detail: "ok", ms: 5 } }) })).toBe("instalado-testado");
    expect(view({ app: app({ lastTest: { at: "2026-11-11T12:00:00.000Z", ok: false, tool: "t", detail: "ruim", ms: 5 } }) })).toBe("instalado-problema");
    expect(isBusy("instalando") && isBusy("atualizando") && isBusy("desinstalando")).toBe(true);
    expect(isBusy("instalado-testado")).toBe(false);
  });
});

describe("formatação", () => {
  it("tamanhos, tempos e repositório", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(340 * 1024 ** 2)).toBe("340 MB");
    expect(formatBytes(2.1 * 1024 ** 3)).toBe("2,1 GB");
    expect(formatMB(450)).toBe("450 MB");
    expect(formatMB(2200)).toBe("2,1 GB");
    expect(formatDuration(4500)).toBe("4,5 s");
    expect(formatDuration(26_000)).toBe("26 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(repoLabel("https://github.com/NandhaKishorM/laya/")).toBe("github.com/NandhaKishorM/laya");
    expect(missing([{ kind: "disk", spec: "1MB", label: "x", status: "falta" }, { kind: "ram", spec: "1MB", label: "y", status: "ok" }])).toHaveLength(1);
  });

  it("progresso do job: passos feitos, o que está andando e a razão da barra", () => {
    expect(jobProgress(job())).toEqual({ done: 1, total: 4, current: "b", ratio: 0.25 });
    expect(jobProgress(job({ steps: [] })).ratio).toBe(0);
  });
});

describe("eventos ao vivo", () => {
  it("library:app e library:job entram no cartão certo; library:app-removed limpa o app e o job", () => {
    let current = applyAppsEvent(listing(), { type: "library:app", app: app({ state: "instalando" }) })!;
    expect(current.cards[0]!.app?.state).toBe("instalando");
    expect(current.cards[1]!.app).toBeUndefined();
    current = applyAppsEvent(current, { type: "library:job", job: job() })!;
    expect(current.cards[0]!.job?.id).toBe("J-0001");
    current = applyAppsEvent(current, { type: "library:app-removed", id: "markitdown" })!;
    expect(current.cards[0]).toEqual({ entry: entry(), requirements: [] });
    // Antes do GET, ignora.
    expect(applyAppsEvent(null, { type: "library:app-removed", id: "markitdown" })).toBeNull();
  });

  it("o store junta as linhas do log ao vivo e avisa quando cancelou ou desinstalou", () => {
    const store = useLibraryAppsStore;
    store.setState({ listing: listing(), logs: {}, flash: {} });
    store.getState().apply({ type: "library:job-log", jobId: "J-0001", line: "Baixando uv" });
    store.getState().apply({ type: "library:job-log", jobId: "J-0001", line: "pronto" });
    expect(store.getState().logs["J-0001"]).toEqual(["Baixando uv", "pronto"]);
    store.getState().apply({ type: "library:job", job: job({ phase: "cancelado" }) });
    expect(store.getState().flash.markitdown).toMatch(/cancelada/);
    store.getState().dismissFlash("markitdown");
    expect(store.getState().flash.markitdown).toBeUndefined();
    store.getState().apply({ type: "library:job", job: job({ kind: "uninstall", phase: "pronto" }) });
    expect(store.getState().flash.markitdown).toMatch(/Desinstalado/);
  });

  const run = (over: Partial<AppRun>): AppRun => ({ id: "R-0001", appId: "hyperframes", tool: "render_video", state: "na-fila", enqueuedAt: "2026-11-11T12:00:00.000Z", ...over });

  it("a fila de um app: o que roda, quem espera (na ordem) e a última que terminou", () => {
    const runs = [run({ id: "R-0004", state: "na-fila", queuePosition: 2 }), run({ id: "R-0003", state: "na-fila", queuePosition: 1 }), run({ id: "R-0002", state: "rodando", progress: 40 }), run({ id: "R-0001", state: "concluida" }), run({ id: "R-0009", appId: "outro", state: "rodando" })];
    const mine = runsOfApp(runs, "hyperframes");
    expect(mine.running?.id).toBe("R-0002");
    expect(mine.queued.map((item) => item.id)).toEqual(["R-0003", "R-0004"]);
    expect(mine.last?.id).toBe("R-0001");
    expect(runsOfApp([], "x")).toEqual({ queued: [] });
  });

  it("os eventos de execução atualizam a mesma execução (ou entram no começo) e o store guarda na listagem", () => {
    expect(upsertRun([run({ id: "R-0001" })], run({ id: "R-0001", state: "rodando", progress: 10 }))[0]).toMatchObject({ state: "rodando", progress: 10 });
    expect(upsertRun([run({ id: "R-0001" })], run({ id: "R-0002" })).map((item) => item.id)).toEqual(["R-0002", "R-0001"]);
    const store = useLibraryAppsStore;
    store.setState({ listing: listing() });
    store.getState().apply({ type: "library:app-run", run: run({ id: "R-0007", state: "rodando" }) });
    expect(store.getState().listing?.runs.map((item) => item.id)).toEqual(["R-0007"]);
    store.getState().apply({ type: "library:app-run", run: run({ id: "R-0007", state: "concluida", progress: 100 }) });
    expect(store.getState().listing?.runs).toHaveLength(1);
    expect(store.getState().listing?.runs[0]?.state).toBe("concluida");
  });
});
