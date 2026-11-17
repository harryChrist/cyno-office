import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiskMeter, ERROR_RETRY_MS, measureTree, sizeOnDisk } from "./disk-meter";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cyno-meter-"));
});
afterEach(async () => {
  await chmod(path.join(dir, "fechada"), 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const fill = async (file: string, size: number) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
};

describe("sizeOnDisk", () => {
  it("usa blocos de 512 bytes quando há; senão o tamanho", () => {
    expect(sizeOnDisk({ size: 10, blocks: 8 })).toBe(4096);
    expect(sizeOnDisk({ size: 10 })).toBe(10);
    expect(sizeOnDisk({ size: 10, blocks: 0 })).toBe(10);
  });
});

describe("measureTree", () => {
  it("soma subpastas, conta arquivos e divide por entrada de primeiro nível", async () => {
    await fill(path.join(dir, "a", "um.bin"), 50_000);
    await fill(path.join(dir, "a", "fundo", "dois.bin"), 30_000);
    await fill(path.join(dir, "b", "tres.bin"), 10_000);
    await fill(path.join(dir, "solto.txt"), 100);
    const result = await measureTree(dir, 2);
    expect(result.files).toBe(4);
    expect(Object.keys(result.byTop).sort()).toEqual(["a", "b", "solto.txt"]);
    expect(result.byTop.a).toBeGreaterThanOrEqual(80_000);
    expect(result.byTop.b).toBeGreaterThanOrEqual(10_000);
    expect(result.bytes).toBeGreaterThanOrEqual(90_100);
  });

  it("não segue link simbólico (nem para fora nem em ciclo)", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "cyno-meter-out-"));
    try {
      await fill(path.join(outside, "enorme.bin"), 2_000_000);
      await fill(path.join(dir, "real.bin"), 1_000);
      await symlink(outside, path.join(dir, "link-pasta"));
      await symlink(dir, path.join(dir, "ciclo"));
      const result = await measureTree(dir);
      expect(result.bytes).toBeLessThan(200_000);
      expect(result.files).toBe(3); // real.bin e os dois links (contados como o próprio link)
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("ignora pasta sem permissão e falha só se a raiz não abre", async () => {
    await fill(path.join(dir, "ok.bin"), 5_000);
    await fill(path.join(dir, "fechada", "secreto.bin"), 900_000);
    await chmod(path.join(dir, "fechada"), 0o000);
    const result = await measureTree(dir);
    if (process.getuid?.() !== 0) expect(result.bytes).toBeLessThan(900_000);
    expect(result.bytes).toBeGreaterThanOrEqual(5_000);
    await expect(measureTree(path.join(dir, "nao-existe"))).rejects.toThrow();
  });
});

describe("DiskMeter", () => {
  it("responde na hora 'computing', depois 'ready'; não mede sem ser pedido", async () => {
    await fill(path.join(dir, "x.bin"), 20_000);
    const measure = vi.fn(measureTree);
    const meter = new DiskMeter({}, measure);
    expect(measure).not.toHaveBeenCalled();
    expect(meter.get(dir).state).toBe("computing");
    const done = await meter.settled(dir);
    expect(done).toMatchObject({ state: "ready", files: 1 });
    expect(done.bytes).toBeGreaterThanOrEqual(20_000);
    expect(done.computedAt).not.toBeNull();
    expect(meter.get(dir).state).toBe("ready");
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("cache vale até o prazo e depois remede; refresh recalcula na hora", async () => {
    let clock = 1_000;
    let size = 100;
    const measure = vi.fn(async () => ({ bytes: size, files: 1, byTop: {} }));
    const meter = new DiskMeter({ ttlMs: 10_000, now: () => clock }, measure);
    meter.get("/p");
    await meter.settled("/p");
    size = 200;
    clock += 5_000;
    expect(meter.get("/p").bytes).toBe(100);
    expect(measure).toHaveBeenCalledTimes(1);
    clock += 6_000;
    const stale = meter.get("/p");
    expect(stale).toMatchObject({ state: "computing", bytes: 100 }); // mostra o antigo enquanto remede
    expect((await meter.settled("/p")).bytes).toBe(200);
    size = 300;
    const fresh = await meter.refresh("/p");
    expect(fresh.bytes).toBe(300);
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("pedidos simultâneos do mesmo caminho reaproveitam a medição em andamento", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const measure = vi.fn(async () => {
      await gate;
      return { bytes: 7, files: 1, byTop: {} };
    });
    const meter = new DiskMeter({}, measure);
    meter.get("/p");
    meter.get("/p");
    const refreshing = meter.refresh("/p");
    release();
    expect((await refreshing).bytes).toBe(7);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("limita a concorrência total", async () => {
    let running = 0;
    let peak = 0;
    const measure = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return { bytes: 1, files: 1, byTop: {} };
    });
    const meter = new DiskMeter({ concurrency: 2 }, measure);
    await Promise.all(["/a", "/b", "/c", "/d", "/e"].map((p) => meter.refresh(p)));
    expect(peak).toBe(2);
    expect(measure).toHaveBeenCalledTimes(5);
  });

  it("pasta que não abre vira 'error', sem remedir a cada consulta, e tenta de novo depois do prazo", async () => {
    let clock = 0;
    const missing = path.join(dir, "nao-existe");
    const measure = vi.fn(measureTree);
    const meter = new DiskMeter({ now: () => clock }, measure);
    meter.get(missing);
    expect((await meter.settled(missing)).state).toBe("error");
    expect(meter.get(missing).state).toBe("error");
    expect(meter.get(missing).state).toBe("error");
    expect(measure).toHaveBeenCalledTimes(1);
    await fill(path.join(missing, "a.bin"), 10);
    clock += ERROR_RETRY_MS + 1;
    meter.get(missing);
    expect((await meter.settled(missing)).state).toBe("ready");
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("não trava o laço de eventos numa pasta grande", async () => {
    for (let i = 0; i < 600; i++) await fill(path.join(dir, `d${i % 20}`, `f${i}.txt`), 1);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    await measureTree(dir, 50);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});
