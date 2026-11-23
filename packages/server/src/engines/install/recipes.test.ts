import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngineBinary } from "../terminals/engines";
import { EngineInstaller } from "./installer";
import { AGY_INSTALL_URL, CLAUDE_NPM_PACKAGE, agyRecipe, claudeRecipe, engineDirs } from "./recipes";

describe("receitas de instalação privada (claude e agy)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cyno-recipes-"));
    dirs.push(dir);
    return dir;
  };

  it("claudeRecipe: npm install --prefix sem -g, binário em <prefix>/node_modules/.bin/claude e plano em pt-BR", () => {
    const dataDir = "/tmp/cyno-data-fake";
    const recipe = claudeRecipe(engineDirs(dataDir, "claude"));

    expect(recipe.plan.engine).toBe("claude");
    expect(recipe.plan.needsSudo).toBe(false);
    expect(recipe.plan.touches).toEqual([]);
    expect(recipe.plan.downloads.join(" ")).toContain(CLAUDE_NPM_PACKAGE);
    expect(recipe.plan.destination).toContain(path.join(dataDir, "platform", "engines", "claude"));

    expect(recipe.steps).toHaveLength(1);
    const step = recipe.steps[0]!;
    expect(step.kind).toBe("run");
    if (step.kind === "run") {
      expect(step.command).toBe("npm");
      expect(step.args).toEqual(["install", "--prefix", path.join(dataDir, "platform", "engines", "claude"), CLAUDE_NPM_PACKAGE]);
      expect(step.args).not.toContain("-g");
      expect(step.args).not.toContain("--global");
    }
    expect(recipe.binaryCandidates).toEqual([path.join(dataDir, "platform", "engines", "claude", "node_modules", ".bin", "claude")]);
  });

  it("agyRecipe: baixa install.sh oficial, roda com HOME privado e --skip-path --skip-aliases, avisa sobre ausência de assinatura", () => {
    const dataDir = "/tmp/cyno-data-fake";
    const recipe = agyRecipe(engineDirs(dataDir, "gemini"));
    const privateRoot = path.join(dataDir, "platform", "engines", "gemini");
    const privateHome = path.join(privateRoot, "home");

    expect(recipe.plan.engine).toBe("gemini");
    expect(recipe.plan.needsSudo).toBe(false);
    expect(recipe.plan.touches).toEqual([]);
    expect(recipe.plan.downloads).toContain(AGY_INSTALL_URL);
    expect(recipe.plan.unverified.join(" ")).toMatch(/Google/i);
    expect(recipe.plan.unverified.join(" ")).toMatch(/assinatura/i);

    expect(recipe.steps).toHaveLength(2);
    const [downloadStep, runStep] = recipe.steps;
    expect(downloadStep).toMatchObject({
      kind: "download",
      url: AGY_INSTALL_URL,
      to: path.join(privateRoot, "install-agy.sh"),
    });
    expect(runStep).toMatchObject({
      kind: "run",
      command: "bash",
      args: [path.join(privateRoot, "install-agy.sh"), "--skip-path", "--skip-aliases"],
      env: { HOME: privateHome },
    });
    expect(recipe.binaryCandidates).toEqual([path.join(privateHome, ".local", "bin", "agy")]);
    // Nada da receita referencia o HOME real do usuário.
    expect(JSON.stringify(recipe)).not.toContain(os.homedir());
  });

  it("agyRecipe executado no EngineInstaller grava o binário no HOME privado e nunca toca o HOME real", async () => {
    const base = await temp();
    const dataDir = path.join(base, "data");
    const fakeRealHome = path.join(base, "real-home");
    await mkdir(fakeRealHome, { recursive: true });

    const recipe = agyRecipe(engineDirs(dataDir, "gemini"));
    const fakeInstallScript = `#!/bin/sh
mkdir -p "$HOME/.local/bin"
cat << 'EOF' > "$HOME/.local/bin/agy"
#!/bin/sh
echo "agy-privado 1.0.0"
EOF
chmod +x "$HOME/.local/bin/agy"
echo "instalado em $HOME/.local/bin/agy"
`;
    const installer = new EngineInstaller({
      now: () => new Date("2026-11-23T00:00:00Z"),
      env: { ...process.env, HOME: fakeRealHome },
      fetch: async (url) => {
        expect(url).toBe(AGY_INSTALL_URL);
        return { ok: true, status: 200, text: async () => fakeInstallScript };
      },
    });
    installer.start("gemini", recipe);
    await installer.idle();

    expect(installer.current()?.status).toBe("done");
    expect(existsSync(recipe.binaryCandidates[0]!)).toBe(true);
    expect(existsSync(path.join(fakeRealHome, ".local"))).toBe(false);
  });

  it("resolveEngineBinary prefere a cópia privada quando existe, respeita caminho configurado e mantém o padrão sem cópia privada", async () => {
    const dataDir = await temp();
    const base = { command: "claude" };

    // Sem cópia privada -> usa o comando base (comportamento de hoje).
    expect(resolveEngineBinary("claude", { dataDir, base })).toEqual(base);

    // Com cópia privada executável -> prefere a cópia privada.
    const privateBin = claudeRecipe(engineDirs(dataDir, "claude")).binaryCandidates[0]!;
    await mkdir(path.dirname(privateBin), { recursive: true });
    await writeFile(privateBin, "#!/bin/sh\nexit 0\n");
    await chmod(privateBin, 0o755);
    expect(resolveEngineBinary("claude", { dataDir, base })).toEqual({ command: privateBin });

    // Com caminho explicitamente configurado na tela -> vence a cópia privada.
    expect(resolveEngineBinary("claude", { dataDir, base, configured: "/custom/claude" })).toEqual({ command: "/custom/claude" });
  });
});
