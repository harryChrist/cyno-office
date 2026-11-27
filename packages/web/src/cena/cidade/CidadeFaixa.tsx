// A faixa da cidade na página do Cyno: um prédio por workspace, com a fachada mostrando a atividade. Recolhível, acima
// da conversa. Fechada, é só uma linha com o resumo (nada do motor é baixado nem desenhado); aberta, carrega a cidade
// sob demanda e a pausa quando a aba some.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ClicouNaCidade } from "@cyno/cena/cidade";
import { useCynoStore } from "../../store/cynoStore";
import { useNavStore } from "../../store/navStore";
import { enterWorkspace } from "../../pages/cyno/WorkspaceCards";
import { useTelaCheia } from "../../ui/useTelaCheia";
import { CidadeCartao } from "./CidadeCartao";
import { escolherPredio, guardarFaixaAberta, lerFaixaAberta, resumoDaFaixa } from "./cidadeFaixaLogic";
import { guardarLotes, lerLotes, type Lotes } from "./lotes";
import { montarCidade } from "./montarCidade";
import { metaDaSemana, pracaDaCidade } from "./meta";
import { useMetaDaSemana } from "./useMetaDaSemana";
import "./cidade.css";

const CidadeCanvas = lazy(() => import("./CidadeCanvas"));
const EspiarDialog = lazy(() => import("./EspiarDialog"));

/** A aba está visível? (a cidade só roda assim) */
function usePaginaVisivel(): boolean {
  const [visivel, setVisivel] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const mudou = () => setVisivel(!document.hidden);
    document.addEventListener("visibilitychange", mudou);
    return () => document.removeEventListener("visibilitychange", mudou);
  }, []);
  return visivel;
}

/** A meta da semana na praça: mostra "feitas/alvo" e deixa o dono trocar o alvo. */
function MetaEditor({ feitas, alvo, onChange }: { feitas: number | null; alvo: number; onChange: (valor: number) => void }) {
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState(String(alvo));
  const confirmar = () => {
    onChange(Number(rascunho));
    setEditando(false);
  };
  if (!editando) {
    return (
      <div className="cidade__meta" data-testid="cidade-meta">
        <span>
          Meta da semana: {feitas ?? "…"}/{alvo}
        </span>
        <button
          type="button"
          onClick={() => {
            setRascunho(String(alvo));
            setEditando(true);
          }}
          aria-label="Mudar o alvo da meta da semana"
          data-testid="cidade-meta-mudar"
        >
          Mudar
        </button>
      </div>
    );
  }
  return (
    <form
      className="cidade__meta"
      onSubmit={(evento) => {
        evento.preventDefault();
        confirmar();
      }}
      data-testid="cidade-meta"
    >
      <label>
        Alvo{" "}
        <input type="number" min={1} max={9999} value={rascunho} onChange={(evento) => setRascunho(evento.currentTarget.value)} autoFocus data-testid="cidade-meta-alvo" />
      </label>
      <button type="submit">OK</button>
      <button type="button" onClick={() => setEditando(false)}>
        Cancelar
      </button>
    </form>
  );
}

/** `sempreAberta`: a cidade dentro de um painel que a abre sob demanda (não há o que recolher nem o que lembrar). */
export function CidadeFaixa({ sempreAberta = false }: { sempreAberta?: boolean } = {}) {
  const cards = useCynoStore((estado) => estado.cards);
  const carregadas = useCynoStore((estado) => estado.cardsLoaded);
  const atual = useNavStore((estado) => estado.workspaceId);
  const [abertaSalva, setAberta] = useState(() => lerFaixaAberta(typeof window === "undefined" ? 1440 : window.innerWidth));
  const aberta = sempreAberta || abertaSalva;
  const [escolhidoBruto, setEscolhido] = useState<string | null>(null);
  const [espiando, setEspiando] = useState<string | null>(null);
  const visivel = usePaginaVisivel();
  const botaoTelaCheia = useRef<HTMLButtonElement>(null);
  const cheia = useTelaCheia({ classeNaRaiz: "is-mapa-cheio", focoAoSair: () => botaoTelaCheia.current });
  const [lotes, setLotes] = useState<Lotes>(() => lerLotes());

  const cidade = useMemo(() => montarCidade(cards, new Date(), lotes), [cards, lotes]);
  // Os lotes novos entram no estado na própria renderização (ajuste de estado derivado); o efeito só grava.
  if (JSON.stringify(cidade.lotes) !== JSON.stringify(lotes)) setLotes(cidade.lotes);
  useEffect(() => {
    if (Object.keys(cidade.lotes).length > 0) guardarLotes(cidade.lotes);
  }, [cidade.lotes]);

  const idsDosWorkspaces = useMemo(() => cards.map((item) => item.workspace), [cards]);
  const meta = useMetaDaSemana(idsDosWorkspaces, aberta && visivel);
  const praca = useMemo(() => pracaDaCidade(cidade, meta.feitas === null ? null : metaDaSemana(meta.feitas, meta.alvo)), [cidade, meta.feitas, meta.alvo]);

  // Um prédio escolhido que sumiu (workspace apagado) fecha o cartão.
  const escolhido = escolhidoBruto && cards.some((card) => card.workspace === escolhidoBruto) ? escolhidoBruto : null;

  const alternar = () => {
    if (sempreAberta) return;
    const proxima = !aberta;
    setAberta(proxima);
    guardarFaixaAberta(proxima);
    if (!proxima) {
      setEscolhido(null);
      if (cheia.ativa) void cheia.sair();
    }
  };

  const aoClicar = (clique: ClicouNaCidade) => setEscolhido((antes) => escolherPredio(antes, clique.id));
  const card = escolhido ? cards.find((item) => item.workspace === escolhido) : undefined;
  const resumo = escolhido ? cidade.resumos.find((item) => item.id === escolhido) : undefined;
  const resumoTexto = carregadas ? resumoDaFaixa(cidade) : "Carregando os workspaces…";

  return (
    <section className={`cidade${aberta ? " cidade--aberta" : ""}`} aria-label="Cidade dos workspaces" data-testid="cidade-faixa" data-aberta={aberta ? "true" : "false"}>
      <header className="cidade__cabeca">
        <button type="button" className="cidade__alternar" onClick={alternar} aria-expanded={aberta} aria-controls="cidade-corpo" data-testid="cidade-alternar">
          <span className="cidade__seta" aria-hidden="true">
            {aberta ? "▾" : "▸"}
          </span>
          <span className="cidade__titulo">Cidade</span>
        </button>
        <span className="cidade__resumo" data-testid="cidade-resumo">
          {resumoTexto}
        </span>
        {cidade.esperando > 0 && (
          <span className="cidade__selo" title="Itens esperando você, em todos os workspaces">
            {cidade.esperando}
          </span>
        )}
        {aberta && cards.length > 0 && <MetaEditor feitas={meta.feitas} alvo={meta.alvo} onChange={meta.definirAlvo} />}
        {!sempreAberta && (
          <button type="button" className="ui-button ui-button--ghost cidade__ver" onClick={alternar} data-testid="cidade-ver">
            {aberta ? "Recolher" : "Ver a cidade"}
          </button>
        )}
      </header>
      {aberta && (
        <div id="cidade-corpo" className={`cidade__corpo${cheia.ativa ? " cidade__corpo--cheia" : ""}`} data-testid="cidade-corpo" data-tela-cheia={cheia.ativa ? "true" : undefined}>
          {cheia.ativa && (
            <div className="cidade__barra-cheia" data-testid="cidade-barra-cheia">
              <span className="cidade__titulo">Cidade</span>
              <span className="cidade__resumo">{resumoTexto}</span>
              {cidade.esperando > 0 && (
                <span className="cidade__selo" title="Itens esperando você, em todos os workspaces">
                  {cidade.esperando}
                </span>
              )}
              {cards.length > 0 && <MetaEditor feitas={meta.feitas} alvo={meta.alvo} onChange={meta.definirAlvo} />}
              <button type="button" className="ui-button ui-button--secondary ui-button--small cidade__sair" onClick={() => void cheia.sair()} data-testid="cidade-sair-tela-cheia">
                Sair da tela cheia
              </button>
            </div>
          )}
          {cards.length === 0 && carregadas ? (
            <p className="cidade__vazia">A cidade nasce com o primeiro workspace: cada um vira um prédio.</p>
          ) : (
            <Suspense fallback={<p className="cidade__vazia">Abrindo a cidade…</p>}>
              <CidadeCanvas predios={cidade.predios} praca={praca} atual={atual} suspensa={!visivel} aoClicar={aoClicar} fogos={meta.fogos} telaCheia={cheia.ativa} aoAlternarTelaCheia={() => void cheia.alternar()} botaoTelaCheiaRef={botaoTelaCheia} />
            </Suspense>
          )}
          {card && resumo && <CidadeCartao card={card} resumo={resumo} atual={card.workspace === atual} onEntrar={() => enterWorkspace(card.workspace)} onEspiar={() => setEspiando(card.workspace)} onFechar={() => setEscolhido(null)} />}
        </div>
      )}
      {espiando && (
        <Suspense fallback={null}>
          <EspiarDialog workspaceId={espiando} nome={cards.find((item) => item.workspace === espiando)?.name ?? espiando} onFechar={() => setEspiando(null)} />
        </Suspense>
      )}
    </section>
  );
}
