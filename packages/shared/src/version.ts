/**
 * Versão do app e aviso de atualização. A versão vem do package.json da raiz e do git (número de commits);
 * a verificação compara o commit instalado com o ramo estável do `origin`. Com um clique o dono baixa a atualização
 * (`git fetch` + avanço direto, e `npm install` se o package-lock mudou); o app nunca reinicia a si mesmo: só avisa que falta reiniciar.
 */

export const VERSION_PATH = "/api/version";
export const VERSION_CHECK_PATH = "/api/version/check";
export const VERSION_UPDATE_PATH = "/api/version/update";

/** De onde saíram as informações do commit: do git local, de um arquivo gerado no build (Docker) ou só do package.json. */
export type VersionSource = "git" | "file" | "package";

export type VersionCommit = {
  hash: string;
  short: string;
  /** ISO 8601 */
  date: string;
  subject: string;
};

export type VersionInfo = {
  /** `version` do package.json da raiz. */
  version: string;
  /** Número de commits do HEAD (`git rev-list --count HEAD`); null sem informação de commit. */
  build: number | null;
  commit: VersionCommit | null;
  branch: string | null;
  /** Há mudanças locais em arquivos versionados, ainda sem commit. */
  dirty: boolean;
  source: VersionSource;
  /** Endereço web do repositório (só quando o origin é do GitHub), sem credencial. */
  repoUrl: string | null;
  /** Pronto para a tela: `v0.1.0 · build 3 · 1e014a6` (e `· modificado`). */
  label: string;
};

export type UpdateCommit = { hash: string; short: string; date: string; subject: string };

export type UpdateStatus = "none" | "up-to-date" | "update-available" | "unavailable";

export type UpdateCheckState = {
  /** Verificação automática ligada (`CYNO_UPDATE_CHECK`). A manual funciona sempre. */
  auto: boolean;
  /** Ramo estável do origin comparado (`CYNO_UPDATE_BRANCH`, padrão main). */
  branch: string;
  checking: boolean;
  /** ISO 8601 da última verificação; null se ainda não houve. */
  checkedAt: string | null;
  status: UpdateStatus;
  /** Commit do ramo no origin (quando se soube). */
  remote: { hash: string; short: string } | null;
  /** Quantos commits novos; null quando não foi possível contar. */
  count: number | null;
  /** Até 20 commits novos, do mais novo ao mais antigo; null quando a lista está indisponível. */
  commits: UpdateCommit[] | null;
  /** Link para os commits no GitHub (só origin do GitHub). */
  commitsUrl: string | null;
  /** Motivo curto quando `status` é `unavailable`. */
  reason: string | null;
};

/** Como o processo foi iniciado: define a instrução de reinício. */
export type RunMode = "pm2" | "docker" | "dev" | "start";

export type UpdateStep = "checking" | "fetching" | "merging" | "installing";

export type UpdateJobState = "running" | "done" | "failed";

/** O andamento (ou o resultado) do último "Baixar atualização". Fica só em memória. */
export type UpdateJob = {
  state: UpdateJobState;
  /** Passo em andamento (só com `state` running). */
  step: UpdateStep | null;
  startedAt: string;
  finishedAt: string | null;
  /** Commit de antes e de depois (curtos); `to` só quando o código avançou. */
  from: string | null;
  to: string | null;
  /** O código em disco avançou (mesmo que o `npm install` tenha falhado depois). */
  codeUpdated: boolean;
  /** O `npm install` rodou (o package-lock tinha mudado). */
  installRan: boolean;
  /** O `npm install` falhou: o código novo ficou, falta rodar `npm install` à mão. */
  installFailed: boolean;
  /** Resultado em uma frase (pt-BR). */
  message: string | null;
  /** Log curto e sem credenciais, um passo por linha. */
  log: string[];
};

/** O botão "Baixar atualização": se pode, e se não, por quê; mais o aviso de reinício pendente. */
export type UpdateApplyState = {
  /** `CYNO_UPDATE_APPLY` não está em off. */
  enabled: boolean;
  canDownload: boolean;
  blockedReason?: string;
  runMode: RunMode;
  /** O código em disco é diferente do que o processo carregou ao subir (baixado pelo botão ou à mão). */
  restartNeeded: boolean;
  /** HEAD do disco quando `restartNeeded`. */
  diskCommit: { hash: string; short: string } | null;
  /** Commit com que o processo subiu. */
  runningCommit: { hash: string; short: string } | null;
  job: UpdateJob | null;
};

export type VersionResponse = { version: VersionInfo; check: UpdateCheckState; update: UpdateApplyState };

/** `v0.1.0 · build 3 · 1e014a6`, com `· modificado` quando há mudanças locais. */
export function formatVersionLabel(info: { version: string; build: number | null; commit: { short: string } | null; dirty: boolean }): string {
  const parts = [`v${info.version}`];
  if (info.build !== null) parts.push(`build ${info.build}`);
  if (info.commit) parts.push(info.commit.short);
  if (info.dirty && info.commit) parts.push("modificado");
  return parts.join(" · ");
}
