import { describe, expect, it } from "vitest";
import { compactSnapshot } from "./snapshot";
import { hasSensitiveWord, looksLoggedIn, sensitiveReason, type TargetInfo } from "./sensitive";

const target = (over: Partial<TargetInfo>): TargetInfo => ({ label: "", button: false, link: false, submits: false, searchForm: false, freeText: false, ...over });

describe("ações sensíveis do navegador", () => {
  it("palavras de publicar/enviar/comprar (pt-BR e inglês), sem pegar pedaço de palavra", () => {
    for (const text of ["Publicar", "Post", "Enviar mensagem", "Send", "Comprar agora", "Pagar R$ 10", "Confirmar", "Conectar", "Seguir", "Place order"]) {
      expect(hasSensitiveWord(text), text).toBe(true);
    }
    for (const text of ["Posts", "Pesquisa Google", "Próximo", "Ver perfil", "Postagens", "Imposto"]) {
      expect(hasSensitiveWord(text), text).toBe(false);
    }
  });

  it("botão com palavra sensível pede aprovação; link com a mesma palavra não", () => {
    expect(sensitiveReason({ kind: "click", target: target({ label: "Publicar", button: true }) }, false)).toContain("Publicar");
    expect(sensitiveReason({ kind: "click", target: target({ label: "Post a job", link: true }) }, true)).toBeNull();
    expect(sensitiveReason({ kind: "click", target: target({ label: "Ver mais", button: true }) }, true)).toBeNull();
  });

  it("abrir menu e copiar link seguem sem aprovação, mesmo com 'post' no rótulo; os itens que publicam continuam pedindo", () => {
    const click = (over: Partial<TargetInfo>) => sensitiveReason({ kind: "click", target: target({ button: true, ...over }) }, true);
    for (const label of ["Open control menu for post by Lucas Cardoso", "Copy link to post", "Copiar link da publicação", "Mais opções", "See more"]) {
      expect(click({ label }), label).toBeNull();
    }
    expect(click({ label: "Repost", opensMenu: true })).toBeNull();
    for (const label of ["Repost", "Post", "Send", "Publicar", "Share post", "Enviar mais tarde"]) {
      expect(click({ label }), label).not.toBeNull();
    }
    // Botão que envia formulário não vira "só leitura" pelo rótulo.
    expect(click({ label: "Copiar link e enviar", submits: true })).not.toBeNull();
  });

  it("enviar formulário só pede aprovação com login e fora de busca", () => {
    const form = target({ label: "Salvar", button: true, submits: true });
    expect(sensitiveReason({ kind: "click", target: form }, false)).toBeNull();
    expect(sensitiveReason({ kind: "click", target: form }, true)).toContain("formulário");
    expect(sensitiveReason({ kind: "submit", target: target({ submits: true, searchForm: true }) }, true)).toBeNull();
    expect(sensitiveReason({ kind: "submit", target: target({ freeText: true }) }, true)).toContain("mensagem");
    expect(sensitiveReason({ kind: "submit", target: target({ freeText: true }) }, false)).toBeNull();
  });

  it("cookies de sessão indicam login; os de preferência não", () => {
    expect(looksLoggedIn([{ name: "li_at" }])).toBe(true);
    expect(looksLoggedIn([{ name: "__Secure-1PSID" }])).toBe(true);
    expect(looksLoggedIn([{ name: "my_session_id" }])).toBe(true);
    expect(looksLoggedIn([{ name: "NID" }, { name: "lang" }, { name: "_ga" }])).toBe(false);
  });
});

describe("compactSnapshot", () => {
  it("enxuga marcas, encurta URLs e corta em partes com aviso", () => {
    const raw = ['- link "Oi" [ref=e2] [cursor=pointer]:', `  - /url: https://x.com/${"a".repeat(300)}`, "- generic [ref=e3]", ...Array.from({ length: 400 }, (_, i) => `- text: linha ${i}`)].join("\n");
    const first = compactSnapshot(raw, 2000);
    expect(first).toContain('- link "Oi" [ref=e2]:');
    expect(first).not.toContain("cursor=pointer");
    expect(first).not.toContain("- generic [ref=e3]");
    expect(first).toContain("…");
    expect(first.startsWith("(part 1 of")).toBe(true);
    expect(first).toContain("call browser_snapshot with part: 2");
    const last = compactSnapshot(raw, 2000, 99);
    expect(last).toContain("linha 399");
    expect(last).not.toContain("page continues");
    expect(compactSnapshot("- text: curto")).toBe("- text: curto");
  });
});
