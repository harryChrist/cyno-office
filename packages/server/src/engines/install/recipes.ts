import path from "node:path";
import type { EngineInstallPlan, OneShotEngineId } from "@cyno/shared";

/**
 * Receitas de instalação dos motores de um processo por turno. Uma receita é uma lista de passos (baixar um
 * arquivo, rodar um comando sem shell) mais o plano em português que a tela mostra ANTES, para o dono confirmar.
 * Nada roda sem a confirmação dele (`POST …/install` com `confirm: true`, registrado na Atividade).
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
export function engineDirs(dataDir: string, id: OneShotEngineId): EngineDirs {
  const root = path.join(dataDir, "platform", "engines", id);
  return { root, home: path.join(root, "home") };
}

export const HERMES_INSTALL_URL = "https://hermes-agent.nousresearch.com/install.sh";
/** O commit do código do Hermes lido para o adaptador (a instalação segue o canal estável do instalador oficial). */
export const HERMES_SOURCE_COMMIT = "2f23ce707c3a0c75d99f890db065916f8c9373cd";

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
