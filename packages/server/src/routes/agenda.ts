import {
  AGENDA_AVAILABILITY_PATH,
  AGENDA_CHECK_PATH,
  AGENDA_PATH,
  availabilityBodySchema,
  checkAgendaBodySchema,
  createAgendaEventBodySchema,
  listAgendaQuerySchema,
  localDateKey,
  localInstant,
  shiftDay,
  updateAgendaEventBodySchema,
  type AgendaEvent,
  type AgendaPostItem,
  type AgendaRefusal,
  type AgendaResponse,
  type AgendaRoutineItem,
  type Availability,
  type SlotCheck,
} from "@cyno/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgendaChange, AgendaService, BookResult } from "../platform/agenda/agenda-service";
import { HttpError } from "../platform/http/errors";
import type { WorkspaceManager } from "../platform/workspaces/manager";

/**
 * Sua agenda (o tempo do dono, uma só para a plataforma). Todas as rotas ficam atrás da senha do app.
 * - GET    /api/agenda?from&to&posts&routines&cancelled -> AgendaResponse (compromissos + camada Postagens de cada workspace + Rotinas opcional + disponibilidade)
 * - POST   /api/agenda                -> AgendaEvent (201) · 409 AgendaRefusal se há choque e o dono não confirmou (`override: true` marca por cima)
 * - PATCH  /api/agenda/:id            -> AgendaEvent (mover/editar; mesma regra do 409)
 * - DELETE /api/agenda/:id            -> AgendaEvent (cancelado; o horário fica livre)
 * - POST   /api/agenda/check          -> SlotCheck (confere um horário sem marcar; a tela usa ao vivo)
 * - GET/PUT /api/agenda/availability  -> Availability (janelas por dia da semana, bloqueios, antecedência, duração e intervalo)
 * Os eventos ao vivo (`agenda:upserted`, `agenda:availability`) saem pelo websocket do Cyno.
 */
export function registerAgendaRoutes(app: FastifyInstance, agenda: AgendaService, manager: Pick<WorkspaceManager, "list" | "find">, now: () => Date): void {
  const owner = { kind: "dono" } as const;

  const refuse = (reply: FastifyReply, outcome: Extract<BookResult, { ok: false }>): AgendaRefusal => {
    reply.code(409);
    return { error: outcome.check.reason, check: outcome.check };
  };

  app.get(AGENDA_PATH, async (request): Promise<AgendaResponse> => {
    const query = listAgendaQuerySchema.parse(request.query ?? {});
    const zone = agenda.getAvailability().timezone;
    const today = localDateKey(now().getTime(), zone);
    const from = query.from ?? today;
    const to = query.to ?? dayKeyPlus(today, 60);
    if (to < from) throw new HttpError(400, "O fim do período não pode ser antes do início");
    const day = (key: string) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8, 10)) });
    const fromMs = localInstant(day(from), 0, 0, zone);
    const toMs = localInstant(shiftDay(day(to).year, day(to).month, day(to).day, 1), 0, 0, zone);
    const workspaces = manager.list().map((workspace) => ({ id: workspace.id, name: workspace.name }));
    const events = agenda.list({ from: fromMs, to: toMs, cancelled: query.cancelled === "1" });
    const posts: AgendaPostItem[] = [];
    if (query.posts !== "0") {
      for (const workspace of workspaces) {
        const runtime = manager.find(workspace.id);
        if (!runtime) continue;
        for (const item of runtime.calendar.list({ from, to })) {
          posts.push({ id: item.id, workspace: workspace.id, workspaceName: workspace.name, title: item.title, date: item.date, ...(item.time ? { time: item.time } : {}), ...(item.endTime ? { endTime: item.endTime } : {}), done: item.done });
        }
      }
    }
    const routines: AgendaRoutineItem[] = [];
    if (query.routines === "1") {
      for (const workspace of workspaces) {
        const runtime = manager.find(workspace.id);
        if (!runtime) continue;
        for (const routine of runtime.routines.list()) {
          for (const slot of runtime.routines.nextOf(routine.id, 60)) {
            const at = Date.parse(slot.at);
            if (at >= fromMs && at < toMs) routines.push({ routineId: routine.id, workspace: workspace.id, workspaceName: workspace.name, title: routine.title, at: slot.at, ...(slot.label ? { label: slot.label } : {}) });
          }
        }
      }
      routines.sort((a, b) => a.at.localeCompare(b.at));
    }
    return { events, posts, routines, availability: agenda.getAvailability(), workspaces };
  });

  app.post(AGENDA_PATH, async (request, reply): Promise<AgendaEvent | AgendaRefusal> => {
    const { override, workspace, ...body } = createAgendaEventBodySchema.parse(request.body ?? {});
    if (workspace && !manager.find(workspace)) throw new HttpError(400, `O workspace "${workspace}" não existe`);
    const outcome = await agenda.book({ ...body, ...(workspace ? { workspace } : {}) }, owner, { override });
    if (!outcome.ok) return refuse(reply, outcome);
    reply.code(201);
    return outcome.event;
  });

  app.patch(`${AGENDA_PATH}/:id`, async (request, reply): Promise<AgendaEvent | AgendaRefusal> => {
    const { id } = request.params as { id: string };
    const { override, ...patch } = updateAgendaEventBodySchema.parse(request.body ?? {});
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nada para mudar");
    const outcome = await agenda.change(id, patch as AgendaChange, owner, { override });
    return outcome.ok ? outcome.event : refuse(reply, outcome);
  });

  app.delete(`${AGENDA_PATH}/:id`, async (request): Promise<AgendaEvent> => {
    const { id } = request.params as { id: string };
    return agenda.cancel(id, owner);
  });

  app.post(AGENDA_CHECK_PATH, async (request): Promise<SlotCheck> => {
    const { start, end, ignoreId } = checkAgendaBodySchema.parse(request.body ?? {});
    return agenda.check({ start, end }, owner, ignoreId);
  });

  app.get(AGENDA_AVAILABILITY_PATH, async (): Promise<Availability> => agenda.getAvailability());

  app.put(AGENDA_AVAILABILITY_PATH, async (request): Promise<Availability> => agenda.setAvailability(availabilityBodySchema.parse(request.body ?? {})));
}

/** "AAAA-MM-DD" daqui a `days` dias. */
function dayKeyPlus(key: string, days: number): string {
  const next = shiftDay(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)), days);
  return `${next.year}-${String(next.month).padStart(2, "0")}-${String(next.day).padStart(2, "0")}`;
}
