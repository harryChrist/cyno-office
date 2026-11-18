import type { Board } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { accentIndex, applyBoardEvent, boardCountLabel, filterBoards, initialOf, moveIndex, normalizeText, resolveRoute, sortBoards, touchedAt, authorLabel, boardIdFromSub, dataAgeLabel, deleteMessage, liveAction, parseFrameMessage, pickBoard, relativeTime, currentExpiryOption, expiryOptionLabel, isLocalHostname, shareExpiryLabel, shareLink } from "./quadroView";

const board = (id: string, title = id): Board => ({ id, title, description: "", createdBy: "clara", createdAt: "2026-11-16T10:00:00.000Z", pageUpdatedAt: "2026-11-16T10:00:00.000Z", dataUpdatedAt: "2026-11-16T10:00:00.000Z", pageBytes: 10, dataBytes: 10 });

describe("endereço do quadro", () => {
  it("lê o id da aba (com ou sem o resto) e ignora o que não é id", () => {
    expect(boardIdFromSub("Q-0003")).toBe("Q-0003");
    expect(boardIdFromSub("Q-0003/qualquer")).toBe("Q-0003");
    expect(boardIdFromSub("")).toBeNull();
    expect(boardIdFromSub("abc")).toBeNull();
    expect(boardIdFromSub("%E0%A4%A")).toBeNull();
  });

  it("abre o do endereço; sem ele (ou se sumiu), o primeiro da lista", () => {
    const list = [board("Q-0002"), board("Q-0001")];
    expect(pickBoard(list, "Q-0001")?.id).toBe("Q-0001");
    expect(pickBoard(list, null)?.id).toBe("Q-0002");
    expect(pickBoard(list, "Q-0009")?.id).toBe("Q-0002");
    expect(pickBoard([], "Q-0001")).toBeNull();
  });
});

describe("eventos na lista de abas", () => {
  const list = [board("Q-0002"), board("Q-0001")];

  it("quadro novo entra na frente", () => {
    const next = applyBoardEvent(list, { type: "board:upserted", board: board("Q-0003"), changed: ["meta", "page", "data"], created: true });
    expect(next.map((b) => b.id)).toEqual(["Q-0003", "Q-0002", "Q-0001"]);
  });

  it("quadro conhecido troca no lugar, sem pular de posição nem duplicar", () => {
    const next = applyBoardEvent(list, { type: "board:upserted", board: board("Q-0001", "Novo título"), changed: ["meta"] });
    expect(next.map((b) => b.id)).toEqual(["Q-0002", "Q-0001"]);
    expect(next[1]!.title).toBe("Novo título");
  });

  it("quadro apagado sai", () => {
    expect(applyBoardEvent(list, { type: "board:deleted", id: "Q-0002" }).map((b) => b.id)).toEqual(["Q-0001"]);
  });
});

describe("o que cada mudança faz no quadro aberto", () => {
  it("página recarrega tudo; só dados manda por postMessage; só detalhes não mexe", () => {
    expect(liveAction(["page"])).toBe("reload");
    expect(liveAction(["meta", "page", "data"])).toBe("reload");
    expect(liveAction(["data"])).toBe("data");
    expect(liveAction(["meta", "data"])).toBe("data");
    expect(liveAction(["meta"])).toBe("none");
    expect(liveAction([])).toBe("none");
  });
});

describe("mensagens do iframe", () => {
  it("entende ready, height e error", () => {
    expect(parseFrameMessage({ type: "quadro:ready" })).toEqual({ type: "ready" });
    expect(parseFrameMessage({ type: "quadro:height", height: 420 })).toEqual({ type: "height", height: 420 });
    expect(parseFrameMessage({ type: "quadro:error", message: "x is not defined" })).toEqual({ type: "error", message: "x is not defined" });
  });

  it("erro sem texto ganha uma mensagem padrão; o resto é ignorado", () => {
    expect(parseFrameMessage({ type: "quadro:error" })).toEqual({ type: "error", message: "A página do quadro falhou." });
    expect(parseFrameMessage({ type: "quadro:height", height: "alto" })).toBeNull();
    expect(parseFrameMessage({ type: "outra" })).toBeNull();
    expect(parseFrameMessage("quadro:ready")).toBeNull();
    expect(parseFrameMessage(null)).toBeNull();
  });
});

describe("tela inicial: busca, ordem e contagem", () => {
  const list: Board[] = [
    { ...board("Q-0001", "Concurso TRT"), description: "Datas e matérias" },
    { ...board("Q-0002", "Catálogo de obras"), description: "Capítulos lidos", dataUpdatedAt: "2026-11-16T12:00:00.000Z" },
    { ...board("Q-0003", "Ações da bolsa"), description: "Carteira e proventos", pageUpdatedAt: "2026-11-16T11:00:00.000Z" },
  ];

  it("busca sem acento e sem diferenciar maiúsculas, em título e descrição, com todas as palavras", () => {
    expect(normalizeText("  AÇÕES   da Bolsa ")).toBe("acoes da bolsa");
    expect(filterBoards(list, "acoes").map((b) => b.id)).toEqual(["Q-0003"]);
    expect(filterBoards(list, "CATALOGO").map((b) => b.id)).toEqual(["Q-0002"]);
    expect(filterBoards(list, "materias").map((b) => b.id)).toEqual(["Q-0001"]);
    expect(filterBoards(list, "carteira proventos").map((b) => b.id)).toEqual(["Q-0003"]);
    expect(filterBoards(list, "carteira obras")).toEqual([]);
    expect(filterBoards(list, "   ")).toHaveLength(3);
    expect(filterBoards(list, "zzz")).toEqual([]);
  });

  it("ordena por último mexido (padrão) ou por nome", () => {
    expect(sortBoards(list, "recentes").map((b) => b.id)).toEqual(["Q-0002", "Q-0003", "Q-0001"]);
    expect(sortBoards(list, "nome").map((b) => b.id)).toEqual(["Q-0003", "Q-0002", "Q-0001"]);
    expect(touchedAt(list[1]!)).toBe(Date.parse("2026-11-16T12:00:00.000Z"));
    // Não mexe na lista original.
    expect(list.map((b) => b.id)).toEqual(["Q-0001", "Q-0002", "Q-0003"]);
  });

  it("contagem, inicial e cor estável", () => {
    expect(boardCountLabel(1)).toBe("1 quadro");
    expect(boardCountLabel(12)).toBe("12 quadros");
    expect(initialOf("  ações")).toBe("A");
    expect(initialOf("???")).toBe("Q");
    expect(accentIndex("Q-0007")).toBe(accentIndex("Q-0007"));
    for (let i = 1; i < 40; i++) expect(accentIndex(`Q-${String(i).padStart(4, "0")}`)).toBeLessThan(8);
  });

  it("setas do seletor ficam dentro da lista", () => {
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });

  it("endereço: sem id é a tela inicial; id conhecido abre; id desconhecido é aviso", () => {
    expect(resolveRoute(list, null)).toEqual({ kind: "home" });
    expect(resolveRoute(list, "Q-0002")).toMatchObject({ kind: "board", board: { id: "Q-0002" } });
    expect(resolveRoute(list, "Q-0099")).toEqual({ kind: "missing", id: "Q-0099" });
    expect(resolveRoute([], "abc")).toEqual({ kind: "missing", id: "abc" });
  });
});

describe("textos", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("tempo relativo", () => {
    expect(relativeTime(ago(10_000), now)).toBe("agora");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("há 5 min");
    expect(relativeTime(ago(3 * 3600_000), now)).toBe("há 3 h");
    expect(relativeTime(ago(24 * 3600_000), now)).toBe("há 1 dia");
    expect(relativeTime(ago(4 * 86400_000), now)).toBe("há 4 dias");
    expect(relativeTime("lixo", now)).toBe("em data desconhecida");
    expect(dataAgeLabel({ dataUpdatedAt: ago(2 * 60_000) }, now)).toBe("Dados atualizados há 2 min");
  });

  it("quem fez", () => {
    const agents = [{ id: "clara", name: "Clara" }];
    expect(authorLabel("clara", agents)).toBe("Feito por Clara");
    expect(authorLabel("usuario", agents)).toBe("Feito por você");
    expect(authorLabel("sumiu", agents)).toBe("Feito por um agente");
  });

  it("o aviso de apagar diz o que se perde e não usa travessão nem seta", () => {
    const text = deleteMessage("Obras");
    expect(text).toContain("página e os dados");
    expect(text).not.toMatch(/[—→]/);
  });
});

describe("mensagem de exportação do iframe", () => {
  const base = { type: "quadro:export-result", requestId: "exp-1", format: "md" };
  it("aceita o resultado com texto e o erro", () => {
    expect(parseFrameMessage({ ...base, ok: true, text: "# Título" })).toEqual({ type: "export-result", result: { type: "quadro:export-result", requestId: "exp-1", format: "md", ok: true, text: "# Título" } });
    expect(parseFrameMessage({ ...base, format: "csv", ok: true, text: "" })).toMatchObject({ result: { ok: true, text: "" } });
    expect(parseFrameMessage({ ...base, ok: false, error: "  falhou  " })).toMatchObject({ result: { ok: false, error: "falhou" } });
    expect(parseFrameMessage({ ...base, ok: false })).toMatchObject({ result: { ok: false, error: "Não deu para exportar o quadro." } });
  });
  it("recusa campos inválidos", () => {
    expect(parseFrameMessage({ ...base, ok: true })).toBeNull();
    expect(parseFrameMessage({ ...base, ok: true, text: 5 })).toBeNull();
    expect(parseFrameMessage({ ...base, ok: "sim", text: "x" })).toBeNull();
    expect(parseFrameMessage({ ...base, requestId: "", ok: true, text: "x" })).toBeNull();
    expect(parseFrameMessage({ ...base, requestId: 3, ok: true, text: "x" })).toBeNull();
    expect(parseFrameMessage({ ...base, format: "pdf", ok: true, text: "x" })).toBeNull();
  });
});

describe("compartilhar por link", () => {
  it("reconhece endereços que só funcionam na rede local", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.20", "[::1]"]) expect(isLocalHostname(host)).toBe(true);
    for (const host of ["app.exemplo.com", "172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.0.1", "10.exemplo.com", ""]) expect(isLocalHostname(host)).toBe(false);
  });
  it("monta o link completo", () => {
    expect(shareLink("https://app.exemplo.com", "/api/share/abc")).toBe("https://app.exemplo.com/api/share/abc");
    expect(shareLink("https://app.exemplo.com/", "api/share/abc")).toBe("https://app.exemplo.com/api/share/abc");
  });
  it("rotula a validade", () => {
    expect(shareExpiryLabel({ shared: false })).toBe("Sem validade");
    expect(shareExpiryLabel({ shared: true, token: "t", path: "/p", createdAt: "2026-11-18T10:00:00.000Z" })).toBe("Sem validade");
    const expiresAt = new Date(2026, 10, 25, 14, 30).toISOString();
    expect(shareExpiryLabel({ shared: true, token: "t", path: "/p", createdAt: "2026-11-18T10:00:00.000Z", expiresAt })).toBe("Vale até 25/11/2026 às 14:30");
  });
  it("rotula as opções de validade", () => {
    expect([0, 1, 7, 30].map(expiryOptionLabel)).toEqual(["Sem validade", "1 dia", "7 dias", "30 dias"]);
  });
  it("marca no seletor a opção mais próxima da validade atual", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const share = (days: number) => ({ shared: true as const, token: "t", path: "/p", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() });
    expect(currentExpiryOption({ shared: false }, [0, 1, 7, 30], now)).toBe(0);
    expect(currentExpiryOption(share(7), [0, 1, 7, 30], now)).toBe(7);
    expect(currentExpiryOption(share(29.9), [0, 1, 7, 30], now)).toBe(30);
  });
  it("a confirmação de apagar avisa do link só quando há compartilhamento", () => {
    expect(deleteMessage("X")).not.toContain("link compartilhado");
    expect(deleteMessage("X", true)).toContain("O link compartilhado deste quadro para de funcionar.");
  });
});
