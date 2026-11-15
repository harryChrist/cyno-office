import { describe, expect, it } from "vitest";
import { parseOrigin } from "./origin";

describe("parseOrigin", () => {
  it.each([
    "git@github.com:dono/repo.git",
    "git@github.com:dono/repo",
    "ssh://git@github.com/dono/repo.git",
    "https://github.com/dono/repo.git",
    "https://github.com/dono/repo",
    "https://github.com/dono/repo/",
  ])("entende %s", (raw) => {
    const parsed = parseOrigin(raw);
    expect(parsed?.github).toEqual({ owner: "dono", repo: "repo", webUrl: "https://github.com/dono/repo", httpsUrl: "https://github.com/dono/repo.git" });
  });

  it("tira usuário e senha do https", () => {
    const parsed = parseOrigin("https://usuario:segredo@github.com/dono/repo.git");
    expect(parsed?.clean).not.toContain("segredo");
    expect(parsed?.clean).not.toContain("usuario");
    expect(parsed?.github?.owner).toBe("dono");
  });

  it("outro servidor não é do GitHub; vazio e lixo viram null", () => {
    expect(parseOrigin("git@gitlab.com:dono/repo.git")?.github).toBeNull();
    expect(parseOrigin("https://example.org/dono/repo.git")?.github).toBeNull();
    expect(parseOrigin("")).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
    expect(parseOrigin("isto não é endereço")).toBeNull();
  });
});
