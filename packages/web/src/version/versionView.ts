import type { RunMode, UpdateApplyState, UpdateCheckState, UpdateCommit, UpdateJob, UpdateStep, VersionInfo, VersionResponse } from "@cyno/shared";
import { formatAgo, formatDateTime } from "../ui/format";

/** O rótulo discreto da barra lateral: `v0.1.0 · build 3` (sem o hash; o hash fica nas Configurações). */
export function versionShort(info: Pick<VersionInfo, "version" | "build">): string {
  return info.build === null ? `v${info.version}` : `v${info.version} · build ${info.build}`;
}

export const UPDATE_AVAILABLE_LABEL = "Atualização disponível";
export const RESTART_LABEL = "Reinicie para aplicar";

/** O destaque da barra lateral: nada, atualização disponível ou reinício pendente (este tem prioridade). */
export type NavTone = "normal" | "update" | "restart";

export function navTone(response: Partial<Pick<VersionResponse, "check" | "update">> | null): NavTone {
  if (!response) return "normal";
  if (response.update?.restartNeeded === true) return "restart";
  return response.check?.status === "update-available" ? "update" : "normal";
}

/** Nome do botão de menu do celular, conforme o destaque. */
export function menuButtonLabel(tone: NavTone): string {
  if (tone === "restart") return "Abrir o menu (reinicie para aplicar a atualização)";
  return tone === "update" ? "Abrir o menu (há atualização disponível)" : "Abrir o menu";
}

/** O que a barra lateral (e o menu do celular) mostra: o rótulo da versão e, havendo novidade, o destaque. */
export type NavVersionView = {
  /** Texto curto da etiqueta na barra: a versão (`v0.1.0`), "Atualizar" ou "Reinicie". */
  chip: string;
  /** Texto completo (dica). */
  text: string;
  /** Segunda linha (só com atualização disponível: a versão instalada). */
  sub: string | null;
  /** Há atualização disponível (e nenhum reinício pendente). */
  available: boolean;
  tone: NavTone;
  /** Dica (`title`/`data-tip`) e nome para leitor de tela. */
  tip: string;
  aria: string;
};

export function navVersionView(response: (Pick<VersionResponse, "version" | "check"> & Partial<Pick<VersionResponse, "update">>) | null): NavVersionView | null {
  if (!response) return null;
  const short = versionShort(response.version);
  const tone = navTone(response);
  const available = tone === "update";
  if (tone === "restart") {
    const disk = response.update?.diskCommit?.short;
    const detail = disk ? `o código novo (${disk}) já está no disco` : "o código novo já está no disco";
    return {
      chip: "Reinicie",
      text: RESTART_LABEL,
      sub: short,
      available,
      tone,
      tip: `${RESTART_LABEL}: ${detail}. Você usa ${short}`,
      aria: `${RESTART_LABEL}, ${detail}. Versão em uso ${short}. Abrir Versão e atualizações`,
    };
  }
  if (available) {
    const count = response.check.count;
    const detail = count && count > 0 ? `${countCommits(count)} no ${response.check.branch}` : `há novidades no ${response.check.branch}`;
    return {
      chip: "Atualizar",
      text: UPDATE_AVAILABLE_LABEL,
      sub: short,
      available,
      tone,
      tip: `${UPDATE_AVAILABLE_LABEL}: ${detail}. Você usa ${short}`,
      aria: `${UPDATE_AVAILABLE_LABEL}, ${detail}. Versão instalada ${short}. Abrir Versão e atualizações`,
    };
  }
  return {
    chip: `v${response.version.version}`,
    text: short,
    sub: null,
    available,
    tone,
    tip: `Versão ${short}. Abrir Versão e atualizações`,
    aria: `Versão ${short}. Abrir Versão e atualizações`,
  };
}

export function countCommits(count: number): string {
  return count === 1 ? "1 commit novo" : `${count} commits novos`;
}

export type CheckTone = "ok" | "warn" | "off" | "idle";

/** O estado da verificação para a seção das Configurações. */
export type CheckStatusView = {
  tone: CheckTone;
  title: string;
  detail: string | null;
};

export function checkStatusView(check: UpdateCheckState): CheckStatusView {
  switch (check.status) {
    case "up-to-date":
      return {
        tone: "ok",
        title: "Em dia",
        detail: `Você tem tudo o que há no ramo ${check.branch}.`,
      };
    case "update-available": {
      const count = check.count;
      const title = count === null ? "Há atualização" : count === 1 ? "Há 1 atualização" : `Há ${count} atualizações`;
      return {
        tone: "warn",
        title,
        detail: `O ramo ${check.branch} tem commits que esta instalação ainda não tem.`,
      };
    }
    case "unavailable":
      return {
        tone: "warn",
        title: "Não foi possível verificar",
        detail: check.reason,
      };
    default:
      return check.auto
        ? {
            tone: "idle",
            title: "Ainda não verificado",
            detail: "A primeira verificação roda um minuto depois de ligar o servidor.",
          }
        : {
            tone: "off",
            title: "Verificação automática desligada",
            detail: "Use Verificar agora quando quiser consultar o GitHub.",
          };
  }
}

/** Quando foi a última verificação: "há 5 min" (ou a data), ou "Ainda não verificado". */
export function lastCheckedText(check: Pick<UpdateCheckState, "checkedAt">, now: Date = new Date()): string {
  return check.checkedAt ? `Última verificação ${formatAgo(check.checkedAt, now)}` : "Ainda não verificado";
}

/** Os campos do commit instalado, prontos para a lista (só o que existe). */
export function commitRows(info: VersionInfo): { id: string; label: string; value: string }[] {
  const rows = [{ id: "version", label: "Versão", value: `v${info.version}` }];
  if (info.build !== null)
    rows.push({
      id: "build",
      label: "Build",
      value: `${info.build} (número de commits)`,
    });
  if (info.commit) {
    rows.push({ id: "commit", label: "Commit", value: info.commit.short });
    if (info.commit.subject)
      rows.push({
        id: "subject",
        label: "Último commit",
        value: info.commit.subject,
      });
    if (info.commit.date)
      rows.push({
        id: "date",
        label: "Data do commit",
        value: formatDateTime(info.commit.date),
      });
  }
  if (info.branch) rows.push({ id: "branch", label: "Ramo", value: info.branch });
  return rows;
}

export function sourceNote(info: Pick<VersionInfo, "source" | "commit">): string | null {
  if (info.source === "file") return "O commit vem do arquivo gravado quando a imagem foi construída (esta instalação não tem a pasta .git).";
  if (info.source === "package") return "Esta instalação não registra o commit; só a versão do package.json é conhecida.";
  return null;
}

export const DIRTY_NOTE = "Há mudanças locais ainda sem commit. Atualizar com git pull (ou pelo botão) pede que você as guarde ou descarte antes.";

export function commitLine(commit: UpdateCommit): {
  subject: string;
  meta: string;
} {
  return {
    subject: commit.subject || "(sem assunto)",
    meta: `${commit.short}${commit.date ? ` · ${formatDateTime(commit.date)}` : ""}`,
  };
}

export function hiddenCommits(check: Pick<UpdateCheckState, "count" | "commits">): number {
  return check.count !== null && check.commits ? Math.max(0, check.count - check.commits.length) : 0;
}

export type InstallGuide = {
  id: "pm2" | "docker";
  title: string;
  hint: string;
  steps: { note: string; command: string }[];
};

/** Como atualizar em cada modo de instalação (os comandos de docs/como-rodar.md). O app só avisa; quem atualiza é você. */
export const INSTALL_GUIDES: InstallGuide[] = [
  {
    id: "pm2",
    title: "Com pm2",
    hint: "No servidor, dentro da pasta do projeto.",
    steps: [
      { note: "Baixa o código novo", command: "git pull" },
      { note: "Se as dependências mudaram", command: "npm install" },
      {
        note: "Reinicia (a web recompila ao reiniciar)",
        command: "npm run pm2:restart",
      },
    ],
  },
  {
    id: "docker",
    title: "Com Docker",
    hint: "No servidor, dentro da pasta do projeto. Os volumes continuam.",
    steps: [
      { note: "Baixa o código novo", command: "git pull" },
      {
        note: "Reconstrói e reinicia (grava a versão na imagem)",
        command: "npm run docker:up",
      },
    ],
  },
];

/* ---------- Baixar a atualização ---------- */

export const DOWNLOAD_LABEL = "Baixar atualização";
export const RESTART_TITLE = "Atualização baixada. Reinicie para aplicar.";
export const RESTART_WARNING = "Reiniciar interrompe os agentes que estiverem trabalhando. Espere terminarem ou aceite o corte.";

/** O que o botão da atualização mostra: nada, baixar, bloqueado (com o motivo), em andamento ou instrução do Docker. */
export type UpdateActionView =
  { kind: "none" } | { kind: "download"; label: string } | { kind: "blocked"; label: string; reason: string } | { kind: "running"; label: string; progress: string } | { kind: "docker" };

export const STEP_TEXT: Record<UpdateStep, string> = {
  checking: "Conferindo o repositório…",
  fetching: "Baixando o código…",
  merging: "Aplicando o código novo…",
  installing: "Instalando dependências…",
};

export function progressText(job: Pick<UpdateJob, "state" | "step">): string {
  return job.step ? STEP_TEXT[job.step] : "Baixando o código…";
}

type UpdateInput = {
  check: Pick<UpdateCheckState, "status">;
  update?: UpdateApplyState;
};

export function updateActionView(response: UpdateInput | null): UpdateActionView {
  const update = response?.update;
  if (!response || !update) return { kind: "none" };
  if (update.job?.state === "running")
    return {
      kind: "running",
      label: "Baixando…",
      progress: progressText(update.job),
    };
  const available = response.check.status === "update-available";
  if (update.runMode === "docker") return available ? { kind: "docker" } : { kind: "none" };
  if (update.canDownload) return { kind: "download", label: DOWNLOAD_LABEL };
  if (available)
    return {
      kind: "blocked",
      label: DOWNLOAD_LABEL,
      reason: update.blockedReason ?? "Não é possível baixar agora.",
    };
  return { kind: "none" };
}

/** O texto da confirmação do botão: o que ele faz e o que não faz. */
export function downloadConfirmText(branch: string): {
  title: string;
  lines: string[];
} {
  return {
    title: "Baixar a atualização?",
    lines: [
      `Isso baixa o código novo do ramo ${branch} e instala as dependências se elas mudaram. Só avança o código, sem mexer em arquivos seus.`,
      "Nada é reiniciado: o app em execução continua com o código antigo até você reiniciar.",
    ],
  };
}

export type RestartGuide = {
  id: RunMode;
  title: string;
  lead: string;
  command: string;
};

const RESTART_GUIDES: Record<RunMode, RestartGuide> = {
  pm2: {
    id: "pm2",
    title: "Com pm2",
    lead: "No servidor, dentro da pasta do projeto. A web recompila ao reiniciar.",
    command: "npm run pm2:restart",
  },
  start: {
    id: "start",
    title: "Com npm start",
    lead: "Pare o processo (Ctrl+C no terminal onde ele roda) e rode de novo na pasta do projeto.",
    command: "npm start",
  },
  dev: {
    id: "dev",
    title: "Modo de desenvolvimento",
    lead: "O modo de desenvolvimento reinicia sozinho. Se a tela não mudar, pare e rode de novo.",
    command: "npm run dev",
  },
  docker: {
    id: "docker",
    title: "Com Docker",
    lead: "No computador hospedeiro, dentro da pasta do projeto. Reconstrói a imagem e reinicia; os volumes continuam.",
    command: "npm run docker:up",
  },
};

const GUIDE_ORDER: RunMode[] = ["pm2", "start", "dev", "docker"];

/** A instrução do jeito detectado em primeiro lugar; os outros jeitos vão recolhidos. */
export function restartGuides(runMode: RunMode): {
  primary: RestartGuide;
  others: RestartGuide[];
} {
  return {
    primary: RESTART_GUIDES[runMode],
    others: GUIDE_ORDER.filter((id) => id !== runMode).map((id) => RESTART_GUIDES[id]),
  };
}

export type RestartNoticeView = {
  tone: "warn" | "error";
  title: string;
  detail: string;
  /** Passo antes de reiniciar (só quando o npm install falhou). */
  beforeCommand: { note: string; command: string } | null;
  warning: string;
  primary: RestartGuide;
  others: RestartGuide[];
};

/** O aviso em destaque: reinício pendente (baixado pelo botão ou à mão) ou dependências por instalar. null = nada a avisar. */
export function restartNoticeView(update: UpdateApplyState | undefined): RestartNoticeView | null {
  if (!update) return null;
  const job = update.job;
  const installFailed = job?.installFailed === true;
  if (!update.restartNeeded && !installFailed) return null;
  const guides = restartGuides(update.runMode);
  if (installFailed) {
    return {
      tone: "error",
      title: "Falta instalar as dependências.",
      detail: "O código novo foi baixado, mas o npm install falhou. Rode npm install na pasta do projeto e, quando terminar, reinicie.",
      beforeCommand: {
        note: "Instala as dependências",
        command: "npm install",
      },
      warning: RESTART_WARNING,
      ...guides,
    };
  }
  const detail =
    job?.state === "done" && job.codeUpdated && job.from && job.to
      ? `Do commit ${job.from} para ${job.to}.`
      : update.diskCommit && update.runningCommit
        ? `O código em disco (${update.diskCommit.short}) é mais novo que o do processo em execução (${update.runningCommit.short}).`
        : "O código em disco é diferente do que o processo carregou.";
  return {
    tone: "warn",
    title: RESTART_TITLE,
    detail,
    beforeCommand: null,
    warning: RESTART_WARNING,
    ...guides,
  };
}

/** Falha do download em que o código NÃO mudou (o caso do npm install fica no aviso de reinício). */
export function jobFailureText(job: UpdateJob | null | undefined): string | null {
  return job && job.state === "failed" && !job.codeUpdated ? (job.message ?? "Não foi possível baixar a atualização.") : null;
}

/** A seção "Como atualizar à mão": recolhida quando o botão é o caminho; aberta quando é o único caminho. */
export type HowtoView = {
  intro: string;
  open: boolean;
  order: ("pm2" | "docker")[];
};

export function howtoView(response: UpdateInput | null): HowtoView {
  const action = updateActionView(response);
  const dockerFirst = response?.update?.runMode === "docker";
  const order: ("pm2" | "docker")[] = dockerFirst ? ["docker", "pm2"] : ["pm2", "docker"];
  if (action.kind === "download" || action.kind === "running")
    return {
      intro: `Prefere atualizar à mão? Rode os comandos no servidor, do jeito que você instalou. O botão ${DOWNLOAD_LABEL} faz o mesmo que git pull e npm install.`,
      open: false,
      order,
    };
  if (action.kind === "docker")
    return {
      intro: "Nesta instalação a atualização é feita no computador hospedeiro. Rode os comandos abaixo lá, dentro da pasta do projeto.",
      open: true,
      order,
    };
  if (action.kind === "blocked")
    return {
      intro: "O botão não pode baixar agora (veja o motivo acima). Dá para atualizar à mão, no servidor, do jeito que você instalou.",
      open: true,
      order,
    };
  return {
    intro: "O Cyno nunca reinicia sozinho. Para atualizar à mão, rode os comandos no servidor, do jeito que você instalou.",
    open: false,
    order,
  };
}
