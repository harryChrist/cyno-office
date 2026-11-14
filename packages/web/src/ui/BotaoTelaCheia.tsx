import { forwardRef } from "react";

/** Ícone de "expandir" (quatro cantos para fora) e de "sair" (cantos para dentro). */
function Icone({ ativa }: { ativa: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ativa ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
    </svg>
  );
}

type Props = { ativa: boolean; onClick: () => void; className?: string; testId?: string; disabled?: boolean };

/** O botão de tela cheia (o mesmo na cidade e no Escritório): rótulo e `aria-pressed` conforme o estado. */
export const BotaoTelaCheia = forwardRef<HTMLButtonElement, Props>(function BotaoTelaCheia({ ativa, onClick, className, testId = "tela-cheia", disabled }, ref) {
  const rotulo = ativa ? "Sair da tela cheia" : "Tela cheia";
  return (
    <button ref={ref} type="button" className={className} onClick={onClick} disabled={disabled} aria-label={rotulo} aria-pressed={ativa} title={ativa ? "Sair da tela cheia (Esc)" : "Tela cheia"} data-testid={testId}>
      <Icone ativa={ativa} />
    </button>
  );
});
