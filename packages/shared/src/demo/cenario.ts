// O escritório de mentira da demonstração: salas, times, agentes, projetos e os textos que eles usam. Dados fixos
// (nada aleatório aqui); a vida vem do simulador (`office.ts`). Tudo em português, sem dado de ninguém.
import type { Agent, Avatar, Room, Team } from "../types";
import type { Project, ProjectTask } from "../projects";
import type { Sprint } from "../sprints";

// Não pode ser o id de um workspace de verdade: a criação de workspace usa `slugify` (só `a-z`, `0-9` e `-`), então um id
// com sublinhados nunca existe de verdade e a demonstração não esbarra em dados do navegador de um workspace real.
export const DEMO_WORKSPACE_ID = "__demonstracao__";
export const DEMO_WORKSPACE_NAME = "Demonstração";

const room = (id: string, name: string, kind: Room["kind"], x: number, y: number, theme: string): Room => ({ id, kind, name, theme, gridPosition: { x, y }, readsGlobalBrain: true, readsBrainsOf: [] });

export const DEMO_ROOMS: readonly Room[] = [room("sala-maestro", "Maestro", "maestro", 0, 0, "ocean"), room("sala-marketing", "Marketing", "team", 1, 0, "mint"), room("sala-produto", "Produto", "team", 2, 0, "lavender"), room("sala-conteudo", "Conteúdo", "team", 3, 0, "sand")];

export const DEMO_TEAMS: readonly Team[] = [
  { id: "time-gerencia", roomId: "sala-maestro", name: "Gerência", focus: "Receber os pedidos e distribuir", leadAgentId: "lia" },
  { id: "time-social", roomId: "sala-marketing", name: "Redes sociais", focus: "Posts e respostas", leadAgentId: "caio" },
  { id: "time-campanhas", roomId: "sala-marketing", name: "Campanhas", focus: "Campanhas e e-mails", leadAgentId: "eva" },
  { id: "time-produto", roomId: "sala-produto", name: "Produto", focus: "Fluxos e especificações", leadAgentId: "davi" },
  { id: "time-video", roomId: "sala-conteudo", name: "Vídeo", focus: "Roteiros e edição", leadAgentId: "mara" },
];

const avatar = (skin: string, hair: string, hairColor: string, shirt: string, pants: string, accessory?: string): Avatar => ({ skin, hair, hairColor, shirt, pants, ...(accessory ? { accessory } : {}) });

type Persona = { id: string; teamId: string; name: string; role: string; avatar: Avatar };
export const DEMO_PERSONAS: readonly Persona[] = [
  { id: "lia", teamId: "time-gerencia", name: "Lia", role: "Maestro", avatar: avatar("tone3", "bun", "ink", "navy", "charcoal", "headphones") },
  { id: "caio", teamId: "time-social", name: "Caio", role: "Social media", avatar: avatar("tone2", "short", "wood-dark", "tomato", "denim") },
  { id: "bia", teamId: "time-social", name: "Bia", role: "Redatora", avatar: avatar("tone5", "curly", "ink", "mustard", "navy", "glasses") },
  { id: "eva", teamId: "time-campanhas", name: "Eva", role: "Campanhas", avatar: avatar("tone4", "long", "wood", "mint", "charcoal") },
  { id: "gui", teamId: "time-campanhas", name: "Gui", role: "Analista de dados", avatar: avatar("tone1", "buzz", "stone", "ocean", "slate", "glasses") },
  { id: "davi", teamId: "time-produto", name: "Davi", role: "Product manager", avatar: avatar("tone3", "short", "ink", "denim", "wood") },
  { id: "isis", teamId: "time-produto", name: "Ísis", role: "Designer de produto", avatar: avatar("tone6", "ponytail", "ink", "lavender", "navy") },
  { id: "leo", teamId: "time-produto", name: "Léo", role: "Pesquisa com usuários", avatar: avatar("tone2", "mohawk", "rose", "leaf", "charcoal", "cap") },
  { id: "mara", teamId: "time-video", name: "Mara", role: "Roteirista", avatar: avatar("tone5", "bun", "wood-dark", "wine", "slate") },
  { id: "nico", teamId: "time-video", name: "Nico", role: "Editor de vídeo", avatar: avatar("tone4", "bald", "ink", "cream", "denim", "headphones") },
];

export function demoAgents(): Agent[] {
  return DEMO_PERSONAS.map((p) => ({ id: p.id, teamId: p.teamId, name: p.name, role: p.role, instructions: "", avatar: p.avatar, status: "idle" as const, engine: "gemini" as const, model: "gemini-3.8-flash-medium" }));
}

/** O que cada sala faz nos pedidos de fim de dia (os títulos das tarefas avulsas). */
export const TITULOS_POR_TIME: Record<string, readonly string[]> = {
  "time-gerencia": ["Triagem dos pedidos da manhã", "Resumo do que o time entregou", "Priorizar a fila de revisões"],
  "time-social": ["Post sobre a promoção de dezembro", "Responder comentários do último post", "Legenda para o carrossel de dicas", "Ideias de enquete para os stories", "Agenda de posts da semana"],
  "time-campanhas": ["E-mail de lançamento da campanha", "Segmentar a lista de clientes ativos", "Relatório de abertura dos e-mails", "Teste A/B do assunto do e-mail", "Pesquisa de palavras-chave"],
  "time-produto": ["Revisar o fluxo de cadastro", "Especificar os filtros da busca", "Mapear dúvidas do suporte", "Protótipo da tela de preferências", "Critérios de aceite do checkout"],
  "time-video": ["Roteiro do vídeo de 30 segundos", "Legendas do vídeo de boas-vindas", "Cortes para o reels de quinta", "Trilha e ritmo do teaser", "Storyboard da série curta"],
};

/** O que o agente anuncia enquanto trabalha (a mensagem de andamento da tarefa). */
export const ANDAMENTOS: readonly string[] = ["Pesquisando referências", "Montando o primeiro rascunho", "Revisando o texto", "Organizando as informações", "Conferindo os números", "Ajustando o tom da mensagem", "Preparando a entrega"];

/** Ferramentas que aparecem na cena (nome bruto + entrada, para a frase "Lendo App.tsx" sair do mesmo código do real). */
export const FERRAMENTAS: readonly { name: string; input: Record<string, unknown> }[] = [
  { name: "Read", input: { file_path: "/projeto/briefing.md" } },
  { name: "Read", input: { file_path: "/projeto/metricas.csv" } },
  { name: "Grep", input: { pattern: "campanha" } },
  { name: "Edit", input: { file_path: "/projeto/rascunho.md" } },
  { name: "Write", input: { file_path: "/projeto/roteiro.md" } },
  { name: "WebSearch", input: { query: "tendências de conteúdo curto" } },
  { name: "Bash", input: { command: "npm run build", description: "Gerar a prévia" } },
  { name: "WebFetch", input: { url: "https://exemplo.com/referencia" } },
];

export const SUBAGENTES: readonly { label: string; goal: string }[] = [
  { label: "Pesquisa rápida", goal: "Buscar três referências parecidas" },
  { label: "Revisão de texto", goal: "Conferir erros e tom do rascunho" },
  { label: "Conferência de números", goal: "Somar e comparar com a semana passada" },
];

/** Tipos de aprovação (do `LEGACY_FOR_YOU_TYPES`) e o que cada pedido pergunta. */
export const APROVACOES: readonly { type: string; where: string; title: string; text: string }[] = [
  { type: "post", where: "Instagram", title: "Post sobre a promoção de dezembro", text: "Dezembro chegou com frete grátis em todo o site. Aproveite até domingo!" },
  { type: "mensagem", where: "E-mail", title: "E-mail de lançamento da campanha", text: "Olá! A campanha de fim de ano começa amanhã e você sai na frente com 15% de desconto." },
  { type: "comentario", where: "Comentário no blog", title: "Resposta ao comentário da Camila", text: "Obrigada pelo carinho, Camila! Em breve teremos mais conteúdo sobre esse tema." },
  { type: "post", where: "LinkedIn", title: "Bastidores do time de produto", text: "Hoje o time de produto mostra como nasce uma tela nova, do rabisco ao teste com usuários." },
  { type: "pergunta", where: "", title: "Posso usar a foto da equipe no vídeo?", text: "Preciso saber se a equipe autorizou o uso da foto na abertura do vídeo." },
];

const iso = (ms: number): string => new Date(ms).toISOString();

type SementeDeProjeto = { id: string; title: string; summary: string; sprints: { id: string; name: string; goal: string }[]; tasks: { title: string; owner: string; sprint: string; done?: boolean }[] };

const PROJETOS: readonly SementeDeProjeto[] = [
  {
    id: "proj-dezembro",
    title: "Campanha de fim de ano",
    summary: "Posts, e-mails e vídeos da campanha de dezembro, com as datas do calendário de vendas.",
    sprints: [
      { id: "S1", name: "Sprint 1 · Peças da campanha", goal: "Ter os textos e roteiros aprovados." },
      { id: "S2", name: "Sprint 2 · Publicação", goal: "Publicar e acompanhar os resultados." },
    ],
    tasks: [
      { title: "Briefing e público da campanha", owner: "eva", sprint: "S1", done: true },
      { title: "Calendário de posts de dezembro", owner: "caio", sprint: "S1", done: true },
      { title: "Textos dos três e-mails", owner: "bia", sprint: "S1" },
      { title: "Roteiro do vídeo principal", owner: "mara", sprint: "S1" },
      { title: "Edição do vídeo principal", owner: "nico", sprint: "S2" },
      { title: "Segmentação da lista de clientes", owner: "gui", sprint: "S2" },
      { title: "Relatório de resultados da semana 1", owner: "gui", sprint: "S2" },
    ],
  },
  {
    id: "proj-cadastro",
    title: "Novo fluxo de cadastro",
    summary: "Reduzir os passos do cadastro e medir a queda de abandono.",
    sprints: [
      { id: "S1", name: "Sprint 1 · Descoberta", goal: "Entender onde as pessoas desistem." },
      { id: "S2", name: "Sprint 2 · Protótipo", goal: "Testar o fluxo novo com cinco pessoas." },
    ],
    tasks: [
      { title: "Entrevistas com quem abandonou o cadastro", owner: "leo", sprint: "S1", done: true },
      { title: "Mapa do fluxo atual", owner: "davi", sprint: "S1", done: true },
      { title: "Especificação do fluxo em duas telas", owner: "davi", sprint: "S2" },
      { title: "Protótipo navegável", owner: "isis", sprint: "S2" },
      { title: "Roteiro do teste de usabilidade", owner: "leo", sprint: "S2" },
      { title: "Critérios de aceite do cadastro", owner: "davi", sprint: "S2" },
    ],
  },
  {
    id: "proj-serie",
    title: "Série de vídeos curtos",
    summary: "Seis vídeos de até um minuto com dicas do produto.",
    sprints: [{ id: "S1", name: "Sprint 1 · Primeiros três vídeos", goal: "Gravar e publicar os três primeiros." }],
    tasks: [
      { title: "Temas dos seis vídeos", owner: "mara", sprint: "S1", done: true },
      { title: "Roteiro do vídeo 1", owner: "mara", sprint: "S1" },
      { title: "Roteiro do vídeo 2", owner: "mara", sprint: "S1" },
      { title: "Corte e legenda do vídeo 1", owner: "nico", sprint: "S1" },
      { title: "Corte e legenda do vídeo 2", owner: "nico", sprint: "S1" },
      { title: "Legendas para as redes", owner: "bia", sprint: "S1" },
    ],
  },
  {
    id: "proj-metricas",
    title: "Relatório mensal de métricas",
    summary: "Juntar as métricas de redes, e-mail e produto num resumo de uma página.",
    sprints: [],
    tasks: [
      { title: "Coletar as métricas das redes", owner: "gui", sprint: "", done: true },
      { title: "Comparar com o mês passado", owner: "gui", sprint: "" },
      { title: "Resumo de uma página", owner: "caio", sprint: "" },
    ],
  },
];

/** Os projetos de mentira no estado das 08h do dia `diaMs` (as tarefas marcadas `done` terminaram ontem). */
export function demoProjects(diaMs: number): Project[] {
  const ontem = diaMs - 20 * 3_600_000;
  return PROJETOS.map((semente, indice): Project => {
    const sprints: Sprint[] = semente.sprints.map((s, ordem) => ({ id: s.id, name: s.name, goal: s.goal, startAt: iso(diaMs - (6 - ordem * 3) * 86_400_000), endAt: iso(diaMs + (4 + ordem * 5) * 86_400_000), order: ordem, status: ordem === 0 ? "ativa" : "planejada", ...(ordem === 0 ? { openedAt: iso(ontem - 3 * 86_400_000) } : {}) }) as Sprint);
    const tasks: ProjectTask[] = semente.tasks.map((t, n): ProjectTask => {
      const ref = `T${n + 1}`;
      const feita = t.done === true;
      return {
        ref,
        title: t.title,
        briefing: `${t.title}. Parte do projeto «${semente.title}».`,
        ownerId: t.owner,
        steps: [{ agentId: t.owner, what: t.title, status: feita ? "feita" : "pendente" }],
        current: 0,
        dependsOn: n > 0 && !feita && n % 3 === 0 ? [`T${n}`] : [],
        priority: "normal",
        doneWhen: [],
        status: feita ? "concluida" : "a_fazer",
        rework: { count: 0 },
        updatedAt: iso(feita ? ontem : diaMs),
        ...(feita ? { startedAt: iso(ontem - 3_600_000), finishedAt: iso(ontem) } : {}),
        ...(t.sprint ? { sprintId: t.sprint } : {}),
      } as ProjectTask;
    });
    return {
      id: semente.id,
      kind: "projeto",
      title: semente.title,
      summary: semente.summary,
      origin: "usuario",
      status: "ativo",
      version: 1,
      priority: indice === 0 ? "alta" : "normal",
      mode: { kind: "pede-ok" },
      worked: {},
      tasks,
      sprints,
      labels: [],
      createdAt: iso(diaMs - 6 * 86_400_000),
      updatedAt: iso(diaMs),
      approvedAt: iso(diaMs - 5 * 86_400_000),
    } as Project;
  });
}
