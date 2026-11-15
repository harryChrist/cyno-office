import type { UpdateCheckState, VersionInfo } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { navVersionView } from "../../version/versionView";
import { NavVersionView } from "./NavVersion";

const version: VersionInfo = {
  version: "0.1.0",
  build: 3,
  commit: { hash: "1".repeat(40), short: "1111111", date: "2026-11-15T04:35:11Z", subject: "x" },
  branch: "main",
  dirty: false,
  source: "git",
  repoUrl: null,
  label: "v0.1.0 · build 3 · 1111111",
};
const check = (patch: Partial<UpdateCheckState> = {}): UpdateCheckState => ({ auto: true, branch: "main", checking: false, checkedAt: null, status: "up-to-date", remote: null, count: null, commits: null, commitsUrl: null, reason: null, ...patch });
const render = (data: Parameters<typeof navVersionView>[0], open = false) => renderToStaticMarkup(createElement(NavVersionView, { view: navVersionView(data), open, onOpen: () => undefined }));

describe("item de versão da barra lateral", () => {
  it("sem dados, não aparece", () => {
    expect(render(null)).toBe("");
  });

  it("em dia: um botão com o rótulo curto, sem ponto", () => {
    const html = render({ version, check: check() });
    expect(html).toContain('data-testid="nav-version"');
    expect(html).toContain("v0.1.0 · build 3");
    expect(html).not.toContain("nav-version-dot");
    expect(html).not.toContain("navversion--update");
    expect(html).toContain('aria-label="Versão v0.1.0 · build 3. Abrir Versão e atualizações"');
  });

  it("com atualização: destaque, ponto e nome acessível", () => {
    const html = render({ version, check: check({ status: "update-available", count: 2 }) });
    expect(html).toContain("Atualização disponível");
    expect(html).toContain("navversion--update");
    expect(html).toContain('data-testid="nav-version-dot"');
    expect(html).toContain('aria-label="Atualização disponível, 2 commits novos no main.');
    expect(html).toContain('title="Atualização disponível: 2 commits novos no main.');
  });

  it("na página das Configurações, o item fica marcado", () => {
    expect(render({ version, check: check() }, true)).toContain('aria-current="page"');
    expect(render({ version, check: check() }, false)).not.toContain("aria-current");
  });

  it("reinício pendente: destaque âmbar, ponto e nome acessível, com prioridade sobre a atualização", () => {
    const update = { enabled: true, canDownload: false, runMode: "pm2" as const, restartNeeded: true, diskCommit: { hash: "2".repeat(40), short: "2222222" }, runningCommit: null, job: null };
    const html = render({ version, check: check({ status: "update-available", count: 2 }), update });
    expect(html).toContain("Reinicie para aplicar");
    expect(html).not.toContain("Atualização disponível");
    expect(html).toContain("navversion--restart");
    expect(html).toContain('data-testid="nav-version-dot"');
    expect(html).toContain('aria-label="Reinicie para aplicar, o código novo (2222222) já está no disco.');
  });
});
