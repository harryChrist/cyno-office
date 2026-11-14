import { addDays } from "@cyno/shared";
import { useEffect, useMemo, useRef } from "react";
import { useOverlayInsets } from "../../hud/useOverlayInsets";
import "./replay.css";
import { PASSO_DO_TECLADO_MS, VELOCIDADES, fracao } from "./modelo";
import { arrastar, alternarTocar, escolherVelocidade, fechar, irParaDia, irParaInstante, reproducaoAtual, useReplayStore } from "./replayStore";
import { BUCKET_MS, hourTicks } from "./reproducao";

const hora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const diaCurto = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone: "America/Sao_Paulo" });
export const horaDe = (t: number): string => hora.format(t);

/** "Hoje", "Ontem" ou "qua., 5 de nov.". */
export function rotuloDoDia(dia: string, hoje: string): string {
  if (dia === hoje) return "Hoje";
  if (dia === addDays(hoje, -1)) return "Ontem";
  return diaCurto.format(Date.parse(`${dia}T15:00:00Z`));
}

/** O gráfico fino sobre a régua: quantos agentes havia (cinza), quantos trabalhavam (verde) e a tarja âmbar de quando alguém esperava o dono. */
function Grafico({ versao }: { versao: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const player = useReplayStore((s) => s.player);
  const de = player?.de ?? 0;
  const ate = player?.ate ?? 0;
  useEffect(() => {
    const canvas = ref.current;
    const reproducao = reproducaoAtual();
    if (!canvas || !reproducao) return;
    const desenhar = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const g = canvas.getContext("2d");
      if (!g || !w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const span = Math.max(1, ate - de);
      const buckets = reproducao.buckets();
      const max = Math.max(1, ...buckets.map((b) => b.present));
      const bw = Math.max(1, (BUCKET_MS / span) * w + 0.5);
      for (const b of buckets) {
        const x = ((b.at - de) / span) * w;
        const hp = Math.round((b.present / max) * (h - 4));
        const hw = Math.round((b.working / max) * (h - 4));
        if (hp) {
          g.fillStyle = "rgba(160, 176, 210, 0.30)";
          g.fillRect(x, h - hp, bw, hp);
        }
        if (hw) {
          g.fillStyle = "rgba(79, 209, 139, 0.85)";
          g.fillRect(x, h - hw, bw, hw);
        }
        if (b.waiting) {
          g.fillStyle = "#ffb547";
          g.fillRect(x, h - Math.max(hp, hw) - 3, bw, 3);
        }
      }
    };
    desenhar();
    if (typeof ResizeObserver !== "function") return;
    const observador = new ResizeObserver(desenhar);
    observador.observe(canvas);
    return () => observador.disconnect();
  }, [versao, de, ate]);
  return <canvas ref={ref} className="replay__chart" aria-hidden="true" data-testid="replay-chart" />;
}

/**
 * O player do "Rever o dia": toca o dia gravado na própria cena do Escritório, com a régua do tempo (e o gráfico dos
 * agentes trabalhando e esperando), as velocidades, a escolha do dia e o "Voltar ao agora". A cena é só para olhar.
 */
export function ReplayPlayer() {
  const { situacao, mensagem, dias, dia, player, semDados, limitado, versao, hoje } = useReplayStore();
  const painel = useRef<HTMLElement>(null);
  useOverlayInsets("replay", painel, "bottom", situacao !== "fechado");
  const pronto = situacao === "pronto" && player !== null;
  const picos = useMemo(() => (pronto ? (reproducaoAtual()?.peaks() ?? []) : []), [pronto, versao]); // eslint-disable-line react-hooks/exhaustive-deps
  const inicioDoDia = player?.de ?? 0;
  const fimDoDia = player?.ate ?? 0;
  const marcas = useMemo(() => hourTicks(inicioDoDia, fimDoDia), [inicioDoDia, fimDoDia]);

  // Sair do Escritório desmonta o player: o replay fecha junto (senão o laço e a classe `is-replay` ficam).
  useEffect(() => () => fechar(), []);

  useEffect(() => {
    if (situacao === "fechado") return;
    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key === "Escape" && !evento.defaultPrevented && !document.querySelector("dialog[open]")) fechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [situacao]);

  if (situacao === "fechado") return null;
  const span = player ? Math.max(1, player.ate - player.de) : 1;
  const h = player ? horaDe(player.t) : "--:--";
  const diaAtual = dias.find((d) => d.day === dia);

  return (
    <>
      {pronto && <div className="replay__vinheta" aria-hidden="true" />}
      {pronto && (
      <div className="replay__selo" role="status" data-testid="replay-badge">
        <span className="replay__selo-bola" aria-hidden="true" />
        <strong>REPLAY</strong>
        <span data-testid="replay-badge-time">{h}</span>
        {dia && dia !== hoje && <span className="replay__selo-dia">{rotuloDoDia(dia, hoje)}</span>}
        <span className="replay__selo-nota">{semDados ? (limitado ? "gravação pausada (limite do dia)" : "sem dados (servidor desligado)") : "só para olhar"}</span>
      </div>
      )}
      <section ref={painel} className="replay" aria-label="Rever o dia" data-testid="replay-player">
        <div className="replay__linha">
          <button type="button" className="replay__tocar" onClick={alternarTocar} disabled={!pronto} aria-label={player?.tocando ? "Pausar" : "Tocar"} title={player?.tocando ? "Pausar" : "Tocar"} data-testid="replay-play">
            {player?.tocando ? "❚❚" : "▶"}
          </button>
          <div className="replay__relogio">
            <strong className="replay__hora" data-testid="replay-time">
              {h}
            </strong>
            {player && <span className="replay__faixa">{`${horaDe(player.de)}–${horaDe(player.ate)}`}</span>}
          </div>
          <select className="replay__dia" value={dia ?? ""} disabled={dias.length === 0} onChange={(e) => irParaDia(e.target.value)} aria-label="Dia gravado" data-testid="replay-day">
            {dias.length === 0 && <option value="">Sem gravação</option>}
            {dias.map((d) => (
              <option key={d.day} value={d.day}>{`${rotuloDoDia(d.day, hoje)} · ${horaDe(d.from)}–${horaDe(d.to)}`}</option>
            ))}
          </select>
          <span className="replay__folga" />
          <div className="replay__velocidades" role="radiogroup" aria-label="Velocidade">
            {VELOCIDADES.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={player?.velocidade === v} className={player?.velocidade === v ? "is-on" : undefined} onClick={() => escolherVelocidade(v)} disabled={!pronto} title={`${v}×: 1 min de reprodução = ${v / 60} h do dia`} data-testid={`replay-speed-${v}`}>
                {v}×
              </button>
            ))}
          </div>
          <button type="button" className="replay__agora" onClick={fechar} data-testid="replay-live" title="Sair do replay e voltar ao escritório de agora (Esc)">
            <span aria-hidden="true">●</span> Voltar ao agora
          </button>
        </div>
        {(situacao !== "pronto" || !player) && (
          <p className="replay__mensagem" role="status" data-testid="replay-message" data-situacao={situacao}>
            {mensagem}
          </p>
        )}
        {pronto && player && (
          <div className="replay__regua" style={{ "--p": `${(fracao(player) * 100).toFixed(2)}%` } as React.CSSProperties}>
            <div className="replay__trilho">
              <Grafico versao={versao} />
              <div className="replay__picos">
                {picos.map((p) => (
                  <button key={p.at} type="button" className="replay__pico" style={{ left: `${((p.at - player.de) / span) * 100}%` }} onClick={() => irParaInstante(p.at)} title={`Pico às ${horaDe(p.at)}: ${p.working} ${p.working === 1 ? "agente trabalhando" : "agentes trabalhando"}`} aria-label={`Pico às ${horaDe(p.at)}`} data-testid="replay-peak" />
                ))}
              </div>
              <input
                className="replay__range"
                type="range"
                min={0}
                max={Math.round(span / 1000)}
                step={PASSO_DO_TECLADO_MS / 1000}
                value={Math.round((player.t - player.de) / 1000)}
                aria-label="Momento da reprodução"
                aria-valuetext={`${h}${diaAtual && dia !== hoje ? `, ${rotuloDoDia(dia!, hoje)}` : ""}`}
                onChange={(e) => arrastar(player.de + Number(e.target.value) * 1000, false)}
                onPointerUp={(e) => arrastar(player.de + Number((e.target as HTMLInputElement).value) * 1000, true)}
                onKeyDown={(e) => {
                  if (e.key === " ") {
                    e.preventDefault();
                    alternarTocar();
                  }
                }}
                data-testid="replay-range"
              />
            </div>
            <div className="replay__horas" aria-hidden="true">
              {marcas.map((t) => (
                <span key={t} style={{ left: `${((t - player.de) / span) * 100}%` }}>
                  {horaDe(t)}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
