import { z } from "zod";
import { ACCOUNT_ENGINES, ENGINE_ACCOUNTS_PATH, type AccountEngine } from "./engine-accounts";
import { PTY_SIZE_LIMITS } from "./terminal";

/**
 * Protocolo do WebSocket do mini terminal de login de contas de motor
 * (`GET /api/engines/accounts/:id/login`, global, fora de `/w/:ws`).
 * Para a conta sintética `padrao`, informe `?engine=claude` ou `?engine=gemini`.
 */
export function engineAccountLoginPath(id: string, engine?: AccountEngine): string {
  const base = `${ENGINE_ACCOUNTS_PATH}/${encodeURIComponent(id)}/login`;
  return engine ? `${base}?engine=${encodeURIComponent(engine)}` : base;
}

/** Mensagens do navegador para o servidor: entrada do terminal e redimensionamento. */
export const engineLoginClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("in"), data: z.string().max(64_000) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(PTY_SIZE_LIMITS.minCols).max(PTY_SIZE_LIMITS.maxCols),
    rows: z.number().int().min(PTY_SIZE_LIMITS.minRows).max(PTY_SIZE_LIMITS.maxRows),
  }),
]);
export type EngineLoginClientMessage = z.infer<typeof engineLoginClientMessageSchema>;

/** Mensagens do servidor para o navegador. */
export const engineLoginServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), engine: z.enum(ACCOUNT_ENGINES), label: z.string() }),
  z.object({ type: z.literal("replay"), data: z.string() }),
  z.object({ type: z.literal("out"), data: z.string() }),
  z.object({ type: z.literal("login"), loggedIn: z.boolean() }),
  z.object({ type: z.literal("exit"), code: z.number().int().nullable() }),
]);
export type EngineLoginServerMessage = z.infer<typeof engineLoginServerMessageSchema>;
