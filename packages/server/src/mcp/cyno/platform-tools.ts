import { CARD_SUMMARY_MAX, type Card, type WaitingItem } from "@cyno/shared";
import { z } from "zod";
import { renderCardFull } from "../../platform/cards/compact";
import { defineTool, type McpTool, type McpToolResult } from "../protocol";
import { findByRef } from "../structure-tools";
import { requestTools, type RequestToolsDeps } from "./request-tools";
import { DAY_STATS_DESCRIPTION_PLATFORM, dayField } from "../day-stats-tools";
import { METRICS_DESCRIPTION_PLATFORM, metricsFields, type MetricsInput } from "../metrics-tools";
import { DESCRIPTION_PLATFORM as REPORT_DESCRIPTION_PLATFORM, reportFields, type ReportInput } from "../report-tools";

/** Teto da resposta de uma ferramenta do Cyno (caracteres): o resto se pede com ferramentas de detalhe. */
export const PLATFORM_TOOL_MAX_CHARS = 4000;

export type PlatformToolsDeps = {
  /** As fichas de todos os workspaces (calculadas por código; ler não acorda ninguém). */
  cards: () => Card[];
  /** O que espera o dono em todos os workspaces. */
  waiting: () => WaitingItem[];
  /** Escreve a frase da ficha (o Cyno é uma IA: sobre a frase do dono ela vira sugestão). */
  setSummary: (workspace: string, text: string) => Promise<"frase" | "sugestao" | "igual">;
  /** O painel "Hoje" (todos os workspaces, ou um) em texto compacto (`get_today`); undefined = o workspace não existe. */
  today?: (workspace?: string) => string | undefined;
  /** A diária ("Meu dia") em texto: todos os workspaces somados, ou um (`get_day_stats`); undefined = o workspace não existe. Joga erro com o motivo se o dia for inválido. */
  dayStats?: (input: { day?: string; workspace?: string }) => Promise<string | undefined>;
  /** As métricas da Gestão em texto (`get_metrics`): um workspace (completo) ou todos (um bloco curto cada); undefined = o workspace não existe. */
  metrics?: (input: MetricsInput & { workspace?: string }) => Promise<string | undefined>;
  /** O relatório congelado (`get_report`): de um workspace, ou a semana da plataforma (`scope: "platform"`); undefined = o workspace não existe. Joga erro com o motivo se o período for inválido. */
  report?: (input: ReportInput & { workspace?: string; scope: "workspace" | "platform" }) => Promise<string | undefined>;
  /** O resumo do "enquanto você estava fora" em texto (`get_away_summary`), o mesmo do cartão ao voltar. */
  away?: () => Promise<string>;
  /** O texto do `get_usage` (o mesmo do Maestro, com o gasto do Cyno). */
  usageReport: () => Promise<string>;
  /** Pedidos aos Maestros: `send_request`, `get_request_status`, `message_agent` & cia (ausente = as ferramentas não existem). */
  requests?: RequestToolsDeps;
};

const ok = (text: string): McpToolResult => ({ text: text.length > PLATFORM_TOOL_MAX_CHARS ? `${text.slice(0, PLATFORM_TOOL_MAX_CHARS - 1)}…` : text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const workspaceField = z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)");

function resolve(cards: Card[], ref: string): Card | undefined {
  const found = findByRef(
    cards.map((card) => ({ id: card.workspace, name: card.name })),
    ref,
  );
  return found ? cards.find((card) => card.workspace === found.id) : undefined;
}

/**
 * Ferramentas MCP do Cyno (escopo "platform"), em inglês. Só leitura de código e a frase da ficha:
 * nenhuma acorda um Maestro nem um agente. Pedidos, estrutura, agenda e mural vêm nas próximas fatias.
 */
export function platformTools(deps: PlatformToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "list_workspaces",
      description:
        "Lists every workspace with the one-sentence summary of what it does, the Maestro state, team size, active projects and how many items wait for the owner. Built from the workspace cards by code: read-only, it does not wake anyone. Use get_workspace_card for the full card.",
      input: z.object({}),
      call: () => {
        const cards = deps.cards();
        if (cards.length === 0) return ok("There are no workspaces yet. The owner can create one on the platform.");
        const lines = cards.map(
          (card) =>
            `- ${card.workspace} — "${card.name}": ${card.summary.summary || "(no 'what it does' sentence yet)"} | maestro ${card.team.maestro.status} | ${plural(card.team.agents.length, "team agent", "team agents")} | ${plural(card.projects.active.length, "active project", "active projects")} | ${card.waitingForYou} waiting for the owner`,
        );
        return ok([`${plural(cards.length, "workspace", "workspaces")}:`, ...lines].join("\n"));
      },
    }),
    defineTool({
      name: "get_workspace_card",
      description:
        "The full card of one workspace, built by code with no AI and no waking: the sentence of what it does, the Maestro and every agent with engine/model/state, rooms, declared sites (login is not verified), connectors, active routines with next runs, projects in progress with the current stage, the latest deliveries, items waiting for the owner and usage.",
      input: z.object({ workspace: workspaceField }),
      call: ({ workspace }) => {
        const card = resolve(deps.cards(), workspace);
        return card ? ok(renderCardFull(card)) : fail(`No workspace "${workspace}". Use list_workspaces.`);
      },
    }),
    defineTool({
      name: "list_waiting_for_you",
      description: "Lists what is waiting for the owner across all workspaces (oldest first): workspace, item id, type, title and who asked. Read-only. The owner decides in the Para você page of that workspace.",
      input: z.object({ workspace: workspaceField.optional() }),
      call: ({ workspace }) => {
        const cards = deps.cards();
        const only = workspace ? resolve(cards, workspace) : undefined;
        if (workspace && !only) return fail(`No workspace "${workspace}". Use list_workspaces.`);
        const items = deps.waiting().filter((item) => !only || item.workspace === only.workspace);
        if (items.length === 0) return ok("Nothing is waiting for the owner.");
        return ok([`${items.length} waiting:`, ...items.map((item) => `- ${item.workspace}/${item.id} [${item.type}] ${item.title}${item.agent ? ` (from ${item.agent})` : ""} · since ${item.at.slice(0, 16).replace("T", " ")}`)].join("\n"));
      },
    }),
    defineTool({
      name: "set_workspace_summary",
      description: `Writes the one-sentence description of what a workspace does (max ${CARD_SUMMARY_MAX} characters, in Brazilian Portuguese, plain and concrete: what it produces and for whom). Reversible, no approval needed. If the owner wrote the current sentence yours is saved as a suggestion on the card for them to accept.`,
      input: z.object({ workspace: workspaceField, text: z.string().trim().min(1).max(CARD_SUMMARY_MAX) }),
      call: async ({ workspace, text }) => {
        const card = resolve(deps.cards(), workspace);
        if (!card) return fail(`No workspace "${workspace}". Use list_workspaces.`);
        const stored = await deps.setSummary(card.workspace, text);
        if (stored === "sugestao") return ok(`The owner wrote the sentence of ${card.workspace}, so yours was saved as a suggestion on the card. Do not insist.`);
        if (stored === "igual") return ok("The card already says exactly that.");
        return ok(`Saved. The card of ${card.workspace} now says: ${text}`);
      },
    }),
    ...(deps.today
      ? [
          defineTool({
            name: "get_today",
            description:
              "What is happening today across the platform (grouped by workspace) or in one workspace, computed by code with no AI, waking nobody: work running now with progress, projects in motion (stage N/M, next step, blockers, deadline risk), routines done/running/upcoming/skipped, tracking changes, goal progress, the owner's calendar, items waiting for the owner and what was delivered today. Use it for 'what is going on today?'.",
            input: z.object({ workspace: workspaceField.optional() }),
            call: ({ workspace }) => {
              const only = workspace ? resolve(deps.cards(), workspace) : undefined;
              if (workspace && !only) return fail(`No workspace "${workspace}". Use list_workspaces.`);
              const text = deps.today!(only?.workspace);
              return text === undefined ? fail(`No workspace "${workspace}". Use list_workspaces.`) : ok(text);
            },
          }),
        ]
      : []),
    ...(deps.dayStats
      ? [
          defineTool({
            name: "get_day_stats",
            description: DAY_STATS_DESCRIPTION_PLATFORM,
            input: z.object({ day: dayField, workspace: workspaceField.optional() }),
            call: async ({ day, workspace }) => {
              const only = workspace ? resolve(deps.cards(), workspace) : undefined;
              if (workspace && !only) return fail(`No workspace "${workspace}". Use list_workspaces.`);
              try {
                const text = await deps.dayStats!({ ...(day ? { day } : {}), ...(only ? { workspace: only.workspace } : {}) });
                return text === undefined ? fail(`No workspace "${workspace}". Use list_workspaces.`) : ok(text);
              } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
              }
            },
          }),
        ]
      : []),
    ...(deps.metrics
      ? [
          defineTool({
            name: "get_metrics",
            description: METRICS_DESCRIPTION_PLATFORM,
            input: z.object({ ...metricsFields, workspace: workspaceField.optional() }),
            call: async ({ workspace, ...input }) => {
              const only = workspace ? resolve(deps.cards(), workspace) : undefined;
              if (workspace && !only) return fail(`No workspace "${workspace}". Use list_workspaces.`);
              try {
                const text = await deps.metrics!({ ...input, ...(only ? { workspace: only.workspace } : {}) });
                return text === undefined ? fail(`No workspace "${workspace}". Use list_workspaces.`) : ok(text);
              } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
              }
            },
          }),
        ]
      : []),
    ...(deps.report
      ? [
          defineTool({
            name: "get_report",
            description: REPORT_DESCRIPTION_PLATFORM,
            input: z.object({ ...reportFields, scope: z.enum(["workspace", "platform"]).optional().describe("'workspace' (default; pass `workspace`) or 'platform' (kind 'week' only: the sum of all workspaces plus one block each)"), workspace: workspaceField.optional() }),
            call: async ({ workspace, scope, ...input }) => {
              const platform = scope === "platform";
              if (platform && input.kind !== "week") return fail("The platform report exists only for kind 'week'.");
              if (!platform && !workspace) return fail("Pass `workspace` (see list_workspaces), or scope 'platform' with kind 'week'.");
              const only = workspace ? resolve(deps.cards(), workspace) : undefined;
              if (workspace && !only) return fail(`No workspace "${workspace}". Use list_workspaces.`);
              try {
                const text = await deps.report!({ ...input, scope: platform ? "platform" : "workspace", ...(only ? { workspace: only.workspace } : {}) });
                return text === undefined ? fail(`No workspace "${workspace}". Use list_workspaces.`) : ok(text);
              } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
              }
            },
          }),
        ]
      : []),
    ...(deps.away
      ? [
          defineTool({
            name: "get_away_summary",
            description:
              "What happened while the owner was away (their last absence of 30 minutes or more), computed by code with no AI, waking nobody: tasks finished and failed, new items waiting for the owner, how long agents waited for them, spending in the period, and usage or budget limits reached, grouped by workspace. It is the same summary as the 'while you were away' card. Use it for 'what happened while I was away?'.",
            input: z.object({}),
            call: async () => {
              try {
                return ok(await deps.away!());
              } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
              }
            },
          }),
        ]
      : []),
    defineTool({
      name: "get_usage",
      description: "Shows the owner's subscription usage per engine (5-hour and weekly windows, when they reset), which engines are available, and which agents used the most in the last 5 hours (the Cyno's own usage included).",
      input: z.object({}),
      call: async () => ok(await deps.usageReport()),
    }),
    ...(deps.requests ? requestTools(deps.requests) : []),
  ];
}
