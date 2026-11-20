import type { EngineStorageCleanupResult, EngineStoragePreview, EngineStorageUsage } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineStorageSettings } from "./EngineStorageSettings";
import { anyCleanupOn, cleanupResultText, dayChoices, daysLabel, engineRows, itemText, lastCleanupText, oldestText, previewLines, removalText, removalTotal } from "./engineStorageView";

const item = (bytes: number, files: number, oldestAt: string | null = null) => ({ bytes, files, oldestAt });
const usage: EngineStorageUsage = {
  claude: item(2048, 3, "2026-11-01T10:00:00.000Z"),
  antigravity: { logs: item(1024 * 1024, 8, "2026-10-01T10:00:00.000Z"), conversations: item(5 * 1024 * 1024, 2, "2026-09-01T10:00:00.000Z") },
  freebuff: { chats: item(512, 1) },
  hermes: { total: item(10_000, 30), cache: item(4000, 10) },
  openclaw: item(0, 0),
};

describe("engineStorageView", () => {
  it("rótulos e opções de dias: tudo começa em Nunca e só entram as opções da API", () => {
    expect(daysLabel(0)).toBe("Nunca");
    expect(daysLabel(30)).toBe("30 dias");
    expect(dayChoices(0)).toEqual([
      { value: 0, label: "Nunca" },
      { value: 7, label: "7 dias" },
      { value: 14, label: "14 dias" },
      { value: 30, label: "30 dias" },
      { value: 90, label: "90 dias" },
    ]);
    // Um valor fora da lista (arquivo editado à mão) continua aparecendo, sem sumir do seletor.
    expect(dayChoices(5).map((choice) => choice.value)).toEqual([0, 7, 14, 30, 90, 5]);
  });

  it("tamanho e quantidade em pt-BR, com a data do mais antigo quando há", () => {
    expect(itemText(item(1024 * 1024, 1))).toBe("1 MB · 1 arquivo");
    expect(itemText(item(0, 0))).toBe("0 B · 0 arquivos");
    expect(oldestText(item(1, 1, null))).toBeNull();
    expect(oldestText(item(1, 1, "2026-11-01T15:00:00.000Z"))).toMatch(/^Mais antigo: 01\/11/);
  });

  it("uma linha por motor, na ordem; Claude é gerenciado em Histórico; o Antigravity tem logs (com seletor) e conversas (só informativo)", () => {
    const rows = engineRows(usage);
    expect(rows.map((row) => row.id)).toEqual(["claude", "antigravity", "freebuff", "hermes", "openclaw"]);
    expect(rows[0]!.items[0]).toMatchObject({ note: "Gerenciado em Histórico" });
    expect(rows[0]!.items[0]!.setting).toBeUndefined();
    expect(rows[1]!.items.map((entry) => [entry.label, entry.setting])).toEqual([
      ["Logs", "antigravityLogsDays"],
      ["Conversas", undefined],
    ]);
    expect(rows[1]!.items[1]!.note).toBe("Sem limpeza oficial do motor; inclui as suas conversas");
    expect(rows[1]!.total).toEqual(item(6 * 1024 * 1024, 10, "2026-09-01T10:00:00.000Z"));
    expect(rows[2]!.items.map((entry) => [entry.label, entry.setting])).toEqual([["Chats dos agentes", "freebuffChatsDays"]]);
    expect(rows[3]!.items.map((entry) => [entry.label, entry.usage.bytes])).toEqual([
      ["Cache", 4000],
      ["Ambiente instalado", 6000],
    ]);
    expect(rows[3]!.items[0]!.note).toBe("O motor cuida do próprio histórico");
    expect(rows[3]!.items[1]!.note).toBe("Ambiente instalado");
    expect(rows[4]!.items[0]!.note).toBe("O motor cuida do próprio histórico");
    // Só Antigravity (logs) e Freebuff têm seletor: o resto é só medido.
    expect(rows.flatMap((row) => row.items).filter((entry) => entry.setting).map((entry) => entry.id)).toEqual(["antigravity-logs", "freebuff-chats"]);
  });

  it("nenhum texto da tela usa travessão longo nem seta", () => {
    const texts = [...engineRows(usage).flatMap((row) => row.items.flatMap((entry) => [entry.label, entry.note])), daysLabel(7), lastCleanupText(null), cleanupResultText(cleanupResult(0, 0, 0, 0))];
    for (const text of texts) expect(text).not.toMatch(/[—→←⇒]/);
  });

  it("pré-visualização: só as linhas que apagam algo, o total e o resultado", () => {
    const preview: EngineStoragePreview = { antigravityLogs: { files: 2, bytes: 2048 }, freebuffChats: { files: 0, bytes: 0 } };
    expect(previewLines(preview)).toEqual([{ label: "Logs do Antigravity", text: "2 arquivos, 2 KB" }]);
    expect(previewLines({ antigravityLogs: { files: 0, bytes: 0 }, freebuffChats: { files: 1, bytes: 1024 * 1024 } })).toEqual([{ label: "Chats dos agentes no Freebuff", text: "1 arquivo, 1 MB" }]);
    expect(previewLines({ antigravityLogs: { files: 0, bytes: 0 }, freebuffChats: { files: 0, bytes: 0 } })).toEqual([]);
    expect(removalTotal({ antigravityLogs: { files: 2, bytes: 100 }, freebuffChats: { files: 3, bytes: 50 } })).toEqual({ files: 5, bytes: 150 });
    expect(removalText({ files: 1, bytes: 512 })).toBe("1 arquivo, 512 B");
    expect(cleanupResultText(cleanupResult(0, 0, 0, 0))).toBe("Nada para apagar.");
    expect(cleanupResultText(cleanupResult(1, 1024, 2, 1024))).toBe("3 arquivos apagados, 2 KB liberados.");
  });

  it("última limpeza em uma linha e 'tem algo ligado?'", () => {
    expect(lastCleanupText(null)).toBe("Nenhuma limpeza ainda.");
    expect(lastCleanupText(cleanupResult(0, 0, 0, 0))).toMatch(/^Última limpeza: .* · nada para apagar$/);
    expect(lastCleanupText(cleanupResult(1, 1024, 0, 0))).toMatch(/1 arquivo apagado \(1 KB\)$/);
    expect(anyCleanupOn({ antigravityLogsDays: 0, freebuffChatsDays: 0 })).toBe(false);
    expect(anyCleanupOn({ antigravityLogsDays: 0, freebuffChatsDays: 7 })).toBe(true);
  });

  it("o componente nasce no estado de carregando, sem quebrar", () => {
    const html = renderToStaticMarkup(createElement(EngineStorageSettings));
    expect(html).toContain("Medindo o que cada motor guarda");
  });
});

function cleanupResult(logsFiles: number, logsBytes: number, chatsFiles: number, chatsBytes: number): EngineStorageCleanupResult {
  return { at: "2026-11-20T12:00:00.000Z", antigravityLogs: { files: logsFiles, bytes: logsBytes }, freebuffChats: { files: chatsFiles, bytes: chatsBytes } };
}
