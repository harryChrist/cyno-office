import { OAUTH_LOCAL_REDIRECT_URI, oauthRedirectFor, redirectOriginIssue } from "@cyno/shared";
import { Modal } from "../ui/widgets";
import { GMAIL_API_URL, GMAIL_MCP_URL } from "./connectorView";
import { CopyField } from "./OAuthSection";
import "./oauth.css";
import "./gmailGuide.css";

const SCOPES = [
  { scope: "https://www.googleapis.com/auth/gmail.readonly", note: "ler e-mails; é a única que vem marcada" },
  { scope: "https://www.googleapis.com/auth/gmail.compose", note: "criar rascunhos; o Google também deixa essa permissão enviar, então marque só se quiser rascunhos" },
];
const GMAIL_API_PAGE = "https://console.cloud.google.com/apis/library/gmail.googleapis.com";
const GMAIL_MCP_API_URL = "https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview";
const GOOGLE_DOCS_URL = "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server";
const GOOGLE_PREVIEW_URL = "https://developers.google.com/workspace/preview";

/** Link para fora: abre em outra aba, sem passar o endereço do app nem o controle da janela. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="ui-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="gg-step">
      <h4 className="gg-step__title">{title}</h4>
      <div className="gg-step__body">{children}</div>
    </li>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return (
    <p className={`gg-note gg-note--${tone}`} role="note">
      {children}
    </p>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="gg-problem">
      <h4 className="gg-problem__title">{title}</h4>
      <div className="gg-step__body">{children}</div>
    </li>
  );
}

/** Tutorial completo para ativar o Gmail nos conectores (o Google não faz cadastro automático). `action` é o botão de criar ou abrir o conector. */
export function GmailGuide({ onClose, action }: { onClose: () => void; action?: { label: string; onClick: () => void } }) {
  const origin = window.location.origin;
  const appAddress = oauthRedirectFor("app", origin);
  const appIssue = redirectOriginIssue(origin);
  const actionButton = action && (
    <button type="button" className="ui-button" onClick={action.onClick} data-testid="guide-gmail-action">
      {action.label}
    </button>
  );

  return (
    <Modal title="Conectar o Gmail" onClose={onClose} testId="library-guide-gmail-dialog" wide>
      <div className="gg" data-testid="gmail-guide">
        <header className="gg-intro">
          <p>
            Com o Gmail conectado, os agentes liberados leem os seus e-mails e, se você permitir, criam rascunhos (nunca enviam). O Cyno fala direto com a <strong>API do Gmail</strong>, funciona com <strong>qualquer conta</strong> (inclusive Gmail comum) e não passa por servidor de terceiros. O Google não faz cadastro automático: você cria uma credencial sua, uma vez, e o Cyno entra com a sua conta. Leva uns <strong>15 minutos</strong>.
          </p>
          <div className="gg-need">
            <strong>Você vai precisar de</strong>
            <ul>
              <li>a conta do Google cujo Gmail os agentes vão usar;</li>
              <li>
                acesso ao <Ext href="https://console.cloud.google.com/">Google Cloud Console</Ext> (é grátis para isto);
              </li>
              <li>o Cyno aberto em outra aba, para copiar e colar.</li>
            </ul>
          </div>
          {actionButton && <div className="ui-actions">{actionButton}</div>}
          <Note>
            Os nomes dos menus abaixo seguem o Google Cloud em inglês: se o seu console estiver em português, procure o equivalente. Se você tem uma conta Google Workspace inscrita no programa de prévia e prefere o servidor MCP oficial do Google, veja a seção <button type="button" className="oauth-link" onClick={() => document.getElementById("gmail-guide-mcp")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Servidor MCP oficial do Google (só Google Workspace)
            </button> no fim.
          </Note>
        </header>

        <section className="gg-part" aria-labelledby="gg-a">
          <h3 id="gg-a" className="gg-part__title">
            <span className="gg-part__letter">A</span> No Google Cloud
          </h3>
          <ol className="gg-steps">
            <Step title="Crie um projeto">
              <p>
                No <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud Console</Ext>, crie um projeto novo (por exemplo, “Cyno Gmail”) ou escolha um seu. Confira no topo da página que ele é o projeto selecionado: todos os passos abaixo valem para o projeto escolhido ali.
              </p>
            </Step>
            <Step title="Ative a Gmail API">
              <p>
                Ative <strong>só a Gmail API</strong> (<code>gmail.googleapis.com</code>): <Ext href={GMAIL_API_PAGE}>abrir a página para ativar</Ext>. Confira que o projeto certo está selecionado no topo. Nenhuma outra API é necessária. Depois de ativar, o Google pode levar alguns minutos para valer.
              </p>
              <p>Se você usa a linha de comando do Google Cloud, este comando faz o mesmo:</p>
              <CopyField value="gcloud services enable gmail.googleapis.com --project=ID_DO_PROJETO" label="Comando para ativar a Gmail API" />
            </Step>
            <Step title="Configure a tela de consentimento">
              <p>
                Em <strong>Google Auth Platform</strong> &gt; <strong>Branding</strong> (se aparecer “not configured yet”, clique em <strong>Get Started</strong>): dê um nome ao app (por exemplo, “Cyno Office”), escolha o seu e-mail como e-mail de suporte e de contato, e em <strong>Audience</strong> escolha <strong>External</strong> (use <strong>Internal</strong> só se a sua conta for de uma organização Google Workspace e a opção existir). Aceite a política de dados do Google e conclua.
              </p>
              <p>
                Depois, em <strong>Audience</strong> &gt; <strong>Test users</strong> &gt; <strong>Add users</strong>, adicione a <strong>sua própria conta do Google</strong> e salve. Sem isso o Google bloqueia a entrada.
              </p>
              <Note>
                <strong>Modo de teste ou produção?</strong> Um app novo fica em <strong>modo de teste</strong>: só entram as contas de “Test users” e a autorização <strong>cai a cada 7 dias</strong> (você entra de novo). Para ela não cair, publique o app como <strong>In production</strong> em Audience. Aí o Google mostra o aviso de “app não verificado” ao entrar: clique em <strong>Avançado</strong> e continue (o app é seu). Dá para começar em teste e publicar depois.
              </Note>
            </Step>
            <Step title="Cadastre as permissões (escopos)">
              <p>
                Em <strong>Data Access</strong> &gt; <strong>Add or Remove Scopes</strong>, na caixa <strong>Manually add scopes</strong>, cole os endereços abaixo (clique em <strong>Add to Table</strong> depois de cada um), depois em <strong>Update</strong> e, na página, <strong>Save</strong>:
              </p>
              {SCOPES.map(({ scope, note }) => (
                <div key={scope}>
                  <CopyField value={scope} label={`Escopo ${scope.split("/").pop()}`} />
                  <p className="gg-scope-note">{note}.</p>
                </div>
              ))}
              <p>
                Cadastre os dois no Google; no Cyno você escolhe depois quais usar. O acesso total à caixa (<code>https://mail.google.com/</code>) o Cyno não oferece.
              </p>
            </Step>
            <Step title="Crie a credencial (ID e segredo)">
              <p>
                Em <strong>Google Auth Platform</strong> &gt; <strong>Clients</strong> &gt; <strong>Create Client</strong>:
              </p>
              <ul>
                <li>
                  em <strong>Application type</strong>, escolha <strong>Web application</strong> e dê um nome;
                </li>
                <li>
                  em <strong>Authorized redirect URIs</strong>, clique em <strong>+ Add URI</strong> e cole o endereço de retorno (logo abaixo);
                </li>
                <li>
                  clique em <strong>Create</strong> e copie o <strong>Client ID</strong> (ID do cliente) e o <strong>Client Secret</strong> (segredo). O segredo é como uma senha: não compartilhe.
                </li>
              </ul>
              <p>
                <strong>Endereço de retorno (padrão, recomendado):</strong> funciona qualquer que seja o endereço pelo qual você abre o Cyno e continua valendo se o domínio mudar.
              </p>
              <CopyField value={OAUTH_LOCAL_REDIRECT_URI} label="Endereço de retorno em localhost" testId="guide-redirect-local" />
              <p>
                <strong>Quando usar o endereço do app:</strong> se você abre o Cyno por um endereço <code>https://</code> com domínio (não precisa ser público, basta abrir no seu navegador), pode cadastrar este e escolher “Endereço atual do app” no Cyno. O login então termina sozinho, sem colar nada.
              </p>
              {appIssue ? (
                <Note tone="warn">
                  Você abriu o Cyno agora por <code>{origin}</code>. O Google <strong>recusa endereços com IP</strong> (como <code>http://192.168.0.10:5173</code>) e só aceita <code>http://localhost:&lt;porta&gt;</code> ou <code>https://</code> com domínio. Por isso, aqui, use o endereço de localhost acima.
                </Note>
              ) : (
                <CopyField value={appAddress} label="Endereço de retorno do app" testId="guide-redirect-app" />
              )}
              <p>Vale cadastrar os dois na mesma credencial, se quiser poder escolher depois.</p>
            </Step>
          </ol>
        </section>

        <section className="gg-part" aria-labelledby="gg-b">
          <h3 id="gg-b" className="gg-part__title">
            <span className="gg-part__letter">B</span> No Cyno: criar o conector
          </h3>
          <ol className="gg-steps">
            <Step title="Crie o conector do Gmail">
              <p>
                Use o botão <strong>Criar conector do Gmail</strong> (aqui no topo ou no fim deste guia): ele abre o formulário já com o nome <strong>Gmail</strong>, a opção <strong>API do Gmail</strong> e o login com a conta (OAuth). Não há endereço para digitar. O formulário do Gmail tem o seletor <strong>Como falar com o Gmail</strong>: deixe em “API do Gmail”.
              </p>
              <p>
                Por dentro, o conector guarda só a base da API (<code>{GMAIL_API_URL}</code>) e mostra “API do Gmail” no cartão.
              </p>
            </Step>
            <Step title="Cole o ID e o segredo e escolha as permissões">
              <p>
                Cole o <strong>ID do cliente</strong> e o <strong>Segredo do cliente</strong> que você copiou. Em <strong>Endereço de retorno</strong>, escolha o mesmo que cadastrou no Google (o texto tem de ser idêntico). Nas <strong>Permissões</strong>, <strong>gmail.readonly</strong> (ler) já vem marcada; marque <strong>gmail.compose</strong> se quiser que os agentes criem rascunhos (aviso: no Google essa permissão também permite enviar, mas o Cyno só oferece criar rascunho). Clique em <strong>Criar e testar</strong>: a janela continua aberta, agora para entrar com a conta.
              </p>
            </Step>
          </ol>
        </section>

        <section className="gg-part" aria-labelledby="gg-c">
          <h3 id="gg-c" className="gg-part__title">
            <span className="gg-part__letter">C</span> Entrar com a sua conta
          </h3>
          <ol className="gg-steps">
            <Step title="Autorize no Google">
              <p>
                Clique em <strong>Entrar</strong>. Abre uma aba do Google: escolha a conta (a que está em Test users) e confirme as permissões. Se aparecer o aviso de app não verificado, clique em <strong>Avançado</strong> e continue.
              </p>
            </Step>
            <Step title="Termine o login">
              <p>
                Se você cadastrou o <strong>endereço de localhost</strong> e o Cyno roda em outra máquina, depois de autorizar o navegador mostra <strong>“página não encontrada”</strong> num endereço como:
              </p>
              <CopyField value="http://localhost:5173/api/library/oauth/callback?state=…&code=…" label="Exemplo do endereço que o navegador mostra" />
              <p>
                <strong>É esperado.</strong> Copie o endereço inteiro da barra do navegador, volte ao Cyno, cole no campo <strong>Endereço copiado da barra do navegador</strong> e clique em <strong>Concluir</strong>. Faça isso em até <strong>10 minutos</strong>: o login pendente vale esse tempo. Com o endereço do app (https), ou abrindo o Cyno pelo próprio localhost, o login termina sozinho.
              </p>
              <p>Quando der certo, o selo muda para <strong>Conectado</strong>.</p>
            </Step>
          </ol>
        </section>

        <section className="gg-part" aria-labelledby="gg-d">
          <h3 id="gg-d" className="gg-part__title">
            <span className="gg-part__letter">D</span> Testar e liberar
          </h3>
          <ol className="gg-steps">
            <Step title="Teste a conexão">
              <p>
                Na lista, clique em <strong>Testar</strong>. O teste faz uma chamada de verdade e barata ao Gmail (o perfil da conta), então só passa se o login vale e a Gmail API está ativada no projeto. O cartão mostra as ferramentas: <strong>buscar conversas</strong>, <strong>ler uma conversa</strong> e <strong>listar marcadores</strong>, e <strong>criar rascunho</strong> se você marcou <code>gmail.compose</code>. Se algo estiver barrado, o cartão mostra o motivo.
              </p>
            </Step>
            <Step title="Libere para um workspace e para os agentes">
              <p>
                Conectar não entrega nada a ninguém. Clique em <strong>Liberar…</strong>, marque o workspace e, dentro dele, os agentes que podem usar o Gmail. A credencial é uma só e vale para todos os liberados. O Cyno renova o acesso sozinho; você só entra de novo se o Google recusar a renovação.
              </p>
            </Step>
          </ol>
        </section>

        <section className="gg-part" aria-labelledby="gg-e" id="gmail-guide-troubleshoot">
          <h3 id="gg-e" className="gg-part__title">
            <span className="gg-part__letter gg-part__letter--warn">E</span> Se der errado
          </h3>
          <ul className="gg-problems">
            <Problem title="O Testar mostra erro 403 dizendo que a Gmail API não foi usada ou está desativada">
              <p>
                Falta ativar a <strong>Gmail API</strong> no projeto: <Ext href={GMAIL_API_PAGE}>ative aqui</Ext> com o projeto certo selecionado, espere alguns minutos e clique em <strong>Testar</strong> de novo. Você não precisa entrar de novo: o login estava certo. O Cyno mostra esse motivo no cartão do conector, com o endereço para ativar.
              </p>
            </Problem>
            <Problem title="Erro 400: redirect_uri_mismatch">
              <p>
                O endereço cadastrado no Google é diferente do que o Cyno enviou. Compare, caractere por caractere, o item de “Authorized redirect URIs” com o endereço que o Cyno mostra em <strong>Endereço de retorno</strong>: porta, <code>http</code> ou <code>https</code> e barra final contam. Corrija no Google (em Clients) ou troque a escolha no Cyno. Mudanças no Google podem levar alguns minutos.
              </p>
            </Problem>
            <Problem title="“Acesso bloqueado”: o app não concluiu a verificação, ou 403 access_denied">
              <p>
                Com o app em modo de teste, só entra quem está em <strong>Audience</strong> &gt; <strong>Test users</strong>. Adicione a sua conta e tente de novo.
              </p>
            </Problem>
            <Problem title="O Google recusa o endereço de retorno ao salvar a credencial">
              <p>
                O Google não aceita IP (como <code>http://192.168.0.10:5173</code>). Use <code>http://localhost:5173/api/library/oauth/callback</code> ou um endereço <code>https://</code> com domínio.
              </p>
            </Problem>
            <Problem title="O Cyno diz que o login expirou ou não está pendente">
              <p>
                O login pendente vale 10 minutos. Clique em <strong>Entrar</strong> de novo e conclua dentro desse tempo (cole o endereço da barra do navegador e clique em <strong>Concluir</strong>).
              </p>
            </Problem>
            <Problem title="Funcionava e parou depois de uma semana">
              <p>
                Em modo de teste o Google derruba a autorização a cada 7 dias. Clique em <strong>Entrar de novo</strong>. Para acabar com isso, publique o app como <strong>In production</strong> na tela de consentimento (Audience).
              </p>
            </Problem>
            <Problem title="Eu já estava logado pelo servidor MCP oficial e o agente recebe “requires that your Google Cloud project is enrolled in the Google Workspace Developer Preview Program”">
              <p>
                Esse erro é do servidor MCP oficial: ele só atende projetos de contas Google Workspace inscritas no programa de prévia, e endereço Gmail comum não é aceito. <strong>Troque para a API do Gmail</strong>: edite o conector, em <strong>Como falar com o Gmail</strong> escolha <strong>API do Gmail</strong> e salve. <strong>Você não precisa entrar de novo</strong>: o login (ID, segredo e autorização) é o mesmo. Se faltar alguma ferramenta, confira se a permissão <code>gmail.compose</code> está marcada e entre de novo só nesse caso.
              </p>
            </Problem>
            <Problem title="Falta a ferramenta de criar rascunho">
              <p>
                Ela só aparece com a permissão <code>gmail.compose</code> concedida. Edite o conector, marque a permissão e clique em <strong>Entrar de novo</strong> para o Google conceder.
              </p>
            </Problem>
          </ul>
        </section>

        <section className="gg-part gg-part--aside" aria-labelledby="gg-f" id="gmail-guide-mcp">
          <h3 id="gg-f" className="gg-part__title">
            <span className="gg-part__letter gg-part__letter--muted">F</span> Servidor MCP oficial do Google (só Google Workspace)
          </h3>
          <Note tone="warn">
            Este caminho exige uma conta <strong>Google Workspace</strong> com o projeto inscrito no <Ext href={GOOGLE_PREVIEW_URL}>Google Workspace Developer Preview Program</Ext>. O formulário de inscrição do Google <strong>não aceita endereço Gmail comum</strong>, só domínio Google Workspace. Com Gmail comum, use a API do Gmail (partes A a D) e ignore esta seção.
          </Note>
          <p>
            Se a sua conta é Workspace e o projeto está inscrito, dá para usar o servidor MCP que o Google mantém (<code>{GMAIL_MCP_URL}</code>, 20 permissões). Os passos que mudam em relação ao caminho principal:
          </p>
          <ul className="gg-aside-list">
            <li>
              No passo de ativar APIs, ative também a <strong>Gmail MCP API</strong> (<code>gmailmcp.googleapis.com</code>): <Ext href={GMAIL_MCP_API_URL}>abrir a página para ativar</Ext>. Sem ela toda chamada volta HTTP 403. Pela linha de comando:
              <CopyField value="gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=ID_DO_PROJETO" label="Comando para ativar as duas APIs" />
            </li>
            <li>
              Na credencial, marque <strong>Use this client for an AI-powered agent</strong> (se o cliente já existe e não dá para mudar, crie um novo).
            </li>
            <li>
              No Cyno, no formulário do Gmail, em <strong>Como falar com o Gmail</strong> escolha <strong>Servidor MCP oficial do Google</strong>. Dá para trocar entre as duas opções a qualquer momento sem entrar de novo.
            </li>
            <li>
              O <strong>Testar</strong> desse servidor só lista as ferramentas (ele lista mesmo sem login ou sem a inscrição). O que prova que funciona é o selo <strong>Conectado</strong> e uma chamada de verdade de um agente liberado. Os nomes dos menus seguem o <Ext href={GOOGLE_DOCS_URL}>guia do Google</Ext>.
            </li>
          </ul>
        </section>

        <footer className="gg-foot">
          {actionButton}
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </Modal>
  );
}
