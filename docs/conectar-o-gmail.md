# Conectar o Gmail

Este guia liga o Gmail aos agentes pela **API do Gmail**, que funciona com qualquer conta (inclusive Gmail comum) e não passa por servidor de terceiros. O mesmo passo a passo está dentro do app: **Biblioteca > Conectores (MCP) > Guias > Conectar o Gmail**, com o botão **Criar conector do Gmail**, que abre o formulário já preenchido.

Com o Gmail conectado, os agentes liberados leem e-mails e, se você permitir, criam rascunhos. **Não existe ferramenta de enviar**: o rascunho fica no Gmail para você revisar e enviar. O Google não faz cadastro automático: você cria uma credencial OAuth sua, uma vez, no Google Cloud, e o Cyno entra com a sua conta. Leva uns 15 minutos.

O que você precisa: a conta do Google cujo Gmail os agentes vão usar, acesso ao [Google Cloud Console](https://console.cloud.google.com/) e o Cyno aberto em outra aba. Os nomes dos menus abaixo seguem o Google Cloud em inglês; se o seu console estiver em português, procure o equivalente.

Se a sua conta é Google Workspace inscrita no programa de prévia e você prefere o servidor MCP oficial do Google, veja a última seção, **Servidor MCP oficial do Google (só Google Workspace)**.

O que os agentes ganham (nomes em inglês, como aparecem para eles): `search_threads` (buscar conversas com a sintaxe de busca do Gmail), `get_thread` (ler uma conversa, com anexos listados mas nunca baixados), `list_labels` e `create_draft` (só com a permissão `gmail.compose`). O conteúdo de e-mail é tratado como dado não confiável: as ferramentas avisam o agente de que instruções dentro de e-mails nunca devem ser seguidas.

## A. No Google Cloud

1. **Crie um projeto** (por exemplo, "Cyno Gmail") ou escolha um seu, e confira no topo da página que ele está selecionado.
2. **Ative a Gmail API** (`gmail.googleapis.com`): <https://console.cloud.google.com/apis/library/gmail.googleapis.com>. É a única API necessária. Pela linha de comando: `gcloud services enable gmail.googleapis.com --project=ID_DO_PROJETO`. Depois de ativar, o Google pode levar alguns minutos para valer.
3. **Configure a tela de consentimento.** Em **Google Auth Platform > Branding** (se aparecer "not configured yet", **Get Started**): nome do app, seu e-mail como suporte e contato e, em **Audience**, **External** (**Internal** só para conta de organização Google Workspace, quando a opção existir). Depois, em **Audience > Test users > Add users**, adicione a sua conta. Sem isso o Google bloqueia a entrada.
   - **Modo de teste ou produção.** App novo fica em modo de teste: só entram as contas de Test users e a autorização **cai a cada 7 dias** (você entra de novo). Publicando como **In production** (em Audience) ela não cai; aí o Google mostra o aviso de app não verificado ao entrar: **Avançado** e continuar (o app é seu).
4. **Cadastre as permissões.** Em **Data Access > Add or Remove Scopes > Manually add scopes**, adicione `https://www.googleapis.com/auth/gmail.readonly` (ler e-mails) e `https://www.googleapis.com/auth/gmail.compose` (criar rascunhos; o Google também deixa essa permissão enviar, então marque no Cyno só se quiser rascunhos), com **Add to Table** em cada um, depois **Update** e **Save**. O acesso total (`https://mail.google.com/`) o Cyno não oferece.
5. **Crie a credencial.** Em **Google Auth Platform > Clients > Create Client**: **Application type** = **Web application**, um nome, e em **Authorized redirect URIs** (**+ Add URI**) o endereço de retorno abaixo. **Create**, e copie o **Client ID** e o **Client Secret**.

### Qual endereço de retorno cadastrar

- **`http://localhost:3067/api/library/oauth/callback` (padrão, recomendado).** Funciona qualquer que seja o endereço pelo qual você abre o Cyno e continua valendo se o domínio mudar. Com o Cyno em outra máquina, você cola um endereço de volta no fim do login (passo 9).
- **O endereço do app**, só se você abre o Cyno por `https://` com domínio (não precisa ser público: basta abrir no seu navegador). O formulário mostra o endereço pronto para copiar; escolha "Endereço atual do app". O login termina sozinho.

O Google aceita `http://localhost:<porta>` ou `https://` com domínio e **recusa IP** (por exemplo `http://192.168.0.10:3067`). Pode cadastrar os dois na mesma credencial.

## B. No Cyno: criar o conector

6. Em **Biblioteca > Conectores (MCP) > Guias > Conectar o Gmail**, clique em **Criar conector do Gmail**. O formulário vem com o nome Gmail, o ícone da marca, o seletor **Como falar com o Gmail** em **API do Gmail** e o login com a conta (OAuth); não há endereço para digitar. Se já existe um conector do Gmail, o botão vira **Abrir o conector do Gmail**.
7. Cole o **ID do cliente** e o **Segredo do cliente**. Em **Endereço de retorno**, escolha o mesmo que cadastrou no Google (idêntico). Nas **Permissões**, `gmail.readonly` já vem marcada; marque `gmail.compose` se quiser rascunhos. **Criar e testar**: a janela continua aberta, agora para entrar. O segredo fica só no servidor.

## C. Entrar

8. Clique em **Entrar**. Abre uma aba do Google: escolha a conta (a de Test users) e confirme. Se aparecer o aviso de app não verificado, **Avançado** e continuar.
9. Com o retorno em localhost e o Cyno em outra máquina, o navegador mostra **"página não encontrada"** em `http://localhost:3067/api/library/oauth/callback?…`. **É esperado.** Copie o endereço inteiro da barra, cole no campo **Endereço copiado da barra do navegador** do Cyno e clique em **Concluir**, em até **10 minutos** (o login pendente vale esse tempo). Aparece **Conectado**. Com o endereço do app, ou abrindo o Cyno pelo próprio localhost, termina sozinho.

## D. Testar e liberar

10. **Testar** faz uma chamada de verdade e barata ao Gmail (o perfil da conta), então só passa se o login vale e a Gmail API está ativada no projeto. O cartão mostra as ferramentas (três de leitura, mais `create_draft` se você marcou `gmail.compose`). Se algo estiver barrado, o cartão mostra o motivo.
11. **Liberar…**: marque o workspace e, dentro dele, os agentes que podem usar o Gmail. A credencial é uma só e vale para todos os liberados. O Cyno renova o acesso sozinho; você só entra de novo se o Google recusar a renovação.

## Se der errado

- **O Testar mostra HTTP 403 dizendo que a Gmail API não foi usada ou está desativada.** Falta ativar a Gmail API no projeto (passo 2), com o projeto certo selecionado. Espere alguns minutos e **Testar** de novo. Não precisa entrar de novo; o estado fica em **Erro**, não em "Precisa entrar de novo", e o login continua conectado.
- **Erro 400 `redirect_uri_mismatch`.** O endereço cadastrado no Google é diferente do que o Cyno enviou (porta, `http`/`https` e barra final contam). Corrija em Clients ou troque a escolha no Cyno.
- **`redirect_uri_mismatch` depois da troca de porta padrão (5173 para 3067).** O endereço fixo do modo localhost passou a ser `http://localhost:3067/api/library/oauth/callback`. Quem cadastrou `http://localhost:5173/api/library/oauth/callback` na credencial precisa **cadastrar o novo** em Clients (pode deixar os dois). Se preferir manter a porta antiga, ponha `WEB_PORT=5173` e `PORT=3001` no `.env`. Mesmo assim, o endereço fixo do modo localhost (usado quando você não abre o Cyno por localhost) continua sendo o de 3067; abrindo por `http://localhost:5173`, vale a própria origem.
- **"Acesso bloqueado" ou `access_denied`.** App em modo de teste e a sua conta não está em Audience > Test users. Adicione-a.
- **O Google recusa o endereço de retorno ao salvar.** Era um IP. Use `localhost` ou `https://` com domínio.
- **O Cyno diz que o login expirou ou não está pendente.** Passaram os 10 minutos. Clique em **Entrar** de novo e conclua a tempo.
- **Funcionava e parou depois de uma semana.** Modo de teste: o Google derruba a autorização a cada 7 dias. **Entrar de novo**, ou publique o app como **In production**.
- **Eu já estava logado pelo servidor MCP oficial e o agente recebe "requires that your Google Cloud project is enrolled in the Google Workspace Developer Preview Program".** Esse erro é do servidor MCP oficial, que só atende projetos de contas Google Workspace inscritas no programa de prévia. **Troque para a API do Gmail**: edite o conector, em **Como falar com o Gmail** escolha **API do Gmail** e salve. **Não precisa entrar de novo**: o login (ID, segredo e autorização) é o mesmo. O cartão do conector em modo MCP oficial também tem o botão **Usar a API do Gmail**.
- **Falta a ferramenta de criar rascunho.** Ela só aparece com a permissão `gmail.compose` concedida. Edite o conector, marque a permissão e clique em **Entrar de novo** para o Google conceder.

## Servidor MCP oficial do Google (só Google Workspace)

Este caminho exige uma conta **Google Workspace** com o projeto inscrito no [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview). O formulário de inscrição do Google **não aceita endereço Gmail comum**, só domínio Google Workspace. Com Gmail comum, use a API do Gmail (partes A a D) e ignore esta seção.

Se a sua conta é Workspace e o projeto está inscrito, dá para usar o servidor MCP que o Google mantém (endereço `https://gmailmcp.googleapis.com/mcp/v1`, transporte HTTP, login OAuth 2.0 pelo `accounts.google.com`, 20 permissões). O que muda em relação ao caminho principal:

- No passo 2, ative também a **Gmail MCP API** (`gmailmcp.googleapis.com`): <https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview>. Sem ela toda chamada volta HTTP 403 ("Gmail MCP API has not been used in project … or it is disabled"). Pela linha de comando: `gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=ID_DO_PROJETO`.
- No passo 5, marque **Use this client for an AI-powered agent** (se o cliente já existe e não dá para mudar, crie outro).
- No Cyno, no formulário do Gmail, em **Como falar com o Gmail** escolha **Servidor MCP oficial do Google**. Dá para trocar entre as duas opções a qualquer momento sem entrar de novo.
- O **Testar** desse servidor só lista as ferramentas (ele as lista mesmo sem login ou sem a inscrição). O que prova que funciona é o selo **Conectado** e uma chamada de verdade de um agente liberado. Os nomes dos menus seguem o [guia do Google](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server).
