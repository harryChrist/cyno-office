import { describe, expect, it, vi } from "vitest";
import { compareOnGithub } from "./github";

const repo = { owner: "dono", repo: "repo" };
const page = (n: number, from: number) => ({
  status: "ahead",
  ahead_by: n,
  commits: Array.from({ length: Math.min(100, n - from) }, (_, i) => ({ sha: String(from + i).padStart(40, "0"), commit: { message: `c${from + i}`, committer: { date: "2026-01-01T00:00:00Z" } } })),
});

describe("compareOnGithub", () => {
  it("mais de 100 novidades: lê a última página para listar as mais novas", async () => {
    const fake = vi.fn(async (url: string | URL | Request) => {
      const pageNo = Number(new URL(String(url)).searchParams.get("page"));
      return new Response(JSON.stringify(page(130, (pageNo - 1) * 100)), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await compareOnGithub(repo, "a", "b", { fetch: fake });
    expect(result.ok && result.count).toBe(130);
    expect(result.ok && result.commits[0]?.subject).toBe("c129");
    expect(result.ok && result.commits).toHaveLength(20);
  });

  it("resposta sem status conhecido é inválida", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 })) as unknown as typeof fetch;
    expect(await compareOnGithub(repo, "a", "b", { fetch: fake })).toEqual({ ok: false, reason: "invalid" });
  });

  it("404, 403 e 429", async () => {
    for (const [status, reason] of [[404, "not-found"], [403, "rate-limit"], [429, "rate-limit"], [500, "network"]] as const) {
      const fake = vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
      expect(await compareOnGithub(repo, "a", "b", { fetch: fake })).toEqual({ ok: false, reason });
    }
  });
});
