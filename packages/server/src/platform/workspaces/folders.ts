import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkFolder } from "@cyno/shared";
import { HttpError } from "../http/errors";

/** Mensagens de erro (pt-BR) de uma pasta de trabalho recusada. */
export const FOLDER_ERRORS = {
  relative: "Use o caminho completo da pasta, começando por / (ex.: /home/voce/projeto). O til (~) e caminhos relativos não valem.",
  missing: "Essa pasta não existe neste computador. Confira o caminho.",
  denied: "O Cyno não consegue abrir essa pasta (sem permissão). Confira o caminho e as permissões dela.",
  notDirectory: "Esse caminho é um arquivo, não uma pasta.",
  root: "A raiz do computador (/) não pode ser uma pasta de trabalho. Escolha a pasta do projeto.",
  unsafeChars: "O caminho tem um caractere que o Cyno não consegue usar nas regras de acesso (vírgula, asterisco, interrogação, colchetes, chaves, parênteses ou quebra de linha). Renomeie a pasta e cadastre de novo.",
  dataDir: "Essa pasta faz parte (ou contém) os dados do próprio Cyno e não pode ser uma pasta de trabalho.",
  duplicate: (name: string) => `Essa pasta já está cadastrada (como "${name}").`,
  limit: (max: number) => `O workspace já tem ${max} pastas de trabalho, o máximo. Tire alguma para cadastrar outra.`,
} as const;

/** Caracteres que quebrariam as regras de permissão dos motores (lista separada por vírgula, padrões com `*`, `(`…). */
const UNSAFE_PATH_CHARS = /[,*?[\]{}()\r\n]/;

/** `inner` é `outer` ou está dentro dela? (caminhos já normalizados) */
export function isInside(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Confere o caminho digitado de uma pasta de trabalho e devolve a forma gravada (caminho real, sem
 * links nem `..`): absoluto, existe, é uma pasta, não é `/`, não é nem contém nem fica dentro do
 * DATA_DIR do Cyno e ainda não está cadastrado neste workspace. Erro = HttpError 400 em português.
 */
export async function checkWorkFolderPath(input: string, options: { dataDir: string; existing: readonly WorkFolder[] }): Promise<string> {
  const typed = input.trim();
  if (!path.isAbsolute(typed)) throw new HttpError(400, FOLDER_ERRORS.relative);
  let real: string;
  try {
    real = await realpath(typed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new HttpError(400, code === "EACCES" || code === "EPERM" ? FOLDER_ERRORS.denied : FOLDER_ERRORS.missing);
  }
  let info;
  try {
    info = await stat(real);
  } catch {
    throw new HttpError(400, FOLDER_ERRORS.denied);
  }
  if (UNSAFE_PATH_CHARS.test(real)) throw new HttpError(400, FOLDER_ERRORS.unsafeChars);
  if (!info.isDirectory()) throw new HttpError(400, FOLDER_ERRORS.notDirectory);
  if (real === path.parse(real).root) throw new HttpError(400, FOLDER_ERRORS.root);
  const data = await realpath(options.dataDir).catch(() => path.resolve(options.dataDir));
  // Igual, dentro ou por cima do DATA_DIR (a pasta que contém o DATA_DIR daria acesso a tudo dele).
  if (isInside(real, data) || isInside(data, real)) throw new HttpError(400, FOLDER_ERRORS.dataDir);
  const same = options.existing.find((folder) => folder.path === real);
  if (same) throw new HttpError(400, FOLDER_ERRORS.duplicate(same.name));
  return real;
}

/** Id de uma pasta nova: o nome em slug + 4 hex (ids nunca se repetem, nem depois de a pasta sair: um ajuste antigo de agente não "volta"). */
export function newFolderId(name: string, taken: readonly string[]): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "pasta";
  for (;;) {
    const id = `${slug}-${randomBytes(2).toString("hex")}`;
    if (!taken.includes(id)) return id;
  }
}
