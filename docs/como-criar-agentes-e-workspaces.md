# Como criar agentes e workspaces

Dá para fazer isso de dois jeitos: **pela UI** (desde a Etapa 5) ou **pela API REST**. As mudanças aparecem em tempo real em todas as abas, via WebSocket. O guia visual da UI, com prints, está em [usando-o-escritorio.md](usando-o-escritorio.md).

# Pela UI

## Sala
1. Clique em **+ Sala** na barra superior.
2. Preencha o **nome** (até 40 caracteres) e escolha o **tema** (Menta, Lavanda, Terracota, Oceano ou Areia). O tema sugerido é o primeiro que nenhuma sala usa ainda.
3. **Criar sala.** O server escolhe sozinho uma célula livre do grid, ao lado das outras salas. A sala já fica selecionada e a câmera foca nela.
- A sala nova nasce **sem ler o Cérebro global** e sem ler outras salas. Mude isso no painel da sala (seção **Cérebro**). As portas são automáticas: ela já tem porta para o lobby e para os vizinhos no grid.
- **Editar** no painel da sala muda nome e tema. **Excluir** pede confirmação e diz quantos times, agentes e tarefas ativas somem junto.
- Não há como escolher nem mudar a posição no grid pela UI; use a API (`gridPosition`).

## Time
1. Selecione a sala: clique nela no canvas (ou, no painel do lobby, em "abrir" ao lado do nome dela). Os botões da barra superior só focam a câmera, não abrem o painel.
2. No painel, seção **Times**, clique em **+ Time**.
3. Preencha **nome** (até 40) e **foco** (até 120, o que o time faz) e clique em **Criar time**.
- Um time sem agentes não recebe tarefas (o server responde 422).
- **Editar:** no bloco do time, **Editar** troca o cabeçalho por um formulário com nome e foco. **Salvar** grava; sem mudança, só fecha.
- **Excluir:** a confirmação lista os agentes que saem junto e quantas tarefas ativas serão canceladas (a mesma cascata da API). O histórico das tarefas continua.
- Mudar o time inteiro de sala não tem UI; use a API (`roomId`, veja abaixo).

## Agente
1. No painel da sala, no bloco do time, clique em **+ Agente**.
2. Preencha **nome** (até 24), **papel** (até 60) e, se quiser, **instruções** (até 2000).
3. Monte o avatar no **editor**:
   - pele (6 tons), cabelo (estilo e cor), acessório (ou nenhum), camisa e calça;
   - **Girar** mostra as 4 direções; **Aleatório** sorteia tudo. O avatar começa sorteado;
   - o preview grande anima e acompanha cada escolha.
4. **Criar agente.** Ele já fica selecionado, ganha mesa, PC e cadeira no pod do time e aparece no canvas com um fade.
- No painel do agente, **Editar** muda nome, papel, instruções e avatar (o canvas troca o sprite na hora). **Excluir** pede confirmação e avisa quantas tarefas ativas serão canceladas.

### Mover um agente de time (ou de sala)
1. Selecione o agente e clique em **Editar** no painel dele.
2. Escolha o time novo no campo **Time**. Os times aparecem agrupados por sala; um time de outra sala muda o agente de sala.
3. **Salvar.** Ele ganha mesa no pod do time novo, e a sala nova vira a "casa" dele na simulação (toda sala é alcançável pelas portas automáticas). O histórico de tarefas vai junto com o agente; o time antigo pode ficar "Sem agentes".
- Com tarefa ativa (na fila, em andamento ou aguardando aprovação), o campo fica travado e mostra o motivo. É a mesma regra da API, que responderia 409.

## Tarefa
- Use a **caixa de tarefa** embaixo da tela: só o pedido. **Enter** envia e **Shift+Enter** quebra a linha. O Maestro escolhe o time (pelas palavras do pedido contra nome, foco, sala e instruções dos agentes) e o server escolhe o agente do time (`routeTask`). A caixa mostra para qual time foi, o motivo e o agente, com um link para o painel dele.
- Pela API, `POST /api/w/<ws>/tasks` com `{ "prompt": "..." }` vai para o Maestro; com `teamId` (e opcionalmente `roomId`), vai direto ao time.
- A sala e o time da caixa seguem o contexto: o agente selecionado (time dele), a sala selecionada ou a sala focada. Se você trocar à mão, a escolha vale até o contexto mudar.
- Aprovar e recusar ficam no painel do agente, na seção **Tarefa atual**.

# Pela API

Os exemplos abaixo usam o proxy do Vite (`:3067`). Direto no server, use `127.0.0.1:3068`.

## Workspace
Um workspace (ex.: "LinkedIn") tem o seu escritório, tarefas e Cérebros, separados dos outros. Pela UI: seletor à esquerda da barra de cima, **+ Novo workspace**. Pela API:
```bash
curl http://localhost:3067/api/workspaces
curl -X POST http://localhost:3067/api/workspaces -H 'content-type: application/json' -d '{"name":"LinkedIn"}'
curl -X PATCH http://localhost:3067/api/workspaces/linkedin -H 'content-type: application/json' -d '{"name":"LinkedIn BR"}'
curl -X DELETE http://localhost:3067/api/workspaces/linkedin   # 409 com tarefa ativa ou se for o último
```
Os exemplos abaixo usam o workspace `principal` (`/api/w/principal/...`). Todo workspace nasce com a Sala do Maestro (time "Gerência" e o agente Maestro), que não pode ser excluída.

## Sala pela API
```bash
curl -X POST http://localhost:3067/api/w/principal/rooms -H 'content-type: application/json' \
  -d '{"name":"ProjetoZ","theme":"ocean","readsGlobalBrain":true}'
```
- `theme` pode ser `mint`, `lavender`, `terracotta`, `ocean` ou `sand`.
- `gridPosition` é opcional. Sem ele, o server escolhe uma célula livre; a (0,0) é reservada ao lobby.
- O id é gerado por slug do nome (`projetoz`, `projetoz-2`…).
- `readsGlobalBrain` é opcional e o padrão é `false`.
- A sala aparece no canvas na hora, na célula do grid dela, com a cor do tema. Ela começa com 10×10 tiles e cresce conforme o número de times e agentes.
- As portas ficam sempre nas paredes de trás: "Lobby" na parede voltada para o lobby, e uma porta para o vizinho a oeste (x−1) ou ao norte (y−1) do grid. São automáticas (não se configuram), ficam fechadas e abrem só enquanto um agente passa.

O que a sala lê do Cérebro (a lista é completa e não é simétrica):
```bash
curl -X PATCH http://localhost:3067/api/w/principal/rooms/projetoz/brain-sharing -H 'content-type: application/json' \
  -d '{"readsBrainsOf":["projetox"],"readsGlobalBrain":false}'
curl http://localhost:3067/api/w/principal/rooms/projetoz/context   # o que os agentes da sala enxergam
```
Para apagar, use `DELETE /api/w/:ws/rooms/:id`. A cascata remove times, agentes, tarefas, o Cérebro e a sala da lista de quem o lia.

## Time
```bash
curl -X POST http://localhost:3067/api/w/principal/teams -H 'content-type: application/json' \
  -d '{"roomId":"projetoz","name":"Backend","focus":"APIs e dados"}'
```

Editar, mudar de sala e excluir (o mesmo que a UI faz, mais o `workspaceId`):
```bash
curl -X PATCH http://localhost:3067/api/w/principal/teams/projetoz-backend -H 'content-type: application/json' -d '{"focus":"APIs, dados e filas"}'
curl -X PATCH http://localhost:3067/api/w/principal/teams/projetoz-backend -H 'content-type: application/json' -d '{"roomId":"projetox"}'   # 409 com tarefas ativas
curl -X DELETE http://localhost:3067/api/w/principal/teams/projetoz-backend   # em cascata: apaga os agentes e cancela as tarefas ativas
```

## Agente
```bash
curl -X POST http://localhost:3067/api/w/principal/agents -H 'content-type: application/json' -d '{
  "teamId":"projetoz-backend","name":"Rafa","role":"Dev backend",
  "instructions":"Seja breve.",
  "avatar":{"skin":"tone3","hair":"curly","hairColor":"ink","shirt":"tomato","pants":"denim"}}'
```
- Os valores válidos de avatar estão em `AVATAR_OPTIONS` (`packages/shared/src/avatar.ts`). O personagem do mapa é montado a partir deles (e das peças do motor, em `Avatar.cena`); confira o resultado no editor de avatar da UI.
- Cada agente ganha mesa, PC e cadeira no pod do time dele.
- Todo agente nasce `idle` e começa a passear pela sala.
- Para mudar de time (também pela UI, no Editar do agente): `PATCH /api/w/:ws/agents/:id` com `{"teamId":"..."}`. O time pode ser de outra sala. Se ele tem tarefas ativas, a resposta é 409.

## Tarefa
```bash
curl -X POST http://localhost:3067/api/w/principal/tasks -H 'content-type: application/json' \
  -d '{"roomId":"projetoz","teamId":"projetoz-backend","prompt":"Revisar a API [aprovar]"}'
curl -X POST http://localhost:3067/api/w/principal/tasks/<id>/approval -H 'content-type: application/json' -d '{"approved":true}'
```
- `[aprovar]` força o pedido de aprovação, e `[falhar]` força uma falha (só no MockRunner).
- Pela UI, use a caixa de tarefa (veja acima).
