import { z } from "zod";

/**
 * Navegador compartilhado do workspace: um Chromium com perfil persistente (cookies e sessões
 * sobrevivem a reinícios), usado pelos agentes (ferramentas MCP `browser_*`) e pelo usuário (painel
 * "Navegador", com a tela ao vivo e controle remoto: é por ali que ele faz login nos sites uma vez).
 * Cada aba tem um dono (um agente ou o usuário); o perfil é o mesmo para todos.
 */

/** Dono das abas abertas pelo usuário no painel. */
export const BROWSER_USER_OWNER = "user";

/** Limites de abas: por dono (agente ou usuário) e no total do workspace. */
export const BROWSER_LIMITS = { tabsPerOwner: 4, tabsTotal: 12 } as const;

/** Tamanho da janela do navegador (CSS px): o que o agente "vê" e o que o painel mostra. Proporção 16:10 (o CSS da página Navegador usa a mesma). */
export const BROWSER_VIEWPORT = { width: 1440, height: 900 } as const;

/** Uma aba aberta. `owner`: id do agente ou "user". */
export type BrowserTab = {
  id: string;
  owner: string;
  /** Nome de quem abriu ("Você" para o usuário). */
  ownerName: string;
  url: string;
  title: string;
  openedAt: string;
  lastActiveAt: string;
};

/** Estado do navegador do workspace (GET /browser e o evento browser:tabs). */
export type BrowserState = {
  /** O server tem o navegador ligado (BROWSER=0 desliga)? */
  enabled: boolean;
  /** O Chromium está aberto agora (sobe sob demanda e fecha depois de um tempo sem uso)? */
  running: boolean;
  tabs: BrowserTab[];
};

/** Um agente usou o navegador (só visual: o globo no balão e a atividade). `label` em pt-BR ("Abriu google.com"). */
export type BrowserActivity = { agentId: string; tabId: string; label: string; at: string };

/** Domínio sem o "www." (rótulos: "Abriu google.com"). */
export function browserHostLabel(url: string): string {
  const match = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url.trim());
  return match ? match[1]!.toLowerCase().replace(/^www\./, "") : url;
}

// ---------- WebSocket da tela ao vivo (painel Navegador) ----------

/** WebSocket da tela ao vivo e do controle remoto: `/api/w/<ws>/browser/stream`. */
export function browserStreamPath(workspaceId: string): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/browser/stream`;
}

const fraction = z.number().min(0).max(1);

/**
 * Do painel para o server. Coordenadas em fração da tela (0..1), para não depender do tamanho em
 * que a imagem aparece. `watch`: qual aba transmitir (null = nenhuma).
 */
export const browserClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("watch"), tab: z.string().max(32).nullable() }),
  z.object({ t: z.literal("click"), x: fraction, y: fraction, button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional() }),
  z.object({ t: z.literal("wheel"), x: fraction, y: fraction, dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) }),
  z.object({ t: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.object({ t: z.literal("key"), key: z.string().min(1).max(40) }),
  z.object({ t: z.literal("navigate"), url: z.string().trim().min(1).max(2000) }),
  z.object({ t: z.literal("back") }),
  z.object({ t: z.literal("forward") }),
  z.object({ t: z.literal("reload") }),
]);
export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>;

/** Do server para o painel: um quadro da aba assistida (JPEG em base64) ou um erro de uma ação. */
export type BrowserServerMessage =
  | { t: "frame"; tab: string; data: string; width: number; height: number }
  | { t: "gone"; tab: string }
  | { t: "error"; message: string };

/** Parâmetros de DELETE /browser/tabs/:tab. */
export const browserTabParamsSchema = z.object({ tab: z.string().regex(/^t\d{1,6}$/) });

/** POST /browser/tabs (o usuário abre uma aba). */
export const browserOpenBodySchema = z.strictObject({ url: z.string().trim().max(2000).optional() });
