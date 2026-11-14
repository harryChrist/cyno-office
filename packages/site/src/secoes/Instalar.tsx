import { useRef, useState } from "react";
import { BotaoCopiar, Cabecalho, Revela } from "../components/pequenos";

const COMANDOS = {
  docker: {
    nome: "Docker",
    codigo: `git clone https://github.com/harryChrist/cyno-office.git
cd cyno-office
docker compose up -d --build
docker compose exec cyno claude`,
    nota: "O último comando faz o login da sua assinatura do Claude Code, uma vez. Para ver o código de primeiro acesso:",
    codigoNota: "docker compose exec cyno npm run auth:code",
  },
  pm2: {
    nome: "pm2",
    codigo: `git clone https://github.com/harryChrist/cyno-office.git
cd cyno-office
npm install
npm i -g pm2
npm run pm2:start`,
    nota: "Tenha ao menos uma CLI de agente instalada e logada, como o claude. Para ver o código de primeiro acesso:",
    codigoNota: "npm run auth:code",
  },
} as const;

type Chave = keyof typeof COMANDOS;

export function Instalar() {
  const [aba, setAba] = useState<Chave>("docker");
  const ref = useRef<HTMLElement>(null);
  const atual = COMANDOS[aba];
  return (
    <section className="secao" id="instalar" aria-labelledby="t-instalar">
      <div className="wrap wrap-estreito">
        <Cabecalho rotulo="Instalar" titulo={<span id="t-instalar">Quatro comandos e o escritório abre.</span>}>
          Precisa de Node 22.12 ou mais novo (pm2) ou de Docker com Compose v2. Com a instalação feita, abra o endereço da porta 5173. Sem senha, o app fica
          fechado e pede um código de primeiro acesso, que só o servidor mostra.
        </Cabecalho>
        <Revela>
          <div className="instalar-caixa">
            <div className="abas" role="tablist" aria-label="Forma de instalar">
              {(Object.keys(COMANDOS) as Chave[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  id={`aba-${k}`}
                  aria-selected={aba === k}
                  aria-controls="painel-instalar"
                  tabIndex={aba === k ? 0 : -1}
                  onClick={() => setAba(k)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      const prox: Chave = k === "docker" ? "pm2" : "docker";
                      setAba(prox);
                      document.getElementById(`aba-${prox}`)?.focus();
                    }
                  }}
                >
                  {COMANDOS[k].nome}
                </button>
              ))}
            </div>
            <div id="painel-instalar" role="tabpanel" aria-labelledby={`aba-${aba}`} className="painel">
              <div className="painel-topo">
                <span>Terminal</span>
                <BotaoCopiar texto={atual.codigo} alvo={ref} />
              </div>
              <pre>
                <code ref={ref}>{atual.codigo}</code>
              </pre>
              <p className="nota">
                {atual.nota} <code>{atual.codigoNota}</code>
              </p>
            </div>
          </div>
        </Revela>
        <p className="nota-fora">Mais detalhes, variáveis e o passo a passo do Docker estão em docs/como-rodar.md, no repositório.</p>
      </div>
    </section>
  );
}
