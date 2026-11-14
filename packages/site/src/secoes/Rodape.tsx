import { GITHUB, Logo } from "../components/pequenos";

export function Rodape() {
  return (
    <footer className="rodape">
      <div className="wrap rodape-in">
        <div className="rodape-marca">
          <Logo tamanho={24} />
          <span>Cyno</span>
        </div>
        <p>
          Distribuído sob a <a href={`${GITHUB}/blob/main/LICENSE`} rel="noopener">licença MIT</a>. <a href={GITHUB} rel="noopener">Código no GitHub</a>.
        </p>
        <p className="credito">
          O motor de cena e a arte do mapa vêm do projeto de código aberto{" "}
          <a href="https://github.com/marmottajr/habblaud" rel="noopener">
            Habblaud
          </a>
          , de Márcio Junior, sob licença MIT, copiados e adaptados no Cyno. Texto da licença original em{" "}
          <a href="/licencas/cena-LICENSE.txt">/licencas/cena-LICENSE.txt</a>.
        </p>
      </div>
    </footer>
  );
}
