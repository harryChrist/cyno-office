import type { UpdateApplyState, UpdateCheckState, UpdateJob, VersionInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  checkStatusView,
  commitLine,
  commitRows,
  countCommits,
  DOWNLOAD_LABEL,
  downloadConfirmText,
  hiddenCommits,
  howtoView,
  INSTALL_GUIDES,
  jobFailureText,
  lastCheckedText,
  menuButtonLabel,
  navTone,
  navVersionView,
  progressText,
  RESTART_TITLE,
  restartGuides,
  restartNoticeView,
  sourceNote,
  updateActionView,
  versionShort,
} from "./versionView";

const info: VersionInfo = {
  version: "0.1.0",
  build: 3,
  commit: { hash: "1e014a602d1a24f27f6385e3463a01b68987b79c", short: "1e014a6", date: "2026-11-15T04:35:11Z", subject: "Pastas de trabalho" },
  branch: "dev",
  dirty: false,
  source: "git",
  repoUrl: "https://github.com/dono/repo",
  label: "v0.1.0 · build 3 · 1e014a6",
};
const check = (patch: Partial<UpdateCheckState> = {}): UpdateCheckState => ({
  auto: true,
  branch: "main",
  checking: false,
  checkedAt: "2026-11-15T10:00:00Z",
  status: "up-to-date",
  remote: null,
  count: null,
  commits: null,
  commitsUrl: null,
  reason: null,
  ...patch,
});

describe("versionShort", () => {
  it("v0.1.0 · build 3, e só a versão sem build", () => {
    expect(versionShort(info)).toBe("v0.1.0 · build 3");
    expect(versionShort({ version: "0.1.0", build: null })).toBe("v0.1.0");
  });
});

describe("navVersionView", () => {
  it("sem dados, nada aparece", () => {
    expect(navVersionView(null)).toBeNull();
  });

  it("em dia: o rótulo discreto da versão", () => {
    const view = navVersionView({ version: info, check: check() })!;
    expect(view).toMatchObject({ text: "v0.1.0 · build 3", sub: null, available: false });
    expect(view.aria).toContain("Versão v0.1.0 · build 3");
  });

  it("com atualização: o destaque, a versão instalada embaixo e a dica com a contagem", () => {
    const view = navVersionView({ version: info, check: check({ status: "update-available", count: 4 }) })!;
    expect(view).toMatchObject({ text: "Atualização disponível", sub: "v0.1.0 · build 3", available: true });
    expect(view.tip).toContain("4 commits novos no main");
    expect(view.aria).toContain("Atualização disponível");
  });

  it("com atualização e sem contagem (lista indisponível)", () => {
    const view = navVersionView({ version: info, check: check({ status: "update-available", count: null }) })!;
    expect(view.tip).toContain("há novidades no main");
  });

  it("não foi possível verificar não acende o destaque", () => {
    expect(navVersionView({ version: info, check: check({ status: "unavailable", reason: "x" }) })!.available).toBe(false);
  });
});

describe("checkStatusView", () => {
  it("em dia", () => {
    expect(checkStatusView(check())).toMatchObject({ tone: "ok", title: "Em dia" });
  });
  it("há N atualizações", () => {
    expect(checkStatusView(check({ status: "update-available", count: 1 })).title).toBe("Há 1 atualização");
    expect(checkStatusView(check({ status: "update-available", count: 5 })).title).toBe("Há 5 atualizações");
    expect(checkStatusView(check({ status: "update-available", count: null })).title).toBe("Há atualização");
  });
  it("não foi possível verificar, com o motivo", () => {
    expect(checkStatusView(check({ status: "unavailable", reason: "Sem conexão com o repositório." }))).toEqual({ tone: "warn", title: "Não foi possível verificar", detail: "Sem conexão com o repositório." });
  });
  it("nunca verificado: automática ligada ou desligada", () => {
    expect(checkStatusView(check({ status: "none", checkedAt: null })).title).toBe("Ainda não verificado");
    expect(checkStatusView(check({ status: "none", checkedAt: null, auto: false }))).toMatchObject({ tone: "off", title: "Verificação automática desligada" });
  });
});

describe("textos auxiliares", () => {
  it("última verificação", () => {
    const now = new Date("2026-11-15T10:05:00Z");
    expect(lastCheckedText(check(), now)).toBe("Última verificação há 5 min");
    expect(lastCheckedText(check({ checkedAt: null }), now)).toBe("Ainda não verificado");
  });
  it("contagem de commits", () => {
    expect(countCommits(1)).toBe("1 commit novo");
    expect(countCommits(2)).toBe("2 commits novos");
  });
  it("linhas do commit instalado", () => {
    expect(commitRows(info).map((row) => row.id)).toEqual(["version", "build", "commit", "subject", "date", "branch"]);
    expect(commitRows({ ...info, build: null, commit: null, branch: null, source: "package" }).map((row) => row.id)).toEqual(["version"]);
  });
  it("notas por origem da informação", () => {
    expect(sourceNote(info)).toBeNull();
    expect(sourceNote({ ...info, source: "file" })).toContain("imagem");
    expect(sourceNote({ ...info, source: "package", commit: null })).toContain("package.json");
  });
  it("linha de commit novo e commits que a lista não mostra", () => {
    expect(commitLine({ hash: "a".repeat(40), short: "aaaaaaa", date: "", subject: "" })).toEqual({ subject: "(sem assunto)", meta: "aaaaaaa" });
    expect(hiddenCommits({ count: 30, commits: Array.from({ length: 20 }, () => ({ hash: "", short: "", date: "", subject: "" })) })).toBe(10);
    expect(hiddenCommits({ count: null, commits: null })).toBe(0);
  });
});

describe("como atualizar", () => {
  it("pm2 e Docker, com os comandos da documentação", () => {
    const byId = Object.fromEntries(INSTALL_GUIDES.map((guide) => [guide.id, guide.steps.map((step) => step.command)]));
    expect(byId.pm2).toEqual(["git pull", "npm install", "npm run pm2:restart"]);
    expect(byId.docker).toEqual(["git pull", "npm run docker:up"]);
  });
  it("nenhum texto da tela usa travessão ou seta", () => {
    const text = JSON.stringify(INSTALL_GUIDES) + checkStatusView(check({ status: "update-available", count: 2 })).detail;
    expect(text).not.toMatch(/[—→]/);
  });
});

const hash = (char: string) => char.repeat(40);
const job = (patch: Partial<UpdateJob> = {}): UpdateJob => ({ state: "done", step: null, startedAt: "2026-11-15T10:00:00Z", finishedAt: "2026-11-15T10:00:05Z", from: "1111111", to: "2222222", codeUpdated: true, installRan: false, installFailed: false, message: null, log: [], ...patch });
const apply = (patch: Partial<UpdateApplyState> = {}): UpdateApplyState => ({ enabled: true, canDownload: true, runMode: "pm2", restartNeeded: false, diskCommit: null, runningCommit: { hash: hash("1"), short: "1111111" }, job: null, ...patch });
const available = check({ status: "update-available", count: 2 });

describe("botão Baixar atualização", () => {
  it("sem dados do servidor de atualização, nada", () => {
    expect(updateActionView(null)).toEqual({ kind: "none" });
    expect(updateActionView({ check: available })).toEqual({ kind: "none" });
  });
  it("disponível e permitido: o botão principal", () => {
    expect(updateActionView({ check: available, update: apply() })).toEqual({ kind: "download", label: "Baixar atualização" });
    expect(DOWNLOAD_LABEL).toBe("Baixar atualização");
  });
  it("bloqueado com atualização no ar: botão desabilitado e o motivo", () => {
    expect(updateActionView({ check: available, update: apply({ canDownload: false, blockedReason: "Há mudanças locais em arquivos do projeto." }) })).toEqual({ kind: "blocked", label: "Baixar atualização", reason: "Há mudanças locais em arquivos do projeto." });
  });
  it("em dia: nenhum botão, mesmo que bloqueado", () => {
    expect(updateActionView({ check: check(), update: apply({ canDownload: false, blockedReason: "Não há atualização disponível na última verificação." }) })).toEqual({ kind: "none" });
  });
  it("durante o download: andamento por passo, que ganha de tudo", () => {
    const running = apply({ canDownload: false, job: job({ state: "running", step: "fetching" }) });
    expect(updateActionView({ check: available, update: running })).toEqual({ kind: "running", label: "Baixando…", progress: "Baixando o código…" });
    expect(progressText({ state: "running", step: "installing" })).toBe("Instalando dependências…");
    expect(progressText({ state: "running", step: null })).toBe("Baixando o código…");
  });
  it("Docker: sem botão, só a instrução", () => {
    expect(updateActionView({ check: available, update: apply({ runMode: "docker", canDownload: false }) })).toEqual({ kind: "docker" });
    expect(updateActionView({ check: check(), update: apply({ runMode: "docker", canDownload: false }) })).toEqual({ kind: "none" });
  });
  it("a confirmação diz o que faz e que não reinicia", () => {
    const text = downloadConfirmText("main");
    expect(text.lines.join(" ")).toContain("ramo main");
    expect(text.lines.join(" ")).toContain("instala as dependências se elas mudaram");
    expect(text.lines.join(" ")).toContain("Nada é reiniciado");
  });
  it("falha sem mudar o código mostra a mensagem; com o código novo, não (vai para o aviso de reinício)", () => {
    expect(jobFailureText(job({ state: "failed", codeUpdated: false, message: "Não foi possível baixar o código. Nada foi alterado." }))).toBe("Não foi possível baixar o código. Nada foi alterado.");
    expect(jobFailureText(job({ state: "failed", codeUpdated: true, installFailed: true }))).toBeNull();
    expect(jobFailureText(job())).toBeNull();
    expect(jobFailureText(null)).toBeNull();
  });
});

describe("instrução de reinício por jeito de rodar", () => {
  it("pm2 primeiro: npm run pm2:restart; os outros recolhidos", () => {
    const { primary, others } = restartGuides("pm2");
    expect(primary.command).toBe("npm run pm2:restart");
    expect(others.map((guide) => guide.id)).toEqual(["start", "dev", "docker"]);
  });
  it("start: parar e rodar npm start de novo", () => {
    const { primary } = restartGuides("start");
    expect(primary.command).toBe("npm start");
    expect(primary.lead).toContain("Pare o processo");
  });
  it("dev: reinicia sozinho; se não mudar, parar e rodar npm run dev", () => {
    const { primary, others } = restartGuides("dev");
    expect(primary.lead).toContain("reinicia sozinho");
    expect(primary.lead).toContain("pare e rode de novo");
    expect(primary.command).toBe("npm run dev");
    expect(others.map((guide) => guide.id)).not.toContain("dev");
  });
  it("docker: no hospedeiro", () => {
    expect(restartGuides("docker").primary).toMatchObject({ command: "npm run docker:up" });
    expect(restartGuides("docker").primary.lead).toContain("hospedeiro");
  });
});

describe("aviso de reinício pendente", () => {
  it("sem reinício pendente e sem falha de instalação, não há aviso", () => {
    expect(restartNoticeView(undefined)).toBeNull();
    expect(restartNoticeView(apply())).toBeNull();
    expect(restartNoticeView(apply({ job: job({ state: "failed", codeUpdated: false }) }))).toBeNull();
  });
  it("baixado pelo botão: o título pedido, os commits e o comando do pm2 em primeiro", () => {
    const view = restartNoticeView(apply({ restartNeeded: true, diskCommit: { hash: hash("2"), short: "2222222" }, job: job() }))!;
    expect(view.title).toBe("Atualização baixada. Reinicie para aplicar.");
    expect(RESTART_TITLE).toBe(view.title);
    expect(view.detail).toBe("Do commit 1111111 para 2222222.");
    expect(view.primary.command).toBe("npm run pm2:restart");
    expect(view.warning).toContain("interrompe os agentes");
    expect(view.beforeCommand).toBeNull();
    expect(view.tone).toBe("warn");
  });
  it("baixado à mão (git pull): o mesmo aviso, explicando a diferença", () => {
    const view = restartNoticeView(apply({ runMode: "start", restartNeeded: true, diskCommit: { hash: hash("3"), short: "3333333" } }))!;
    expect(view.title).toBe(RESTART_TITLE);
    expect(view.detail).toContain("3333333");
    expect(view.detail).toContain("1111111");
    expect(view.primary.command).toBe("npm start");
  });
  it("npm install falhou: pede o npm install antes de reiniciar", () => {
    const view = restartNoticeView(apply({ restartNeeded: true, diskCommit: { hash: hash("2"), short: "2222222" }, job: job({ state: "failed", installRan: true, installFailed: true }) }))!;
    expect(view.tone).toBe("error");
    expect(view.title).toBe("Falta instalar as dependências.");
    expect(view.beforeCommand?.command).toBe("npm install");
    expect(view.primary.command).toBe("npm run pm2:restart");
  });
});

describe("como atualizar à mão", () => {
  it("com o botão disponível ou rodando, a lista fica recolhida", () => {
    expect(howtoView({ check: available, update: apply() }).open).toBe(false);
    expect(howtoView({ check: available, update: apply({ canDownload: false, job: job({ state: "running", step: "merging" }) }) }).open).toBe(false);
  });
  it("bloqueado ou Docker: a lista abre, com o Docker primeiro quando é o caso", () => {
    expect(howtoView({ check: available, update: apply({ canDownload: false, blockedReason: "x" }) })).toMatchObject({ open: true, order: ["pm2", "docker"] });
    expect(howtoView({ check: available, update: apply({ runMode: "docker", canDownload: false }) })).toMatchObject({ open: true, order: ["docker", "pm2"] });
  });
  it("em dia: recolhida", () => {
    expect(howtoView({ check: check(), update: apply({ canDownload: false }) }).open).toBe(false);
  });
});

describe("indicador da barra com reinício pendente", () => {
  const restartUpdate = apply({ restartNeeded: true, diskCommit: { hash: hash("2"), short: "2222222" } });
  it("terceiro estado, com prioridade sobre a atualização disponível", () => {
    const view = navVersionView({ version: info, check: available, update: restartUpdate })!;
    expect(view).toMatchObject({ text: "Reinicie para aplicar", sub: "v0.1.0 · build 3", available: false, tone: "restart" });
    expect(view.tip).toContain("2222222");
    expect(view.aria).toContain("Reinicie para aplicar");
  });
  it("tons: normal, atualização e reinício", () => {
    expect(navTone(null)).toBe("normal");
    expect(navTone({ check: check(), update: apply() })).toBe("normal");
    expect(navTone({ check: available, update: apply() })).toBe("update");
    expect(navTone({ check: available, update: restartUpdate })).toBe("restart");
    expect(navTone({ check: check(), update: restartUpdate })).toBe("restart");
  });
  it("nome do botão de menu do celular", () => {
    expect(menuButtonLabel("normal")).toBe("Abrir o menu");
    expect(menuButtonLabel("update")).toContain("atualização disponível");
    expect(menuButtonLabel("restart")).toContain("reinicie");
  });
  it("nenhum texto novo usa travessão ou seta", () => {
    const text = JSON.stringify([restartGuides("pm2"), restartGuides("dev"), downloadConfirmText("main"), restartNoticeView(restartUpdate), howtoView({ check: available, update: apply({ canDownload: false }) }), navVersionView({ version: info, check: available, update: restartUpdate })]);
    expect(text).not.toMatch(/[—→]/);
  });
});
