import { headlineAndSummary } from "@cyno/shared";
import { useMemo } from "react";
import "./delivery.css";

/**
 * A manchete (a primeira frase) e o resumo (o último parágrafo de prosa) de um resultado, tirados do texto por
 * código, sem IA. Vai no topo do resultado da tarefa; sem manchete (texto vazio), não desenha nada.
 */
export function DeliveryHead({ text, className, testId = "delivery-head" }: { text: string | undefined; className?: string; testId?: string }) {
  const parts = useMemo(() => headlineAndSummary(text), [text]);
  if (!parts) return null;
  return (
    <div className={className ? `dh ${className}` : "dh"} data-testid={testId}>
      <p className="dh__headline" data-testid={`${testId}-headline`}>
        {parts.headline}
      </p>
      {parts.summary && (
        <p className="dh__summary" data-testid={`${testId}-summary`}>
          {parts.summary}
        </p>
      )}
    </div>
  );
}
