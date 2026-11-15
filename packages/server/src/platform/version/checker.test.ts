import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANUAL_COOLDOWN_MS, UpdateChecker, updateConfigFromEnv } from "./checker";
import { readLocalVersion } from "./local";
import { commit, git, makeFixture, pushFromOther, tempDir, type Fixture } from "./test-repo";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const noNetwork = (() => {
  throw new Error("o teste não pode acessar a rede");
}) as unknown as typeof fetch;

function checkerFor(root: string, options: { branch?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  return new UpdateChecker({
    local: () => readLocalVersion(root),
    config: { auto: true, branch: options.branch ?? "main" },
    fetch: options.fetch ?? noNetwork,
    ...(options.now ? { now: options.now } : {}),
    lsRemoteTimeoutMs: 15_000,
  });
}

describe("verificação de atualização (git de verdade, em repositórios temporários)", () => {
  it("em dia: o HEAD é o commit do origin", async () => {
    fixture = makeFixture();
    const state = await checkerFor(fixture.clone).check();
    expect(state.status).toBe("up-to-date");
    expect(state.remote?.hash).toBe(git(fixture.clone, "rev-parse", "HEAD"));
    expect(state.checkedAt).not.toBeNull();
    expect(state.commits).toBeNull();
  });

  it("clone atrás do origin, com os objetos locais: lista os commits novos", async () => {
    fixture = makeFixture();
    const remote = pushFromOther(fixture, ["novo um", "novo dois", "novo três"]);
    // objetos já locais (alguém deu fetch)
    git(fixture.clone, "fetch", "origin");
    const state = await checkerFor(fixture.clone).check();
    expect(state.status).toBe("update-available");
    expect(state.remote?.hash).toBe(remote);
    expect(state.count).toBe(3);
    expect(state.commits?.map((item) => item.subject)).toEqual(["novo três", "novo dois", "novo um"]);
    expect(state.commits?.[0]?.date).toMatch(/^\d{4}-/);
    expect(state.commitsUrl).toBeNull(); // origin local: sem link do GitHub
    expect(git(fixture.clone, "rev-parse", "origin/main")).toBe(remote);
  });

  it("não faz fetch: o clone continua sem os objetos novos depois de verificar", async () => {
    fixture = makeFixture();
    const remote = pushFromOther(fixture, ["novo"]);
    const state = await checkerFor(fixture.clone).check();
    expect(state.status).toBe("update-available");
    expect(state.commits).toBeNull(); // sem objetos e sem API (origin não é do GitHub): lista indisponível
    expect(state.count).toBeNull();
    expect(() => git(fixture!.clone, "cat-file", "-e", `${remote}^{commit}`)).toThrow();
  });

  it("HEAD à frente do origin (dev à frente do main) conta como em dia", async () => {
    fixture = makeFixture();
    commit(fixture.clone, "dev.txt", "só no dev");
    const state = await checkerFor(fixture.clone).check();
    expect(state.status).toBe("up-to-date");
  });

  it("outro ramo pelo CYNO_UPDATE_BRANCH; ramo que não existe vira indisponível", async () => {
    fixture = makeFixture();
    expect((await checkerFor(fixture.clone, { branch: "estavel" }).check()).status).toBe("unavailable");
    git(fixture.clone, "push", "origin", "main:estavel");
    expect((await checkerFor(fixture.clone, { branch: "estavel" }).check()).status).toBe("up-to-date");
    const missing = await checkerFor(fixture.clone, { branch: "nao-existe" }).check();
    expect(missing.reason).toContain("nao-existe");
  });

  it("origin inalcançável: não foi possível verificar, sem lançar erro", async () => {
    fixture = makeFixture();
    git(fixture.clone, "remote", "set-url", "origin", path.join(fixture.base, "nao-existe.git"));
    const state = await checkerFor(fixture.clone).check();
    expect(state.status).toBe("unavailable");
    expect(state.reason).toBeTruthy();
    expect(state.checkedAt).not.toBeNull();
  });

  it("sem .git nem version.json: indisponível com motivo", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const state = await checkerFor(dir).check();
    expect(state.status).toBe("unavailable");
    expect(state.reason).toMatch(/commit/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("clique manual repetido devolve o último resultado dentro do intervalo", async () => {
    fixture = makeFixture();
    let clock = 1_000_000;
    const checker = checkerFor(fixture.clone, { now: () => clock });
    const first = await checker.check({ manual: true });
    pushFromOther(fixture, ["novo"]);
    const second = await checker.check({ manual: true });
    expect(second.status).toBe("up-to-date");
    expect(second.checkedAt).toBe(first.checkedAt);
    clock += MANUAL_COOLDOWN_MS + 1;
    expect((await checker.check({ manual: true })).status).toBe("update-available");
  });

  it("verificações simultâneas viram uma só", async () => {
    fixture = makeFixture();
    const checker = checkerFor(fixture.clone);
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(a).toEqual(b);
  });
});

describe("com o origin do GitHub e a API (fetch falso)", () => {
  /** Clone cujo origin diz ser do GitHub, mas o ls-remote lê o bare local pelo insteadOf. */
  function githubLike(): Fixture {
    const made = makeFixture();
    git(made.clone, "remote", "set-url", "origin", "git@github.com:dono/repo.git");
    git(made.clone, "config", `url.${made.origin}.insteadOf`, "git@github.com:dono/repo.git");
    return made;
  }
  const apiBody = (hashes: string[], extra: Record<string, unknown> = {}) => ({
    status: "ahead",
    ahead_by: hashes.length,
    total_commits: hashes.length,
    commits: hashes.map((sha, index) => ({ sha, commit: { message: `novidade ${index}\n\ncorpo`, committer: { date: `2026-11-0${index + 1}T10:00:00Z` } } })),
    ...extra,
  });

  it("sucesso: lista (mais novo primeiro), contagem e link dos commits", async () => {
    fixture = githubLike();
    const head = git(fixture.clone, "rev-parse", "HEAD");
    const remote = pushFromOther(fixture, ["a", "b"]);
    const hashes = ["1".repeat(40), "2".repeat(40)];
    const calls: string[] = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toMatch(/authorization|token|cookie/);
      return new Response(JSON.stringify(apiBody(hashes)), { status: 200 });
    }) as unknown as typeof fetch;
    const state = await checkerFor(fixture.clone, { fetch: fake }).check();
    expect(calls[0]).toMatch(new RegExp(`^https://api\\.github\\.com/repos/dono/repo/compare/${head}\\.\\.\\.${remote}`));
    expect(state.status).toBe("update-available");
    expect(state.count).toBe(2);
    expect(state.commits?.map((item) => item.subject)).toEqual(["novidade 1", "novidade 0"]);
    expect(state.commitsUrl).toBe(`https://github.com/dono/repo/compare/${head}...${remote}`);
  });

  it("404 (repositório privado): atualização sem lista, sem erro", async () => {
    fixture = githubLike();
    pushFromOther(fixture, ["a"]);
    const fake = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const state = await checkerFor(fixture.clone, { fetch: fake }).check();
    expect(state.status).toBe("update-available");
    expect(state.commits).toBeNull();
    expect(state.count).toBeNull();
    expect(state.reason).toBeNull();
  });

  it("limite de uso (403) e falha de rede: também só sem lista", async () => {
    fixture = githubLike();
    pushFromOther(fixture, ["a"]);
    const limited = vi.fn(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    expect((await checkerFor(fixture.clone, { fetch: limited }).check()).commits).toBeNull();
    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const state = await checkerFor(fixture.clone, { fetch: broken }).check();
    expect(state.status).toBe("update-available");
    expect(state.commits).toBeNull();
  });

  it("a API diz que o commit do origin já está contido (behind): em dia", async () => {
    fixture = githubLike();
    pushFromOther(fixture, ["a"]);
    const fake = vi.fn(async () => new Response(JSON.stringify(apiBody([], { status: "behind", ahead_by: 0 })), { status: 200 })) as unknown as typeof fetch;
    expect((await checkerFor(fixture.clone, { fetch: fake }).check()).status).toBe("up-to-date");
  });

  it("sem repositório local (Docker): usa o version.json e a API; sem a API, não dá para comparar", async () => {
    fixture = githubLike();
    const head = git(fixture.clone, "rev-parse", "HEAD");
    const remote = pushFromOther(fixture, ["a"]);
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    // ls-remote por https do GitHub é desviado para o bare local pelo insteadOf global do ambiente do teste
    const gitConfig = path.join(dir, "gitconfig");
    writeFileSync(gitConfig, `[url "${fixture.origin}"]\n\tinsteadOf = https://github.com/dono/repo.git\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
    writeFileSync(path.join(dir, "version.json"), JSON.stringify({ commit: head, date: "", subject: "x", branch: "main", count: 2, dirty: false, origin: "git@github.com:dono/repo.git" }));
    const ok = vi.fn(async () => new Response(JSON.stringify(apiBody(["3".repeat(40)])), { status: 200 })) as unknown as typeof fetch;
    const found = await checkerFor(dir, { fetch: ok }).check();
    expect(found.status).toBe("update-available");
    expect(found.remote?.hash).toBe(remote);
    const denied = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect((await checkerFor(dir, { fetch: denied }).check()).status).toBe("unavailable");
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("updateConfigFromEnv", () => {
  it("padrão: automática ligada, ramo main", () => {
    expect(updateConfigFromEnv({})).toEqual({ auto: true, branch: "main" });
  });
  it("off e 0 desligam; ramo trocado; ramo estranho volta ao main", () => {
    expect(updateConfigFromEnv({ CYNO_UPDATE_CHECK: "off" }).auto).toBe(false);
    expect(updateConfigFromEnv({ CYNO_UPDATE_CHECK: "0" }).auto).toBe(false);
    expect(updateConfigFromEnv({ CYNO_UPDATE_BRANCH: "release/1.x" }).branch).toBe("release/1.x");
    expect(updateConfigFromEnv({ CYNO_UPDATE_BRANCH: "--upload-pack=x" }).branch).toBe("main");
    expect(updateConfigFromEnv({ CYNO_UPDATE_BRANCH: "a..b" }).branch).toBe("main");
  });
});
