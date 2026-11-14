// O cartão curto do prédio que o dono clicou na cidade: o que o workspace faz, quem trabalha, o que espera o dono,
// e os dois caminhos: Entrar (abre o Escritório dele) e Espiar (só olhar).
import type { Card } from "@cyno/shared";
import { maestroStatusLabel, waitingBadge } from "../../pages/cyno/cynoHome";
import type { ResumoDoPredio } from "./montarCidade";

/** Quem está trabalhando agora (o Maestro conta). */
export function quemTrabalha(card: Card): string[] {
  const nomes = card.team.agents.filter((agente) => agente.terminal === "busy").map((agente) => agente.name);
  return card.team.maestro.status === "ocupado" ? ["Maestro", ...nomes] : nomes;
}

export function CidadeCartao({ card, resumo, atual, onEntrar, onEspiar, onFechar }: { card: Card; resumo: ResumoDoPredio; atual: boolean; onEntrar: () => void; onEspiar: () => void; onFechar: () => void }) {
  const quem = quemTrabalha(card);
  const espera = waitingBadge(card);
  const frase = card.summary.summary;
  const time = card.team.agents.length;
  return (
    <aside className="cidade-cartao" aria-label={`Prédio ${card.name}`} data-testid="cidade-cartao" data-workspace={card.workspace}>
      <header className="cidade-cartao__topo">
        <h3 className="cidade-cartao__nome">{card.name}</h3>
        {atual && <span className="cidade-cartao__aberto">aberto agora</span>}
        <button type="button" className="cidade-cartao__fechar" onClick={onFechar} aria-label="Fechar o cartão" title="Fechar">
          ×
        </button>
      </header>
      <p className={`cidade-cartao__frase${frase ? "" : " cidade-cartao__frase--vazia"}`}>{frase || "Ainda sem a frase do que este workspace faz."}</p>
      <dl className="cidade-cartao__dados">
        <div>
          <dt>Agentes</dt>
          <dd>
            {time === 0 ? "Só o Maestro" : `${time} no time + Maestro`}
            <span className="cidade-cartao__sub"> · {maestroStatusLabel(card.team.maestro.status).toLowerCase()}</span>
          </dd>
        </div>
        <div>
          <dt>Trabalhando</dt>
          <dd data-testid="cidade-cartao-trabalhando">{quem.length > 0 ? quem.join(", ") : "ninguém agora"}</dd>
        </div>
        {espera && (
          <div className="cidade-cartao__espera">
            <dt>Espera você</dt>
            <dd data-testid="cidade-cartao-espera">{espera}</dd>
          </div>
        )}
        {resumo.parado && (
          <div>
            <dt>Estado</dt>
            <dd>parado (prédio apagado)</dd>
          </div>
        )}
      </dl>
      <div className="cidade-cartao__acoes">
        <button type="button" className="ui-button cidade-cartao__entrar" onClick={onEntrar} data-testid="cidade-entrar">
          Entrar
        </button>
        <button type="button" className="ui-button ui-button--ghost" onClick={onEspiar} data-testid="cidade-espiar">
          Espiar
        </button>
      </div>
    </aside>
  );
}
