import path from "node:path";
import type { EngineInstallPlan, InstallableEngineId, SupportedEngineId } from "@cyno/shared";

/**
 * Receitas de instalação dos motores em cópia privada do Cyno. Uma receita é uma lista de passos
 * (baixar um arquivo, rodar um comando sem shell) mais o plano em português que a tela mostra ANTES,
 * para o dono confirmar. Nada roda sem a confirmação dele (`POST …/install` com `confirm: true`,
 * registrado na Atividade).
 */

export type InstallStep =
  | { kind: "download"; label: string; url: string; to: string; mode?: number }
  | { kind: "run"; label: string; command: string; args: string[]; cwd?: string; env?: Record<string, string> };

export type InstallRecipe = {
  plan: EngineInstallPlan;
  steps: InstallStep[];
  /** Onde o executável fica depois (a detecção também olha o PATH e ~/.local/bin). */
  binaryCandidates: string[];
};

export type EngineDirs = { root: string; home: string };

/** Pastas do Cyno de cada motor: `<DATA_DIR>/platform/engines/<id>/`. */
export function engineDirs(dataDir: string, id: InstallableEngineId): EngineDirs {
  const root = path.join(dataDir, "platform", "engines", id);
  return { root, home: path.join(root, "home") };
}

export const HERMES_INSTALL_URL = "https://hermes-agent.nousresearch.com/install.sh";
/** O commit do código do Hermes lido para o adaptador (a instalação segue o canal estável do instalador oficial). */
export const HERMES_SOURCE_COMMIT = "2f23ce707c3a0c75d99f890db065916f8c9373cd";
export const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
export const AGY_INSTALL_URL = "https://antigravity.google/cli/install.sh";

/**
 * Claude Code (cópia privada do Cyno, opcional): instala o pacote npm `@anthropic-ai/claude-code`
 * sem `-g` dentro da pasta do motor (`npm install --prefix <pasta> @anthropic-ai/claude-code`).
 * O binário fica em `<pasta>/node_modules/.bin/claude` e nada global do sistema é alterado.
 */
export function claudeRecipe(dirs: EngineDirs): InstallRecipe {
  const prefix = dirs.root;
  const bin = path.join(prefix, "node_modules", ".bin", "claude");
  const args = ["install", "--prefix", prefix, CLAUDE_NPM_PACKAGE];
  return {
    plan: {
      engine: "claude",
      title: "Instalar o Claude Code (Anthropic)",
      command: `npm ${args.join(" ")}`,
      steps: [
        `Instala o pacote npm "${CLAUDE_NPM_PACKAGE}" na pasta privada do Cyno (${prefix}), sem -g e sem alterar instalações globais.`,
        `O executável fica em ${bin}.`,
        "Depois o Cyno passa a preferir esta cópia privada e confere a versão.",
      ],
      downloads: [`o registro npm (pacote ${CLAUDE_NPM_PACKAGE} e dependências)`],
      destination: `${prefix} (executável em ${bin})`,
      needsSudo: false,
      sudoNote: "Sem sudo: o pacote é instalado só dentro da pasta privada do Cyno (sem instalação global).",
      touches: [],
      unverified: ["Depende do npm disponível neste computador e de acesso ao registro npm."],
    },
    steps: [{ kind: "run", label: "Instalando o Claude Code", command: "npm", args, cwd: dirs.root }],
    binaryCandidates: [bin],
  };
}

/**
 * Google Antigravity CLI (`agy`, cópia privada do Cyno, opcional): baixa o `install.sh` oficial
 * para um arquivo e executa `bash <arquivo> --skip-path --skip-aliases` com `HOME` apontando para
 * a pasta privada do motor. O binário cai em `<pasta privada>/.local/bin/agy`; o instalador NUNCA
 * toca o HOME real nem os arquivos de shell do dono.
 */
export function agyRecipe(dirs: EngineDirs): InstallRecipe {
  const script = path.join(dirs.root, "install-agy.sh");
  const bin = path.join(dirs.home, ".local", "bin", "agy");
  const args = [script, "--skip-path", "--skip-aliases"];
  return {
    plan: {
      engine: "gemini",
      title: "Instalar o Antigravity (Google)",
      command: `curl -fsSL ${AGY_INSTALL_URL} -o ${script}  &&  HOME=${dirs.home} bash ${args.join(" ")}`,
      steps: [
        `Baixa o script oficial do Google para ${script} (sem "curl | bash").`,
        `Executa "bash ${args.join(" ")}" com HOME isolado em ${dirs.home}, sem alterar o seu HOME real nem arquivos do shell (--skip-path --skip-aliases).`,
        `O executável fica em ${bin}.`,
        "Depois o Cyno passa a preferir esta cópia privada e confere a versão.",
      ],
      downloads: [AGY_INSTALL_URL, "o binário do Antigravity CLI (baixado pelo script oficial do Google)"],
      destination: `${dirs.home} (executável em ${bin})`,
      needsSudo: false,
      sudoNote: "Sem sudo: o instalador roda com HOME isolado dentro da pasta privada do Cyno.",
      touches: [],
      unverified: [
        "Executa o script oficial do Google (antigravity.google/cli/install.sh), que não tem verificação de assinatura nem checksum. O script roda isolado na pasta privada do Cyno (HOME privado e --skip-path --skip-aliases), sem tocar o seu HOME real.",
      ],
    },
    steps: [
      { kind: "download", label: "Baixando o instalador do Antigravity", url: AGY_INSTALL_URL, to: script, mode: 0o700 },
      { kind: "run", label: "Instalando o Antigravity", command: "bash", args, cwd: dirs.root, env: { HOME: dirs.home } },
    ],
    binaryCandidates: [bin],
  };
}

/**
 * Hermes: o instalador oficial (scripts/install.sh do repositório), BAIXADO para um arquivo e rodado com `bash`
 * (nunca `curl | bash`), com `--non-interactive` (pula o assistente de configuração e a instalação do serviço do
 * gateway, e é o que evita o `sudo -v`), sem navegador (Chromium) e sem o driver de uso do computador. Instala o
 * código em `<pasta do Hermes no Cyno>/home/hermes-agent` e usa essa pasta como HERMES_HOME.
 */
export function hermesRecipe(dirs: EngineDirs, homeDir: string): InstallRecipe {
  const script = path.join(dirs.root, "install-hermes.sh");
  const installDir = path.join(dirs.home, "hermes-agent");
  const args = [script, "--hermes-home", dirs.home, "--dir", installDir, "--non-interactive", "--skip-browser", "--skip-computer-use"];
  return {
    plan: {
      engine: "hermes",
      title: "Instalar o Hermes (Nous Research)",
      command: `curl -fsSL ${HERMES_INSTALL_URL} -o ${script}  &&  bash ${args.join(" ")}`,
      steps: [
        `Baixa o instalador oficial para ${script} (o Cyno baixa o arquivo; não roda "curl | bash").`,
        "Roda o instalador com --non-interactive: não abre o assistente de configuração, não instala o serviço do gateway (mensagens) e não pede senha de administrador.",
        "O instalador baixa o gerenciador de pacotes uv (versão fixa dele), o Python que o Hermes pede e o código do Hermes (git), e monta o ambiente.",
        "Sem Chromium (--skip-browser) e sem o driver de uso do computador (--skip-computer-use).",
        "Depois o Cyno procura o comando hermes, confere a versão e o passo a passo segue para a chave do OpenRouter.",
      ],
      downloads: [HERMES_INSTALL_URL, "o repositório github.com/NousResearch/hermes-agent (git)", "o uv e o Python (pelo instalador do Hermes)", "as dependências Python do Hermes (PyPI)"],
      destination: `${installDir} (dados e configuração do Hermes em ${dirs.home}); algumas centenas de MB`,
      needsSudo: false,
      sudoNote: "Sem sudo: com --non-interactive o instalador não pede senha de administrador (visto no código dele, scripts/install.sh). Se faltar git ou curl, ele para e avisa.",
      touches: [
        `${path.join(homeDir, ".local", "bin", "hermes")} (o instalador publica o comando hermes aí)`,
        "Linha de PATH no ~/.bashrc, ~/.profile (ou ~/.zshrc, ~/.zprofile): só se o PATH do seu shell ainda não tiver ~/.local/bin",
      ],
      unverified: ["O instalador não foi executado nesta máquina: o plano vem da leitura do script (commit " + HERMES_SOURCE_COMMIT.slice(0, 7) + "). O resultado real aparece na saída da instalação e no passo Verificar."],
    },
    steps: [
      { kind: "download", label: "Baixando o instalador do Hermes", url: HERMES_INSTALL_URL, to: script, mode: 0o700 },
      { kind: "run", label: "Instalando o Hermes (pode levar alguns minutos)", command: "bash", args, cwd: dirs.root, env: { HERMES_HOME: dirs.home } },
    ],
    binaryCandidates: [path.join(homeDir, ".local", "bin", "hermes"), path.join(installDir, ".hermes", "bin", "hermes"), path.join(installDir, "venv", "bin", "hermes")],
  };
}

/** OpenClaw (se não estiver instalado): só o pacote npm, sem `onboard` e sem daemon, num prefixo do Cyno. */
export function openclawRecipe(dirs: EngineDirs): InstallRecipe {
  const prefix = path.join(dirs.root, "npm");
  const args = ["install", "--global", "--prefix", prefix, "openclaw@latest", "--allow-scripts=openclaw"];
  return {
    plan: {
      engine: "openclaw",
      title: "Instalar o OpenClaw",
      command: `npm ${args.join(" ")}`,
      steps: [`Instala o pacote npm "openclaw" num prefixo do Cyno (${prefix}); nada global do sistema.`, "Não roda `openclaw onboard`, não instala o daemon do Gateway, não liga canais nem celular.", "Depois o Cyno acha o comando openclaw e confere a versão."],
      downloads: ["o registro npm (pacote openclaw e dependências)"],
      destination: `${prefix} (comando em ${path.join(prefix, "bin", "openclaw")})`,
      needsSudo: false,
      sudoNote: "Sem sudo: o prefixo é uma pasta do Cyno. Pede Node 24.16+ ou 26.1+ (a documentação do OpenClaw).",
      touches: [],
      unverified: ["O pacote npm precisa do Node na versão pedida pela documentação; a instalação não foi rodada aqui (o OpenClaw desta máquina já estava instalado)."],
    },
    steps: [{ kind: "run", label: "Instalando o OpenClaw", command: "npm", args, cwd: dirs.root }],
    binaryCandidates: [path.join(prefix, "bin", "openclaw")],
  };
}

/** Receita padrão de instalação de qualquer motor instalável pelo Cyno. */
export function installRecipeFor(engine: InstallableEngineId, dataDir: string, homeDir: string): InstallRecipe {
  const dirs = engineDirs(dataDir, engine);
  switch (engine) {
    case "claude":
      return claudeRecipe(dirs);
    case "gemini":
      return agyRecipe(dirs);
    case "hermes":
      return hermesRecipe(dirs, homeDir);
    case "openclaw":
      return openclawRecipe(dirs);
  }
}

/** Caminhos onde a cópia privada do Cyno instala `claude` ou `gemini`. */
export function privateBinaryCandidates(dataDir: string, engine: SupportedEngineId): string[] {
  const dirs = engineDirs(dataDir, engine);
  return engine === "claude" ? claudeRecipe(dirs).binaryCandidates : agyRecipe(dirs).binaryCandidates;
}
