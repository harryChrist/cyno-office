import { DAY_MS, MODEL_SAVING_DAYS, usageProviderLabel, type AgentProvider, type ModelSaving, type UsageRecord } from "@cyno/shared";
import { priceRecord } from "../../engines/usage/usage-aggregate";

/**
 * Estimativa de economia ao trocar o modelo de um agente (Gestão, "Trocar modelo"): reprecifica os turnos que o agente
 * fez nos últimos 14 dias com o modelo novo (`priceRecord` com o `model` trocado) e divide por 2 para "por semana". É
 * custo EQUIVALENTE à API, não o que se paga (assinatura). Só estima: quem troca é o dono, pelo `PATCH /agents/:id`.
 * Pura: `now` e os registros vêm de fora.
 */

export type ModelSavingInput = {
  agent: { id: string; name: string; model?: string | undefined };
  /** O modelo que o dono está pensando em usar. */
  model: string;
  /** Os registros de uso (de todos os agentes; a função filtra a janela e o agente). */
  records: readonly UsageRecord[];
  now: number;
  /** Recusa do agente nas últimas semanas (0 a 1) e as decisões que a sustentam. */
  rejection: { rate: number | null; n: number };
  /** Motores com leitura de cota agora (`SubscriptionUsage.provider`): só com a cota conhecida o texto cita a assinatura. */
  quotaProviders?: ReadonlySet<AgentProvider>;
};

const WEEKS = MODEL_SAVING_DAYS / 7;

/** "US$ 4,10" (centavos; abaixo de 1 centavo, "menos de US$ 0,01"). */
export function savingUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs < 0.01) return "menos de US$ 0,01";
  return `US$ ${abs.toFixed(2).replace(".", ",")}`;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function usable(record: UsageRecord): boolean {
  return !record.test && record.measured && record.tokens !== undefined;
}

export function modelSaving(input: ModelSavingInput): ModelSaving {
  const { agent, model, now } = input;
  const from = now - MODEL_SAVING_DAYS * DAY_MS;
  const inWindow = input.records.filter((record) => {
    const at = Date.parse(record.at);
    return at >= from && at <= now;
  });
  const mine = inWindow.filter((record) => record.agentId === agent.id && usable(record));

  let oldUsd = 0;
  let newUsd = 0;
  let counted = 0;
  let skipped = 0;
  const providers = new Map<AgentProvider, number>();
  for (const record of mine) {
    const before = priceRecord(record);
    const after = priceRecord({ ...record, model });
    if (before.suspect || before.cost.usd === null || after.cost.usd === null) {
      skipped += 1;
      continue;
    }
    oldUsd += before.cost.usd;
    newUsd += after.cost.usd;
    counted += 1;
    providers.set(record.provider, (providers.get(record.provider) ?? 0) + before.cost.usd);
  }

  const base = {
    agentId: agent.id,
    agentName: agent.name,
    currentModel: agent.model && agent.model.trim() ? agent.model.trim() : null,
    model,
    days: MODEL_SAVING_DAYS,
    records: counted,
    skipped,
    rejectionRate: input.rejection.rate,
    rejectionN: input.rejection.n,
  };
  const warning =
    input.rejection.rate !== null && input.rejection.n > 0
      ? `Taxa de recusa de ${agent.name} nas últimas semanas: ${percent(input.rejection.rate)} (${input.rejection.n} ${input.rejection.n === 1 ? "decisão" : "decisões"}${input.rejection.n < 5 ? ", poucos dados" : ""}); trocar o modelo pode piorar.`
      : `Sem decisões suas sobre o trabalho de ${agent.name} nas últimas semanas: não há taxa de recusa para comparar; trocar o modelo pode piorar.`;

  if (counted === 0) {
    const note =
      mine.length === 0
        ? `${agent.name} não tem turnos medidos nos últimos ${MODEL_SAVING_DAYS} dias (sem a contagem de tokens não há o que reprecificar).`
        : `Nenhum dos ${mine.length} turnos tem preço conhecido no modelo atual e em “${model}”.`;
    return { ...base, state: "sem_dados", weeklyNowUsd: null, weeklyNewUsd: null, savingPerWeekUsd: null, quotaShare: null, text: "sem dados para estimar", note, quotaText: null, warning };
  }

  const saving = (oldUsd - newUsd) / WEEKS;
  const text = Math.abs(saving) < 0.005 ? "cerca do mesmo custo por semana (equivalente)" : `cerca de ${savingUsd(saving)} a ${saving > 0 ? "menos" : "mais"} por semana (equivalente)`;

  // A fatia da assinatura: a economia dos 14 dias sobre o consumo equivalente de todos os agentes do motor principal do agente.
  let quotaShare: number | null = null;
  let quotaText: string | null = null;
  const main = [...providers].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (main && input.quotaProviders?.has(main)) {
    let total = 0;
    for (const record of inWindow) {
      if (record.provider !== main || !usable(record)) continue;
      const priced = priceRecord(record);
      if (!priced.suspect) total += priced.cost.usd ?? 0;
    }
    if (total > 0) {
      quotaShare = (oldUsd - newUsd) / total;
      const label = usageProviderLabel(main);
      quotaText = Math.abs(quotaShare) < 0.005 ? null : `cerca de ${percent(Math.abs(quotaShare))} ${quotaShare > 0 ? "menos" : "mais"} do consumo da assinatura do ${label} (pelo custo equivalente, não é a leitura da cota)`;
    }
  }
  const note = skipped > 0 ? `${skipped} ${skipped === 1 ? "turno ficou" : "turnos ficaram"} de fora da conta por falta de preço ou de tokens.` : null;
  return { ...base, state: "estimado", weeklyNowUsd: oldUsd / WEEKS, weeklyNewUsd: newUsd / WEEKS, savingPerWeekUsd: saving, quotaShare, text, note, quotaText, warning };
}
