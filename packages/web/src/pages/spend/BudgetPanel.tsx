import { BUDGET_PERIOD_LABELS, BUDGET_PERIODS, type BudgetLimits, type BudgetPeriod, type UpdateBudgetBody } from "@cyno/shared";
import { useId, useState } from "react";
import { describeError } from "../../api/client";
import { useBudget, useBudgetStore } from "../../store/budgetStore";
import "./budget.css";
import { formatMoney, inCurrency, type Currency } from "./spendView";
import { budgetBodyOf, budgetFormOf, budgetRows, budgetSummary, type BudgetForm, type BudgetRow } from "./budgetView";

/** A barra de um período: consumo do orçamento (cores como as do uso do plano: ok, aviso a partir de 50%, perigo a partir de 80%). */
export function BudgetBar({ row }: { row: BudgetRow }) {
  return (
    <div className={`budget-row budget-row--${row.tone}`} data-testid={`budget-row-${row.period}`} data-step={row.step}>
      <div className="budget-row__head">
        <span className="budget-row__title">{row.title}</span>
        <span className="budget-row__amounts ui-tabular">{row.amounts}</span>
        <span className="budget-row__percent ui-tabular">{row.percentText}</span>
      </div>
      <div className="budget-row__track" role="progressbar" aria-label={`Orçamento: ${row.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.width)}>
        <div className="budget-row__fill" style={{ width: `${row.width}%` }} />
        <span className="budget-row__mark" aria-hidden="true" />
      </div>
      {row.note && <p className="budget-row__note">{row.note}</p>}
    </div>
  );
}

/**
 * O orçamento de consumo na aba Gastos: a barra de cada período com limite e o formulário (dia, semana,
 * mês, em dólar equivalente). Só avisa (a 80% e a 100%, uma vez por período), nunca trava o trabalho.
 * Sem orçamento definido, mostra só o convite para definir.
 */
export function BudgetPanel({ money }: { money: (usd: number) => string }) {
  const { budget, error } = useBudget();
  const save = useBudgetStore((state) => state.save);
  const [editing, setEditing] = useState(false);
  const rows = budgetRows(budget, money);
  const hasLimits = budget !== null && Object.keys(budget.limits).length > 0;

  return (
    <section className="budget" aria-labelledby="budget-title" data-testid="budget-panel">
      <div className="budget__head">
        <h3 id="budget-title" className="budget__title">
          Orçamento
        </h3>
        <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => setEditing((open) => !open)} aria-expanded={editing} data-testid="budget-edit">
          {editing ? "Fechar" : hasLimits ? "Editar" : "Definir orçamento"}
        </button>
      </div>
      {error && !budget && (
        <p className="spend__error" role="alert">
          {error}
        </p>
      )}
      {!editing && budget && !hasLimits && <p className="budget__empty">Sem orçamento. Defina um para ser avisado.</p>}
      {rows.length > 0 && (
        <div className="budget__rows" data-testid="budget-rows">
          {rows.map((row) => (
            <BudgetBar key={row.period} row={row} />
          ))}
        </div>
      )}
      {editing && budget && (
        <BudgetEditor
          limits={budget.limits}
          onSave={async (body) => {
            await save(body);
            setEditing(false);
          }}
        />
      )}
      <p className="budget__note">
        Valores equivalentes à API, não é o que você paga. O orçamento só avisa (a 80% e a 100%, uma vez por período): nunca trava nem para o trabalho. Soma todos os
        workspaces.
      </p>
    </section>
  );
}

function BudgetEditor({ limits, onSave }: { limits: BudgetLimits; onSave: (body: UpdateBudgetBody) => Promise<void> }) {
  const baseId = useId();
  const [form, setForm] = useState<BudgetForm>(() => budgetFormOf(limits));
  // O aviso vale só para o formulário em que apareceu: mexer num campo o apaga.
  const [note, setNote] = useState<{ text: string; form: BudgetForm } | null>(null);
  const message = note && note.form === form ? note.text : null;
  const setMessage = (text: string | null) => setNote(text === null ? null : { text, form });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const parsed = budgetBodyOf(form, limits);
    if ("error" in parsed) {
      setMessage(parsed.error);
      return;
    }
    if (Object.keys(parsed.body).length === 0) {
      setMessage("Nada mudou.");
      return;
    }
    setBusy(true);
    try {
      await onSave(parsed.body);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="budget-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="budget-form"
    >
      <div className="budget-form__fields">
        {BUDGET_PERIODS.map((period: BudgetPeriod) => (
          <label key={period} htmlFor={`${baseId}-${period}`} className="budget-form__field">
            <span>Por {BUDGET_PERIOD_LABELS[period].name}</span>
            <span className="budget-form__input">
              <span aria-hidden="true">US$</span>
              <input
                id={`${baseId}-${period}`}
                className="ui-input ui-input--compact ui-tabular"
                inputMode="decimal"
                placeholder="sem limite"
                value={form[period]}
                onChange={(event) => setForm({ ...form, [period]: event.target.value })}
                data-testid={`budget-input-${period}`}
              />
            </span>
          </label>
        ))}
      </div>
      <div className="budget-form__actions">
        <button type="submit" className="ui-button ui-button--small" disabled={busy} data-testid="budget-save">
          Salvar
        </button>
        <span className="budget-form__hint">Deixe vazio para tirar o limite daquele período.</span>
        {message && (
          <span className="budget-form__message" role="alert">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

/** A moeda que o dono escolheu na página Gastos (a mesma chave); o padrão é o real. */
function chosenCurrency(): Currency {
  try {
    return window.localStorage.getItem("agent-office:gastos-moeda") === "USD" ? "USD" : "BRL";
  } catch {
    return "BRL";
  }
}

/** Uma faixa para o Painel da Gestão: a barra de cada período com limite. Sem orçamento, não aparece. */
export function BudgetStrip() {
  const { budget } = useBudget();
  const currency = chosenCurrency();
  const rate = budget?.usdBrl ?? 0;
  const rows = budgetRows(budget, (usd) => formatMoney(inCurrency(usd, currency, rate), currency));
  if (rows.length === 0) return null;
  return (
    <section className="budget budget--strip" aria-label="Orçamento de consumo" data-testid="budget-strip">
      <div className="budget__head">
        <h3 className="budget__title">Orçamento</h3>
        <span className="budget__summary ui-tabular">{budgetSummary(rows)}</span>
      </div>
      <div className="budget__rows">
        {rows.map((row) => (
          <BudgetBar key={row.period} row={row} />
        ))}
      </div>
    </section>
  );
}
