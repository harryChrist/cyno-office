import { describe, expect, it } from "vitest";
import { runUploadQueue, uploadSkipReason, uploadSummaryText, type ReplaceChoice, type UploadProgress } from "./uploadQueue";

const file = (name: string, size = 10) => ({ name, size });
const conflict = () => Object.assign(new Error("Já existe"), { status: 409 });

function setup(sendImpl: (name: string, overwrite: boolean) => Promise<void> | void, answers: ReplaceChoice[] = []) {
  const log: string[] = [];
  const asked: string[] = [];
  const progress: UploadProgress[] = [];
  const controller = new AbortController();
  const deps = {
    send: async (item: { name: string }, overwrite: boolean) => {
      log.push(`${item.name}${overwrite ? "!" : ""}`);
      await sendImpl(item.name, overwrite);
    },
    askReplace: async (name: string) => {
      asked.push(name);
      return answers.shift() ?? { action: "skip" as const, all: false };
    },
    onProgress: (p: UploadProgress) => progress.push(p),
  };
  return { log, asked, progress, controller, deps };
}

describe("uploadSkipReason", () => {
  it("pula nome inválido, trancado e arquivo grande demais", () => {
    expect(uploadSkipReason(file("ok.txt"))).toBeNull();
    expect(uploadSkipReason(file(".env"))).toMatch(/protegido/);
    expect(uploadSkipReason(file("a/b.txt"))).toMatch(/barra/);
    expect(uploadSkipReason(file("enorme.bin", 2 * 1024 * 1024 * 1024 + 1))).toBe("Passa de 2 GB.");
    expect(uploadSkipReason(file("limite.bin", 2 * 1024 * 1024 * 1024))).toBeNull();
  });
});

describe("runUploadQueue", () => {
  it("envia um por vez, na ordem, e conta o progresso entre os válidos", async () => {
    const s = setup(() => undefined);
    const summary = await runUploadQueue([file("a"), file(".env"), file("b")], s.deps, s.controller.signal);
    expect(s.log).toEqual(["a", "b"]);
    expect(summary).toMatchObject({ sent: 2, cancelled: false });
    expect(summary.skipped).toEqual([{ name: ".env", reason: expect.stringMatching(/protegido/) }]);
    expect(s.progress.map((p) => `${p.index}/${p.total}`)).toEqual(["1/2", "2/2"]);
    expect(uploadSummaryText(summary)).toBe("2 arquivos enviados, 1 pulado");
  });

  it("um erro não para os outros", async () => {
    const s = setup((name) => {
      if (name === "b") throw new Error("Sem espaço");
    });
    const summary = await runUploadQueue([file("a"), file("b"), file("c")], s.deps, s.controller.signal);
    expect(s.log).toEqual(["a", "b", "c"]);
    expect(summary.failed).toEqual([{ name: "b", message: "Sem espaço" }]);
    expect(summary.sent).toBe(2);
  });

  it("409: substituir manda de novo por cima; pular não manda", async () => {
    const s = setup((name, overwrite) => {
      if (!overwrite) throw conflict();
      void name;
    }, [{ action: "replace", all: false }, { action: "skip", all: false }]);
    const summary = await runUploadQueue([file("a"), file("b")], s.deps, s.controller.signal);
    expect(s.log).toEqual(["a", "a!", "b"]);
    expect(s.asked).toEqual(["a", "b"]);
    expect(summary.sent).toBe(1);
    expect(summary.skipped).toEqual([{ name: "b", reason: "Já existe um arquivo com esse nome." }]);
  });

  it("'fazer o mesmo para os próximos' não pergunta de novo (substituir)", async () => {
    const s = setup((_name, overwrite) => {
      if (!overwrite) throw conflict();
    }, [{ action: "replace", all: true }]);
    const summary = await runUploadQueue([file("a"), file("b"), file("c")], s.deps, s.controller.signal);
    expect(s.asked).toEqual(["a"]);
    expect(s.log).toEqual(["a", "a!", "b", "b!", "c", "c!"]);
    expect(summary.sent).toBe(3);
  });

  it("'fazer o mesmo para os próximos' com pular", async () => {
    const s = setup((_name, overwrite) => {
      if (!overwrite) throw conflict();
    }, [{ action: "skip", all: true }]);
    const summary = await runUploadQueue([file("a"), file("b")], s.deps, s.controller.signal);
    expect(s.asked).toEqual(["a"]);
    expect(summary.skipped.map((item) => item.name)).toEqual(["a", "b"]);
    expect(summary.sent).toBe(0);
  });

  it("cancelar para o atual e não começa o resto", async () => {
    const s = setup(async (name) => {
      if (name === "a") {
        s.controller.abort();
        throw new DOMException("Envio cancelado", "AbortError");
      }
    });
    const summary = await runUploadQueue([file("a"), file("b")], s.deps, s.controller.signal);
    expect(s.log).toEqual(["a"]);
    expect(summary.cancelled).toBe(true);
    expect(summary.failed).toEqual([]);
    expect(uploadSummaryText(summary)).toBe("Envio cancelado");
  });

  it("cancelar durante a pergunta de substituir termina a fila", async () => {
    const s = setup((_name, overwrite) => {
      if (!overwrite) throw conflict();
    });
    s.deps.askReplace = async () => {
      s.controller.abort();
      return { action: "skip", all: true };
    };
    const summary = await runUploadQueue([file("a"), file("b")], s.deps, s.controller.signal);
    expect(s.log).toEqual(["a"]);
    expect(summary.cancelled).toBe(true);
  });

  it("textos do resumo", () => {
    expect(uploadSummaryText({ sent: 5, skipped: [], failed: [], cancelled: false })).toBe("5 arquivos enviados");
    expect(uploadSummaryText({ sent: 1, skipped: [], failed: [], cancelled: false })).toBe("1 arquivo enviado");
    expect(uploadSummaryText({ sent: 2, skipped: [], failed: [{ name: "x", message: "m" }], cancelled: true })).toBe("2 arquivos enviados, o resto foi cancelado, 1 com erro");
  });
});
