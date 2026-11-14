import { useRef } from "react";
import { Mapa } from "./components/Mapa";
import { Cabecalho, GITHUB, IconeGitHub, Logo, Revela, Seta } from "./components/pequenos";
import { Aprovacao } from "./secoes/Aprovacao";
import { ComoFunciona } from "./secoes/ComoFunciona";
import { Contribua } from "./secoes/Contribua";
import { Faq } from "./secoes/Faq";
import { Hero } from "./secoes/Hero";
import { Instalar } from "./secoes/Instalar";
import { OQueTem } from "./secoes/OQueTem";
import { Rodape } from "./secoes/Rodape";

function MenuCelular() {
  const ref = useRef<HTMLDetailsElement>(null);
  const fechar = () => ref.current?.removeAttribute("open");
  return (
    <details className="menu-cel" ref={ref}>
      <summary aria-label="Abrir o menu">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" strokeWidth="1.8" strokeLinecap="round">
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </summary>
      <nav className="menu-cel-lista" aria-label="Seções" onClick={fechar}>
        <a href="#como-funciona">Como funciona</a>
        <a href="#aprovacao">Aprovação</a>
        <a href="#o-que-tem">O que tem</a>
        <a href="#instalar">Instalar</a>
        <a href="#faq">Dúvidas</a>
        <a href="#contribuir">Contribuir</a>
      </nav>
    </details>
  );
}

function Topo() {
  return (
    <header className="topo">
      <div className="topo-pilula">
        <a className="marca" href="#topo" aria-label="Cyno, início da página">
          <Logo />
          <span>Cyno</span>
        </a>
        <nav className="menu" aria-label="Seções">
          <a href="#como-funciona">Como funciona</a>
          <a href="#o-que-tem">O que tem</a>
          <a href="#instalar">Instalar</a>
          <a href="#faq">Dúvidas</a>
        </nav>
        <div className="topo-acoes">
          <a className="btn btn-fantasma btn-gh" href={GITHUB} target="_blank" rel="noopener noreferrer">
            <IconeGitHub />
            <span>GitHub</span>
          </a>
          <a className="btn btn-primario btn-peq" href="#instalar">
            Instalar
          </a>
          <MenuCelular />
        </div>
      </div>
    </header>
  );
}

function Contraste() {
  return (
    <section className="secao contraste" aria-labelledby="t-contraste">
      <div className="wrap">
        <Revela>
          <div className="contraste-grade">
            <div className="antes">
              <p className="rotulo rotulo-aviso">Sem o Cyno</p>
              <h2 id="t-contraste">Vários agentes, várias abas, e você no meio fazendo a ponte.</h2>
              <p>Você copia o resultado de um agente para o outro, lembra quem ficou de fazer o quê e só percebe que um deles travou muito depois.</p>
            </div>
            <div className="depois">
              <p className="rotulo">Com o Cyno</p>
              <h3>Um time com Maestro, projetos e um escritório para acompanhar.</h3>
              <ul className="marcas">
                <li>
                  <b className="pt pt-ok" aria-hidden="true" />
                  O Maestro divide o pedido em tarefas e escolhe quem faz cada uma.
                </li>
                <li>
                  <b className="pt pt-aviso" aria-hidden="true" />
                  O que depende de você chega como aprovação, com o texto pronto para revisar.
                </li>
                <li>
                  <b className="pt pt-acento" aria-hidden="true" />
                  No mapa, cada agente aparece trabalhando, esperando ou de folga.
                </li>
              </ul>
              <a className="link-seta" href="#como-funciona">
                Ver como funciona <Seta />
              </a>
            </div>
          </div>
        </Revela>
      </div>
    </section>
  );
}

function ChamadaFinal() {
  return (
    <section className="chamada" aria-labelledby="t-final">
      <div className="wrap">
        <Revela>
          <h2 id="t-final">
            Monte o seu time e faça o primeiro <span className="pixel">pedido.</span>
          </h2>
          <p>Código aberto, licença MIT, na sua máquina e na sua assinatura.</p>
          <div className="acoes">
            <a className="btn btn-primario btn-grande" href="#instalar">
              Como instalar <Seta />
            </a>
            <a className="btn btn-sec btn-grande" href={GITHUB} target="_blank" rel="noopener noreferrer">
              <IconeGitHub /> Ver no GitHub
            </a>
          </div>
        </Revela>
      </div>
    </section>
  );
}

export function App() {
  return (
    <>
      <a className="pular" href="#conteudo">
        Ir para o conteúdo
      </a>
      <Topo />
      <main id="conteudo">
        <Hero />
        <section className="secao secao-mapa" aria-labelledby="t-mapa">
          <div className="wrap wrap-largo">
            <Cabecalho rotulo="O mapa" titulo={<span id="t-mapa">O escritório, rodando agora nesta página.</span>}>
              É o motor de cena do Cyno rodando agora nesta página, com agentes de mentira. No app, cada personagem é um agente de verdade.
            </Cabecalho>
            <Mapa />
          </div>
        </section>
        <Contraste />
        <ComoFunciona />
        <Aprovacao />
        <OQueTem />
        <Instalar />
        <Faq />
        <Contribua />
        <ChamadaFinal />
      </main>
      <Rodape />
    </>
  );
}
