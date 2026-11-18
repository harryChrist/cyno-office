import type { BrainSummary } from "@cyno/shared";
import { useState } from "react";
import { api } from "../../api/client";
import { ConfirmDialog } from "../../ui/widgets";
import { brainWeight, weightLabel } from "./brainView";

/**
 * Ações do Cérebro inteiro (hoje só "Organizar"), no cabeçalho da coluna de notas. O clique NÃO pede
 * nada: abre uma confirmação, e só "Pedir ao Maestro" chama o server. A proposta chega em Aprovações.
 */
export function BrainActions({ brain }: { brain: BrainSummary }) {
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const weight = weightLabel(brainWeight(brain.notes));

  return (
    <div className="brain-actions" data-testid="brain-actions">
      <div className="brain-actions__row">
        <button
          type="button"
          className="ui-button ui-button--small ui-button--secondary"
          onClick={() => {
            setSent(false);
            setAsking(true);
          }}
          data-testid="brain-organize"
        >
          Organizar
        </button>
        <p className="brain-actions__weight" data-testid="brain-weight">
          {weight}
        </p>
      </div>
      {sent && (
        <p className="brain-actions__notice" role="status" data-testid="brain-organize-notice">
          Pedido enviado. A proposta aparece em Aprovações quando o Maestro terminar.
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={`Organizar o Cérebro de ${brain.name}?`}
          message={
            <>
              <p>O Maestro vai ler as notas {brain.kind === "lobby" ? "deste workspace" : "desta sala"} e montar uma proposta: o que vira regra, o que pode virar um resumo e o que vai para o histórico.</p>
              <p>Nada muda agora. A proposta chega em Aprovações e só é aplicada se você aprovar. Nada é apagado.</p>
              <p>Usa o Maestro, então gasta um pouco da sua cota.</p>
            </>
          }
          confirmLabel="Pedir ao Maestro"
          pendingLabel="Pedindo…"
          tone="success"
          testId="brain-organize-confirm"
          onConfirm={async () => {
            await api.organizeBrain(brain.id);
            setSent(true);
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
