import { z } from "zod";

/**
 * Contas extras por motor (Claude Code e Antigravity): a conta padrão (a do HOME real do servidor)
 * é implícita e não entra nesta lista. Cada conta cadastrada aqui ganha uma pasta de perfil isolada
 * no servidor — o caminho da pasta NUNCA sai pelas rotas da API.
 */
export const ACCOUNT_ENGINES = ["claude", "gemini"] as const;
export type AccountEngine = (typeof ACCOUNT_ENGINES)[number];

export function isAccountEngine(value: string): value is AccountEngine {
  return (ACCOUNT_ENGINES as readonly string[]).includes(value);
}

/** Identificador sintético da conta padrão (a do HOME real do servidor), uma por motor. */
export const DEFAULT_ACCOUNT_ID = "padrao";

/** Teto técnico de contas extras por motor (só contra abuso por engano; o uso normal nunca chega perto). */
export const MAX_ACCOUNTS_PER_ENGINE = 100;

/** Slug de conta: 3 a 40 caracteres [a-z0-9-], começando e terminando em letra ou dígito. */
export const ENGINE_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const engineAccountIdSchema = z.string().min(3).max(40).regex(ENGINE_ACCOUNT_ID_PATTERN);

const isoString = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const accountLabelSchema = z.string().trim().min(1).max(40);

/** Conta extra de um motor (como é guardada e devolvida pela API; nunca inclui caminho em disco). */
export const engineAccountSchema = z.object({
  id: engineAccountIdSchema,
  engine: z.enum(ACCOUNT_ENGINES),
  label: accountLabelSchema,
  createdAt: isoString,
});
export type EngineAccount = z.infer<typeof engineAccountSchema>;

/** Corpo de `POST /api/engines/accounts`. */
export const createEngineAccountSchema = z.strictObject({
  engine: z.enum(ACCOUNT_ENGINES),
  label: accountLabelSchema,
});
export type CreateEngineAccountBody = z.input<typeof createEngineAccountSchema>;

/** Corpo de `PATCH /api/engines/accounts/:id`. */
export const patchEngineAccountSchema = z.strictObject({
  label: accountLabelSchema,
});
export type PatchEngineAccountBody = z.input<typeof patchEngineAccountSchema>;

/** Conta de um motor devolvida pela API (com estado de login e `isDefault` na conta padrão). */
export type EngineAccountView = Omit<EngineAccount, "createdAt"> & {
  createdAt?: string;
  loggedIn: boolean;
  isDefault?: true;
};

export type EngineAccountsResponse = { accounts: EngineAccountView[] };
export type EngineAccountResponse = { account: EngineAccountView };

/** Rota da lista e criação de contas dos motores. */
export const ENGINE_ACCOUNTS_PATH = "/api/engines/accounts";
/** Rota de uma conta específica (`PATCH` e `DELETE`). */
export const engineAccountItemPath = (id: string) => `${ENGINE_ACCOUNTS_PATH}/${encodeURIComponent(id)}`;
