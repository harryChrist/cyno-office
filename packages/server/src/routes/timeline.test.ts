import { parseTimeline, type TimelineDaysResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();
const NOW = "2026-11-11T15:00:00.000Z";

describe("API: Rever o dia (timeline)", () => {
  it("dia mal escrito dá 400, recorte inválido dá 400 e dia sem gravação dá 404", async () => {
    const setup = await setupApp({ now: () => new Date(NOW) });
    await call(setup.app, "GET", `${wsApi()}/timeline/2026-11-10`, undefined, 404);
    await call(setup.app, "GET", `${wsApi()}/timeline/ontem`, undefined, 400);
    await call(setup.app, "GET", `${wsApi()}/timeline/2026-11-11?from=a&to=b`, undefined, 400);
  });

  it("o dia gravado aparece na lista e as partes saem em NDJSON, com o quadro completo na frente", async () => {
    const setup = await setupApp({ now: () => new Date(NOW) });
    const runtime = setup.workspaces.get("principal");
    runtime.timeline.tick();
    const days = await call<TimelineDaysResponse>(setup.app, "GET", `${wsApi()}/timeline/days`);
    expect(days.recording).toBe(true);
    expect(days.days).toEqual([expect.objectContaining({ day: "2026-11-11", from: Date.parse(NOW) })]);

    const res = await setup.app.inject({ method: "GET", url: `${wsApi()}/timeline/2026-11-11` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const records = parseTimeline(res.body);
    expect(records[0]).toMatchObject({ t: "k", boot: true });

    const from = Date.parse(NOW) + 1;
    const part = await setup.app.inject({ method: "GET", url: `${wsApi()}/timeline/2026-11-11?from=${from}&to=${from + 3 * 3_600_000}` });
    const slice = parseTimeline(part.body);
    expect(slice).toHaveLength(1);
    expect(slice[0]!.t).toBe("k");
  });
});
