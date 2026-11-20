import { emptyAvulsas, projectDefaults, type AvulsasCleanupPreview, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  archiveOptionLabel,
  canConfirmCleanup,
  canDeleteAvulsaTask,
  CLEANUP_AGES,
  cleanupConfirmLabel,
  cleanupCountText,
  cleanupResultText,
  cleanupTotal,
  DEFAULT_CLEANUP_DAYS,
  isTerminated,
  oldestText,
  type CleanupPreviewState,
} from "./avulsasCleanupView";

const AT = "2026-11-10T12:00:00.000Z";
const ready = (preview: Partial<AvulsasCleanupPreview> = {}): CleanupPreviewState => ({ status: "ready", preview: { count: 0, archivedCount: 0, ...preview } });
const task = (extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ref: "A1",
  title: "Pedido",
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "concluida",
  updatedAt: AT,
  ...extra,
});
const common = (): Project => ({ ...projectDefaults(), id: "p1", title: "Campanha", status: "ativo", version: 1, tasks: [], createdAt: AT, updatedAt: AT });

describe("as idades do diálogo", () => {
  it("padrão: mais de 30 dias; todas as terminadas é 0", () => {
    expect(DEFAULT_CLEANUP_DAYS).toBe(30);
    expect(CLEANUP_AGES.map((age) => age.days)).toEqual([0, 7, 30, 90]);
    expect(CLEANUP_AGES.map((age) => age.label)).toEqual(["Todas as terminadas", "Mais de 7 dias", "Mais de 30 dias", "Mais de 90 dias"]);
    expect(CLEANUP_AGES.some((age) => age.days === DEFAULT_CLEANUP_DAYS)).toBe(true);
  });
});

describe("a contagem ao vivo", () => {
  it("diz quantas serão apagadas, no singular e no plural", () => {
    expect(cleanupCountText(ready({ count: 58 }), false)).toBe("58 tarefas terminadas serão apagadas");
    expect(cleanupCountText(ready({ count: 1 }), false)).toBe("1 tarefa terminada será apagada");
  });

  it("sem nada para apagar", () => {
    expect(cleanupCountText(ready(), false)).toBe("Nada para apagar");
    // as do arquivo só contam quando a opção está ligada
    expect(cleanupCountText(ready({ archivedCount: 4 }), false)).toBe("Nada para apagar");
  });

  it("soma as do arquivo só com a opção ligada", () => {
    expect(cleanupCountText(ready({ count: 58, archivedCount: 4 }), false)).toBe("58 tarefas terminadas serão apagadas");
    expect(cleanupCountText(ready({ count: 58, archivedCount: 4 }), true)).toBe("58 tarefas terminadas e 4 do arquivo serão apagadas");
    expect(cleanupCountText(ready({ archivedCount: 4 }), true)).toBe("4 tarefas do arquivo serão apagadas");
    expect(cleanupCountText(ready({ archivedCount: 1 }), true)).toBe("1 tarefa do arquivo será apagada");
  });

  it("carregando e erro", () => {
    expect(cleanupCountText({ status: "loading" }, false)).toBe("Contando…");
    expect(cleanupCountText({ status: "error", message: "Não foi possível falar com o servidor." }, false)).toBe("Não foi possível falar com o servidor.");
  });

  it("total", () => {
    expect(cleanupTotal({ count: 58, archivedCount: 4 }, false)).toBe(58);
    expect(cleanupTotal({ count: 58, archivedCount: 4 }, true)).toBe(62);
  });
});

describe("a opção do arquivo e a mais antiga", () => {
  it("a opção só existe quando há arquivadas", () => {
    expect(archiveOptionLabel(null)).toBeNull();
    expect(archiveOptionLabel({ count: 3, archivedCount: 0 })).toBeNull();
    expect(archiveOptionLabel({ count: 3, archivedCount: 12 })).toBe("Apagar também as do arquivo (12)");
  });

  it("a mais antiga aparece com a data de Brasília e some sem nada para apagar", () => {
    expect(oldestText({ count: 2, archivedCount: 0, oldestAt: "2026-10-12T17:00:00.000Z" })).toBe("A mais antiga é de 12/10/2026 14:00.");
    expect(oldestText({ count: 0, archivedCount: 0, oldestAt: "2026-10-12T17:00:00.000Z" })).toBeNull();
    expect(oldestText({ count: 2, archivedCount: 0 })).toBeNull();
    expect(oldestText(null)).toBeNull();
  });
});

describe("habilitar o botão final", () => {
  it("só com a contagem pronta, algo para apagar e sem pedido em curso", () => {
    expect(canConfirmCleanup(ready({ count: 5 }), false, false)).toBe(true);
    expect(canConfirmCleanup(ready({ count: 5 }), false, true)).toBe(false);
    expect(canConfirmCleanup(ready(), false, false)).toBe(false);
    expect(canConfirmCleanup({ status: "loading" }, false, false)).toBe(false);
    expect(canConfirmCleanup({ status: "error", message: "x" }, false, false)).toBe(false);
  });

  it("só as do arquivo habilitam quando a opção está ligada", () => {
    expect(canConfirmCleanup(ready({ archivedCount: 3 }), false, false)).toBe(false);
    expect(canConfirmCleanup(ready({ archivedCount: 3 }), true, false)).toBe(true);
  });

  it("o rótulo do botão leva o total", () => {
    expect(cleanupConfirmLabel(ready({ count: 58 }), false)).toBe("Apagar 58 tarefas");
    expect(cleanupConfirmLabel(ready({ count: 1 }), false)).toBe("Apagar 1 tarefa");
    expect(cleanupConfirmLabel(ready({ count: 58, archivedCount: 4 }), true)).toBe("Apagar 62 tarefas");
    expect(cleanupConfirmLabel(ready(), false)).toBe("Apagar tarefas");
    expect(cleanupConfirmLabel({ status: "loading" }, false)).toBe("Apagar tarefas");
  });
});

describe("o resultado", () => {
  it("conta o que foi apagado", () => {
    expect(cleanupResultText({ deleted: 58, archivedDeleted: 0 })).toBe("58 tarefas apagadas");
    expect(cleanupResultText({ deleted: 1, archivedDeleted: 0 })).toBe("1 tarefa apagada");
    expect(cleanupResultText({ deleted: 58, archivedDeleted: 4 })).toBe("62 tarefas apagadas (4 do arquivo)");
    expect(cleanupResultText({ deleted: 0, archivedDeleted: 0 })).toBe("Nada foi apagado");
  });
});

describe("apagar uma folha", () => {
  it("terminada: concluída, cancelada ou falhou", () => {
    expect(isTerminated(task({ status: "concluida" }))).toBe(true);
    expect(isTerminated(task({ status: "cancelada" }))).toBe(true);
    expect(isTerminated(task({ status: "falhou" }))).toBe(true);
    expect(isTerminated(task({ status: "a_fazer" }))).toBe(false);
    expect(isTerminated(task({ status: "em_andamento" }))).toBe(false);
    expect(isTerminated(task({ status: "esperando_voce" }))).toBe(false);
    expect(isTerminated(task({ status: "backlog" }))).toBe(false);
  });

  it("só a folha terminada do Avulsas pode ser apagada", () => {
    const avulsas = emptyAvulsas(AT);
    expect(canDeleteAvulsaTask(avulsas, task())).toBe(true);
    expect(canDeleteAvulsaTask(avulsas, task({ status: "falhou" }))).toBe(true);
    expect(canDeleteAvulsaTask(avulsas, task({ status: "a_fazer" }))).toBe(false);
    expect(canDeleteAvulsaTask(avulsas, task({ archived: true }))).toBe(false);
    expect(canDeleteAvulsaTask(avulsas, task({ group: true }))).toBe(false);
    // projeto comum: o botão não aparece (a tarefa de projeto só se arquiva)
    expect(canDeleteAvulsaTask(common(), task())).toBe(false);
  });
});
