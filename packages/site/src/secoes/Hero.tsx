import { BotaoCopiar, GITHUB, IconeGitHub, Seta } from "../components/pequenos";

const CLONE = "git clone https://github.com/harryChrist/cyno-office.git";

export function Hero() {
  return (
    <section className="hero" id="topo" aria-labelledby="t-hero">
      <div className="wrap hero-in">
        <div className="pilulas entra" style={{ "--i": 0 } as React.CSSProperties}>
          <span className="pilula">
            <i className="ponto" aria-hidden="true" />
            Código aberto, licença MIT
          </span>
          <a className="pilula pilula-link" href="#como-funciona">
            <b className="etiqueta">sem API</b>
            Roda na sua assinatura, sem chave paga
            <Seta />
          </a>
        </div>
        <h1 id="t-hero" className="entra" style={{ "--i": 1 } as React.CSSProperties}>
          Peça ao Maestro. O time de IA cuida do <span className="pixel">resto.</span>
        </h1>
        <p className="lead entra" style={{ "--i": 2 } as React.CSSProperties}>
          O Cyno organiza agentes de IA em times. O Maestro recebe o seu pedido, monta o projeto e distribui as tarefas; cada agente é uma CLI da sua
          assinatura, como o Claude Code ou o Antigravity. Você acompanha tudo num escritório em pixel art e só entra quando pedem a sua aprovação.
        </p>
        <div className="acoes entra" style={{ "--i": 3 } as React.CSSProperties}>
          <a className="btn btn-primario btn-grande" href={GITHUB} rel="noopener">
            <IconeGitHub /> Ver no GitHub
          </a>
          <a className="btn btn-sec btn-grande" href="#instalar">
            Como instalar <Seta />
          </a>
        </div>
        <div className="chip-cmd entra" style={{ "--i": 4 } as React.CSSProperties}>
          <span aria-hidden="true">$</span>
          <code>{CLONE}</code>
          <BotaoCopiar texto={CLONE} />
        </div>
        <ul className="confianca entra" style={{ "--i": 5 } as React.CSSProperties}>
          <li>
            <i className="quad quad-ok" aria-hidden="true" />
            Roda na sua máquina
          </li>
          <li>
            <i className="quad quad-azul" aria-hidden="true" />
            Sem API paga
          </li>
          <li>
            <i className="quad quad-aviso" aria-hidden="true" />
            Docker ou pm2
          </li>
        </ul>
      </div>
    </section>
  );
}
