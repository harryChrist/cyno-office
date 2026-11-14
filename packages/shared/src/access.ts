import { z } from "zod";

/**
 * Acesso dos agentes de um workspace (Configurações › workspace › Acesso dos agentes): o que os
 * agentes PODEM usar além do escritório e da pasta deles. É a política do projeto; cada agente só
 * pode restringir (campos `internet`/`browser`/`terminal` dele, veja effectiveAccess).
 *
 * - internet: busca na web e leitura de páginas (Claude Code: WebSearch/WebFetch; Antigravity:
 *   search_web e ler URL);
 * - browser: o navegador compartilhado do Cyno (só com internet);
 * - terminal: rodar comandos no servidor (Claude Code: Bash; Antigravity: run_command), dentro da
 *   pasta do agente — desligado por padrão;
 * - approveSensitiveActions: publicar/enviar/comprar no navegador pede aprovação do usuário;
 * - allowLocalNetwork: navegador/leitura de páginas podem abrir IPs da rede local e o loopback;
 * - allowedDomains (vazio = todos) / blockedDomains: domínios, ex.: "exemplo.com" (vale também
 *   para os subdomínios).
 */
export const workspaceAccessSchema = z.object({
  internet: z.boolean().default(true),
  browser: z.boolean().default(true),
  terminal: z.boolean().default(false),
  approveSensitiveActions: z.boolean().default(true),
  allowLocalNetwork: z.boolean().default(false),
  allowedDomains: z.array(z.string()).default([]),
  blockedDomains: z.array(z.string()).default([]),
});
export type WorkspaceAccess = z.infer<typeof workspaceAccessSchema>;
/** A política como pode estar gravada (campos ausentes = os padrões). */
export type WorkspaceAccessInput = z.input<typeof workspaceAccessSchema>;

/** Acesso de um agente (o que o workspace permite E o agente não desligou). */
export type EffectiveAccess = { internet: boolean; browser: boolean; terminal: boolean };

/** Campos de acesso do agente (ausente = segue o workspace; `false` = desligado só para ele). */
export type AgentAccessFields = { internet?: boolean; browser?: boolean; terminal?: boolean };

export const DEFAULT_WORKSPACE_ACCESS: WorkspaceAccess = workspaceAccessSchema.parse({});

/** A política com os padrões aplicados (workspace antigo, sem `access`, ou inválido = os padrões). */
export function workspaceAccess(raw?: unknown): WorkspaceAccess {
  const parsed = workspaceAccessSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : workspaceAccessSchema.parse({});
}

/**
 * Workspace E agente (agente sem campo segue o workspace; `false` desliga só para ele); sem internet
 * não há navegador. Aceita a política ou o workspace (`{ access }`); devolve a política inteira com
 * internet/navegador/terminal já do agente (os domínios e o resto são os do workspace).
 */
export function effectiveAccess(ws: WorkspaceAccess | { access?: unknown } | undefined, agent: AgentAccessFields): WorkspaceAccess {
  const base = workspaceAccess(ws && "access" in ws ? ws.access : ws);
  const internet = base.internet && agent.internet !== false;
  return {
    ...base,
    internet,
    browser: internet && base.browser && agent.browser !== false,
    terminal: base.terminal && agent.terminal !== false,
  };
}

/** Limites da lista de domínios (cada lista). */
export const ACCESS_DOMAIN_LIMITS = { max: 100, length: 253 } as const;

/**
 * Domínio digitado -> forma canônica ("https://www.Exemplo.com/x" -> "www.exemplo.com"; "*.a.com" ->
 * "a.com", que já cobre os subdomínios). Inválido = undefined.
 */
export function normalizeDomain(input: string): string | undefined {
  let text = input.trim().toLowerCase();
  if (!text) return undefined;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.split(/[/?#]/, 1)[0] ?? "";
  text = text.replace(/:\d+$/, "").replace(/^\*\./, "").replace(/\.$/, "");
  if (text.length === 0 || text.length > ACCESS_DOMAIN_LIMITS.length) return undefined;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(text)) return undefined;
  return text;
}

/** O host é o domínio ou um subdomínio dele? */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/** O host pode ser aberto pela política? (bloqueados vencem; lista de permitidos vazia = todos) */
export function domainAllowed(access: Pick<WorkspaceAccess, "allowedDomains" | "blockedDomains">, host: string): boolean {
  if (access.blockedDomains.some((domain) => hostMatchesDomain(host, domain))) return false;
  return access.allowedDomains.length === 0 || access.allowedDomains.some((domain) => hostMatchesDomain(host, domain));
}

const domainListSchema = z
  .array(z.string().max(ACCESS_DOMAIN_LIMITS.length + 20))
  .max(ACCESS_DOMAIN_LIMITS.max)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const item of list) {
      const domain = normalizeDomain(item);
      if (!domain) {
        ctx.addIssue({ code: "custom", message: `Domínio inválido: "${item}"` });
        return z.NEVER;
      }
      if (!out.includes(domain)) out.push(domain);
    }
    return out;
  });

/** Campos de acesso que o usuário manda (todos opcionais; domínios normalizados). */
export const workspaceAccessInputSchema = z.strictObject({
  internet: z.boolean().optional(),
  browser: z.boolean().optional(),
  terminal: z.boolean().optional(),
  approveSensitiveActions: z.boolean().optional(),
  allowLocalNetwork: z.boolean().optional(),
  allowedDomains: domainListSchema.optional(),
  blockedDomains: domainListSchema.optional(),
});

/** PUT /api/workspaces/:ws/access: só o que muda (o resto fica). */
export const updateWorkspaceAccessBodySchema = workspaceAccessInputSchema.refine((body) => Object.values(body).some((value) => value !== undefined), {
  message: "Nada para mudar",
});
export type UpdateWorkspaceAccessBody = z.input<typeof updateWorkspaceAccessBodySchema>;

/** Caminho da rota (o `:ws` é o id do workspace). */
export const workspaceAccessPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/access`;

/** Rótulos (pt-BR) do que cada acesso deixa fazer, na ordem das telas. */
export const ACCESS_LABELS: Record<keyof EffectiveAccess, { can: string; short: string }> = {
  internet: { can: "pesquisar na web", short: "Internet" },
  browser: { can: "navegar", short: "Navegador" },
  terminal: { can: "usar o terminal", short: "Terminal" },
};

/** O que pode e o que não pode (o resumo do topo da seção e o selo da lista de agentes). */
export function accessSummary(access: EffectiveAccess): { can: string[]; cannot: string[] } {
  const keys = Object.keys(ACCESS_LABELS) as (keyof EffectiveAccess)[];
  return {
    can: keys.filter((key) => access[key]).map((key) => ACCESS_LABELS[key].can),
    cannot: keys.filter((key) => !access[key]).map((key) => ACCESS_LABELS[key].can),
  };
}
