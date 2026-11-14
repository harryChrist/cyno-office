import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageTabs } from "./PageTabs";

type Id = "a" | "b" | "c";
const html = (props: Partial<Parameters<typeof PageTabs<Id>>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PageTabs<Id>, {
      label: "Seções",
      tabs: [
        { id: "a", label: "Primeira" },
        { id: "b", label: "Segunda" },
        { id: "c", label: "Terceira", disabled: true },
      ],
      active: "b",
      onSelect: () => {},
      testIdPrefix: "t-tab",
      ...props,
    }),
  );

describe("PageTabs", () => {
  it("uma lista de abas com a atual marcada e os data-testid de sempre", () => {
    const out = html();
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="Seções"');
    expect(out).toContain('data-testid="t-tab-a"');
    expect(out).toMatch(/aria-selected="true"[^>]*data-testid="t-tab-b"/);
    expect(out).toMatch(/aria-selected="false"[^>]*data-testid="t-tab-a"/);
    expect(out.match(/role="tab"/g)).toHaveLength(3);
  });

  it("aba desabilitada sai com disabled", () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*data-testid="t-tab-c"/);
    expect(html()).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="t-tab-a"/);
  });

  it("sem props opcionais não há id, aria-controls, contador nem área à direita", () => {
    const out = html();
    expect(out).not.toContain("aria-controls");
    expect(out).not.toContain(' id="');
    expect(out).not.toContain("pagetabs__badge");
    expect(out).not.toContain("pagetabs__trailing");
    expect(out).not.toContain("pagetabs--flush");
  });

  it("idPrefix e controls ligam as abas ao painel", () => {
    const out = html({ idPrefix: "lib-tab", controls: "lib-panel" });
    expect(out).toContain('id="lib-tab-a"');
    expect(out).toContain('aria-controls="lib-panel"');
  });

  it("badge, ícone e dica aparecem na aba; badge vazio (undefined/false) não", () => {
    const out = html({
      tabs: [
        { id: "a", label: "Primeira", badge: "em breve", icon: "★", title: "Dica" },
        { id: "b", label: "Segunda", badge: undefined },
        { id: "c", label: "Terceira", badge: false },
      ],
    });
    expect(out).toContain('<span class="pagetabs__badge">em breve</span>');
    expect(out).toContain('class="pagetabs__icon"');
    expect(out).toContain('title="Dica"');
    expect(out.match(/pagetabs__badge/g)).toHaveLength(1);
  });

  it("trailing, flush e className ficam na tira", () => {
    const out = html({ trailing: createElement("span", null, "Direita"), flush: true, className: "minha-tira" });
    expect(out).toContain('class="pagetabs pagetabs--flush minha-tira"');
    expect(out).toContain('<div class="pagetabs__trailing"><span>Direita</span></div>');
  });
});
