import { Cabecalho, GITHUB, Revela, Seta } from "../components/pequenos";

const BASE = `${GITHUB}/blob/main`;

const PASSOS = [
  {
    t: "Fork e branch a partir do dev",
    d: "Dê à branch o nome tipo/descricao-curta (feat/, fix/, docs/). A main é a estável, a que o site publica; o seu PR vai para o dev.",
  },
  {
    t: "Rode as checagens",
    d: "O CI roda as mesmas três e o build do web e do site, e um PR com falha não é revisado.",
    codigo: "npm run typecheck\nnpm run lint\nnpm test",
  },
  {
    t: "Abra o PR",
    d: "Commits no padrão Conventional Commits. Se a mudança aparece na interface, anexe prints do laboratório (npm run lab:up).",
  },
];

export function Contribua() {
  return (
    <section className="secao secao-compacta" id="contribuir" aria-labelledby="t-contribuir">
      <div className="wrap">
        <Cabecalho rotulo="Código aberto" titulo={<span id="t-contribuir">Quer ajudar? O caminho está escrito.</span>}>
          O Cyno é MIT e aceita contribuições. O guia completo está no CONTRIBUTING.md; aqui vai o essencial.
        </Cabecalho>
        <Revela>
          <ol className="contrib-passos">
            {PASSOS.map((p, i) => (
              <li key={p.t}>
                <span className="pixel contrib-n" aria-hidden="true">
                  0{i + 1}
                </span>
                <h3>{p.t}</h3>
                <p>{p.d}</p>
                {p.codigo ? (
                  <pre>
                    <code>{p.codigo}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
          <ul className="contrib-notas">
            <li>
              <b>Mudança grande?</b> Abra uma issue antes, com o modelo "Ideia", e espere uma resposta.
            </li>
            <li>
              <b>Bug?</b> Use o modelo "Bug" e cole logs sem segredos.
            </li>
            <li>
              <b>Falha de segurança?</b> Não abra issue pública: o relato é privado, pela aba Security do GitHub.
            </li>
            <li>
              <b>Regra do projeto:</b> sem chave de API paga e sem dados pessoais no código, nos testes e nos prints.
            </li>
          </ul>
          <div className="contrib-links">
            <a className="btn btn-primario" href={`${BASE}/CONTRIBUTING.md`} target="_blank" rel="noopener noreferrer">
              Ler o CONTRIBUTING <Seta />
            </a>
            <a className="btn btn-sec" href={`${BASE}/CODE_OF_CONDUCT.md`} target="_blank" rel="noopener noreferrer">
              Código de Conduta
            </a>
            <a className="btn btn-sec" href={`${BASE}/SECURITY.md`} target="_blank" rel="noopener noreferrer">
              SECURITY.md
            </a>
            <a className="btn btn-sec" href={`${GITHUB}/issues`} target="_blank" rel="noopener noreferrer">
              Issues
            </a>
          </div>
        </Revela>
      </div>
    </section>
  );
}
