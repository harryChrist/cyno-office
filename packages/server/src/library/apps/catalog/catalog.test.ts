import { catalogSchema, recipeStepSchema } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { APP_CATALOG } from "./index";

describe("catálogo de apps", () => {
  it("é válido, com ids únicos, e traz MarkItDown, Laya e os três apps de vídeo instaláveis", () => {
    expect(catalogSchema.safeParse(APP_CATALOG).success).toBe(true);
    expect(new Set(APP_CATALOG.map((app) => app.id)).size).toBe(APP_CATALOG.length);
    const byId = Object.fromEntries(APP_CATALOG.map((app) => [app.id, app]));
    expect(byId.markitdown?.status).toBe("disponivel");
    expect(byId.laya?.status).toBe("disponivel");
    for (const id of ["hyperframes", "ffmpeg-skill", "remotion"]) expect(byId[id]?.status, id).toBe("disponivel");
    // O que ainda não tem receita aparece como "em breve", sem botão de instalar, e diz por quê.
    for (const app of APP_CATALOG.filter((candidate) => candidate.status !== "disponivel")) {
      expect(app.recipe).toEqual([]);
      expect(app.pending).toBeTruthy();
    }
  });

  it("todo app disponível tem receita, conector, mini teste, repositório e versões fixadas", () => {
    for (const app of APP_CATALOG.filter((candidate) => candidate.status === "disponivel")) {
      expect(app.recipe.length).toBeGreaterThan(0);
      if (app.provides.connector?.kind !== "app") expect(app.provides.connector?.command?.[0]).toMatch(/^[^/].*/);
      expect(app.test?.tool).toBeTruthy();
      expect(app.repo).toMatch(/^https:\/\/github\.com\//);
      for (const step of app.recipe) {
        if (step.run === "pip-install") for (const pkg of step.packages) expect(pkg).toContain("==");
        if (step.run === "npm-install") for (const pkg of step.packages) expect(pkg).toMatch(/@\d/);
      }
      // O primeiro item do comando é relativo à pasta do app (nunca absoluto nem com "..").
      if (app.provides.connector?.kind !== "app") expect(app.provides.connector!.command![0]).not.toMatch(/^\/|\.\./);
    }
  });

  it("recusa receita com versão solta, caminho que escapa da pasta e passo desconhecido", () => {
    expect(recipeStepSchema.safeParse({ run: "pip-install", packages: ["requests"] }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "pip-install", packages: ["requests>=2"] }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "pip-install", packages: ["requests==2.0.0"] }).success).toBe(true);
    expect(recipeStepSchema.safeParse({ run: "npm-install", packages: ["left-pad"] }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "exec", bin: "/usr/bin/curl" }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "exec", bin: "../fora/x" }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "git-clone", repo: "https://github.com/a/b", ref: "main", to: "src" }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "shell", cmd: "curl x | sh" }).success).toBe(false);
    expect(recipeStepSchema.safeParse({ run: "sudo", cmd: "apt install x" }).success).toBe(false);
  });

  it("app disponível sem receita, sem teste ou com licença restrita sem aceite é inválido", () => {
    const base = APP_CATALOG.find((app) => app.id === "markitdown")!;
    expect(catalogSchema.safeParse([{ ...base, recipe: [] }]).success).toBe(false);
    expect(catalogSchema.safeParse([{ ...base, test: undefined }]).success).toBe(false);
    expect(catalogSchema.safeParse([{ ...base, license: { ...base.license, level: "restrita", mustAccept: false } }]).success).toBe(false);
    expect(catalogSchema.safeParse([base, base]).success).toBe(false);
  });

  it("apps com conector `app`: ferramentas coerentes com o teste e com o que a receita instala", () => {
    const apps = APP_CATALOG.filter((candidate) => candidate.provides.connector?.kind === "app");
    expect(apps.map((app) => app.id)).toContain("hyperframes");
    for (const app of apps) {
      const connector = app.provides.connector!;
      const names = (connector.tools ?? []).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      expect(connector.expectTools.sort()).toEqual([...names].sort());
      expect(names).toContain(app.test!.tool);
      const written = new Set(app.recipe.flatMap((step) => (step.run === "write-file" ? [step.to] : [])));
      const cloned = app.recipe.flatMap((step) => (step.run === "git-clone" ? [step.to] : []));
      for (const skill of app.provides.skills ?? []) {
        // A skill vem de um repositório clonado na receita ou de um SKILL.md que a própria receita escreve.
        expect(written.has(`${skill.from}/SKILL.md`) || cloned.some((to) => skill.from.startsWith(`${to}/`)), skill.from).toBe(true);
      }
      // O executável de cada ferramenta está dentro do app ou de runtimes/.
      for (const tool of connector.tools ?? []) expect(String(tool.command[0])).toMatch(/^(\{node\}|runtime:[a-z]+\/[\w./-]+|[a-z][\w./-]*)$/);
      // Cada runtime que o app usa é baixado pela receita (o instalador conta quem usa cada um).
      expect(app.recipe.some((step) => step.run === "download-runtime" && step.runtime === "ffmpeg")).toBe(true);
    }
  });

  it("HyperFrames: versão e commit fixados, sem telemetria, Chrome e ffmpeg dos runtimes, skills oficiais e a nossa", () => {
    const app = APP_CATALOG.find((candidate) => candidate.id === "hyperframes")!;
    expect(app).toMatchObject({ status: "disponivel", license: { spdx: "Apache-2.0", level: "livre" } });
    const npm = app.recipe.find((step) => step.run === "npm-install");
    expect(npm).toMatchObject({ packages: expect.arrayContaining(["hyperframes@0.9.33"]) });
    expect(app.recipe.find((step) => step.run === "git-clone")).toMatchObject({ ref: "e596be16c901639ce6c18032e56924a9d8e1967d", sparse: ["skills"] });
    const render = app.provides.connector!.tools!.find((tool) => tool.name === "render_video")!;
    expect(render.env).toMatchObject({ HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_BROWSER_PATH: expect.stringContaining("{runtimes}/chrome/") });
    expect(render.output).toMatchObject({ param: "output", kind: "video" });
    expect(render.command).toContain("{workers}");
    expect((app.provides.skills ?? []).map((skill) => skill.from)).toEqual(["cyno/hyperframes-on-cyno", "src/skills/hyperframes", "src/skills/hyperframes-cli", "src/skills/hyperframes-registry"]);
  });

  it("Remotion: licença restrita com aceite obrigatório e aviso, sem MCP, Chrome dos runtimes e skills oficiais", () => {
    const app = APP_CATALOG.find((candidate) => candidate.id === "remotion")!;
    expect(app.license).toMatchObject({ level: "restrita", mustAccept: true });
    expect(app.license.notice).toMatch(/3 funcionários/);
    expect(app.provides.connector).toMatchObject({ kind: "app" });
    expect(app.provides.connector!.command).toBeUndefined();
    const render = app.provides.connector!.tools!.find((tool) => tool.name === "render_video")!;
    expect(render.command.join(" ")).toContain("--browser-executable={runtimes}/chrome/");
    expect(render.command).toContain("--concurrency={workers}");
    expect(app.recipe.find((step) => step.run === "git-clone")).toMatchObject({ ref: "1fc074b74b95cfecf7b1e419132f2cfe23dafebe", to: "src" });
    expect((app.provides.skills ?? []).map((skill) => skill.from)).toEqual(["cyno/remotion-on-cyno", "src/skills/remotion-create", "src/skills/remotion-render", "src/skills/remotion-markup"]);
  });

  it("ffmpeg-skill: conector stdio com o MCP dele (commit fixado), sem `npx` e sem escrever em ~/.claude", () => {
    const app = APP_CATALOG.find((candidate) => candidate.id === "ffmpeg-skill")!;
    expect(app.provides.connector).toMatchObject({ kind: "stdio", command: [".venv/bin/python", "{app}/src/mcp/server.py"], env: { FFMPEG_SKILL_MCP_FULL: "0" } });
    expect(app.recipe.find((step) => step.run === "git-clone")).toMatchObject({ ref: "32e3355795d53c897ef804b6bcce2cda83cdd958" });
    expect(JSON.stringify(app.recipe)).not.toMatch(/npx|\.claude/);
    expect(app.test).toMatchObject({ tool: "probe", args: { inputs: ["{app}/test/sample.mp4"] } });
    expect(app.warnings[0]).toMatch(/qualquer lugar/);
  });
});
