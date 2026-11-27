import { z } from "zod";

/** Senha de acesso ao app (uma só, sem contas). Rotas em /api/auth. */
export const AUTH_STATUS_PATH = "/api/auth/status";
export const AUTH_LOGIN_PATH = "/api/auth/login";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";
export const AUTH_LOGOUT_ALL_PATH = "/api/auth/logout-all";
export const AUTH_PASSWORD_PATH = "/api/auth/password";
/** Configuração inicial: cria a primeira senha com o código que o server escreve no log. */
export const AUTH_SETUP_PATH = "/api/auth/setup";
/** Segundo passo do login (código do app autenticador ou de recuperação). */
export const AUTH_LOGIN_2FA_PATH = "/api/auth/login/2fa";
/** Segurança (sessão): estado do 2FA, IPs bloqueados e últimas falhas. */
export const AUTH_SECURITY_PATH = "/api/auth/security";
export const AUTH_UNBLOCK_PATH = "/api/auth/unblock";
export const AUTH_2FA_SETUP_PATH = "/api/auth/2fa/setup";
export const AUTH_2FA_ENABLE_PATH = "/api/auth/2fa/enable";
export const AUTH_2FA_DISABLE_PATH = "/api/auth/2fa/disable";

/** Nome do cookie de sessão (HttpOnly). */
export const AUTH_COOKIE = "ao_session";

/** Comando que define a senha pelo terminal do servidor (alternativa ao código de configuração da tela). */
export const AUTH_SET_PASSWORD_COMMAND = "npm run auth:set-password -w @cyno/server";

/**
 * `enabled`: há senha definida; `authenticated`: esta requisição tem sessão válida (true sem senha só com
 * CYNO_AUTH=off); `setupRequired`: sem senha e o app fechado, esperando a criação da senha;
 * `setupCodeRequired`: false no aplicativo desktop (servidor só em loopback), onde a senha se cria direto,
 * sem o código de configuração; ausente/true nos demais (servidor, Docker).
 */
export type AuthStatus = { enabled: boolean; authenticated: boolean; setupRequired?: boolean; setupCodeRequired?: boolean };

/** Resposta do login: com 2FA ligado, a senha certa devolve só um token curto para o segundo passo. */
export type LoginResult = AuthStatus & { twoFactorToken?: string };

/** Código de configuração: 3 grupos de 4 (alfabeto sem 0/O/1/I/L). */
export const SETUP_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export const setupBodySchema = z.object({
  /** Obrigatório fora do desktop; o servidor decide (no desktop o código não existe e é ignorado). */
  code: z.string().max(64).optional(),
  password: z.string().min(1, "Digite uma senha").max(1024),
});
export type SetupBody = z.infer<typeof setupBodySchema>;

export const login2faBodySchema = z.object({ token: z.string().min(1).max(256), code: z.string().min(1).max(64) });
export type Login2faBody = z.infer<typeof login2faBodySchema>;

export const twoFactorCodeBodySchema = z.object({ code: z.string().min(1).max(64) });
export const twoFactorDisableBodySchema = z.object({ password: z.string().min(1).max(1024), code: z.string().min(1).max(64) });
export const unblockBodySchema = z.object({ ip: z.string().min(1).max(64) });

export type TwoFactorSetup = { secret: string; uri: string };
export type TwoFactorEnabled = { recoveryCodes: string[] };

export type SecurityBlock = { ip: string; until: string; attempts: number };
export type SecurityFailure = { ip: string; at: string; kind: "senha" | "codigo" | "configuracao" };
export type SecurityState = {
  twoFactor: boolean;
  recoveryRemaining: number;
  blocks: SecurityBlock[];
  failures: SecurityFailure[];
  /** O IP que o servidor enxerga para esta requisição (ajuda a conferir o IP real atrás de proxy). */
  yourIp: string;
};

export const loginBodySchema = z.object({ password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof loginBodySchema>;

export const changePasswordBodySchema = z.object({
  current: z.string().min(1).max(1024),
  next: z.string().min(1, "Digite a nova senha").max(1024),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
