/**
 * A frase de atividade: cada ferramenta que o agente usa vira uma frase curta em português com um
 * ícone ("📖 Lendo package.json", "🧠 Anotando no Cérebro"). Código puro: vale no servidor (grava a
 * frase no registro de trabalho), na web (cartão, painel, Hoje) e na cena (`fraseDeAtividade`).
 *
 * Origem (parte): o esqueleto de `describeTool` para as ferramentas de arquivo, de busca e de web,
 * `describeMcp` para conectores e navegador, `truncate` e `basename` vêm do Habblaud
 * (`shared/activity.ts`, github.com/marmottajr/habblaud, commit faa1a01), licença MIT,
 * Copyright (c) 2026 Márcio Junior; texto em `THIRD_PARTY/habblaud-LICENSE.txt`.
 * Adaptado: sem i18n, nomes de entrada tolerantes (Claude Code e Antigravity usam chaves
 * diferentes), nomes de ferramenta do Antigravity, `describeCommand` simples nosso (o do Habblaud,
 * com o analisador de shell inteiro, não veio) e toda a tabela das ferramentas do escritório
 * (`OFFICE_TOOL_PHRASES`), que é nossa.
 */
import { browserHostLabel } from "./browser";
import { maskSecrets } from "./secrets";
import { LEGACY_OFFICE_TOOL_NAMES, OFFICE_MCP_SERVER } from "./terminal";

export type WorkPhrase = { icon: string; text: string; detail?: string };

/** Frase gravada na entrada `tool` do log (sem o detalhe, que é o próprio input). */
export type LogPhrase = { icon: string; text: string };

export const PHRASE_MAX_TEXT = 46;
export const PHRASE_MAX_DETAIL = 300;

/** Colapsa espaços/quebras de linha e corta com reticências. */
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1)).trimEnd()}…` : one;
}

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function domainOf(url: string): string {
  const host = browserHostLabel(url);
  return host === url ? truncate(url, 30) : host;
}

/** Mascara antes de cortar (um segredo cortado ao meio vazaria o começo). */
function make(icon: string, text: string, detail?: string): WorkPhrase {
  return {
    icon,
    text: truncate(maskSecrets(text.slice(0, PHRASE_MAX_TEXT * 8)), PHRASE_MAX_TEXT),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, PHRASE_MAX_DETAIL * 4)), PHRASE_MAX_DETAIL) } : {}),
  };
}

type Input = Record<string, unknown>;

/** Primeiro texto não vazio entre as chaves (sem maiúsculas nem "_": `file_path`, `FilePath` e `filepath` são a mesma). */
function pick(input: Input, keys: readonly string[]): string {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) flat.set(key.toLowerCase().replace(/_/g, ""), value);
  for (const key of keys) {
    const value = flat.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const PATH_KEYS = ["filepath", "absolutepath", "targetfile", "path", "file", "filename", "notebookpath", "directorypath", "searchpath"] as const;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic)$/i;

// ------------------------------------------------------------ nomes nos dois motores

/**
 * O Claude Code e o Antigravity (Gemini) chamam a mesma coisa por nomes diferentes. Tudo vira o nome
 * do Claude Code. Nomes do Antigravity conferidos na lista `init.tools` do agy 1.5.3 (fixture
 * `agy-stream-json.jsonl`) e nas permissões do adaptador (`read_file`, `write_file`, `run_command`,
 * `read_url`).
 */
const ENGINE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  view_file: "Read",
  read_file: "Read",
  write_to_file: "Write",
  write_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "MultiEdit",
  sed_file: "Edit",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "LS",
  search_web: "WebSearch",
  read_url_content: "WebFetch",
  read_url: "WebFetch",
  run_command: "Bash",
  command_status: "BashOutput",
  send_command_input: "BashOutput",
  notebook_edit: "NotebookEdit",
  invoke_subagent: "Agent",
  manage_subagents: "Agent",
  define_subagent: "Agent",
  generate_image: "GenerateImage",
  ask_question: "AskUserQuestion",
  ask_permission: "AskUserQuestion",
  send_message: "SendMessage",
  open_browser_url: "BrowserOpen",
  read_browser_page: "BrowserRead",
  capture_browser_screenshot: "BrowserShot",
  list_resources: "ListMcpResourcesTool",
  read_resource: "ReadMcpResourceTool",
  schedule: "Cron",
  // Freebuff (nomes conferidos no chat-messages.json e no log.jsonl dele, 12/11).
  read_files: "Read",
  str_replace: "Edit",
  propose_str_replace: "Edit",
  propose_write_file: "Write",
  run_terminal_command: "Bash",
  code_search: "Grep",
  find_files: "Glob",
  list_directory: "LS",
  web_search: "WebSearch",
  read_docs: "WebFetch",
  spawn_agents: "Agent",
  // OpenClaw (o `toolSummary` do envelope traz os nomes das ferramentas; os conferidos na documentação) e Hermes
  // (nomes do toolsets.py do código-fonte; as ferramentas do escritório chegam como `mcp_office_<nome>`). Nome que
  // não está aqui vira "usando <nome>" (nunca quebra).
  read: "Read",
  write: "Write",
  edit: "Edit",
  exec: "Bash",
  process: "Bash",
  patch: "Edit",
  search_files: "Grep",
  terminal: "Bash",
  process_manage: "Bash",
  web_extract: "WebFetch",
  execute_code: "Bash",
  delegate_task: "Agent",
};

/** O nome da ferramenta no vocabulário do Claude Code (nomes do Antigravity traduzidos; o resto fica). */
export function canonicalToolName(name: string): string {
  return ENGINE_TOOL_ALIASES[name] ?? name;
}

/** Os nomes de ferramenta nativa do Antigravity que a tabela conhece. */
export const ANTIGRAVITY_TOOL_NAMES: readonly string[] = Object.keys(ENGINE_TOOL_ALIASES);

// ------------------------------------------------------------ ferramentas do escritório

export type OfficeToolPhrase = {
  icon: string;
  /** Rótulo curto no terminal ("⏺ entregar(…)"). */
  short: string;
  /** Agora, no gerúndio ("Entregando o resultado"). */
  doing: string;
  /** Passo da atividade, no passado ("Entregou o resultado"). */
  done: string;
};

const row = (icon: string, short: string, doing: string, done: string): OfficeToolPhrase => ({ icon, short, doing, done });

/**
 * Toda ferramenta MCP do escritório (`mcp__office__<nome>`) com ícone, rótulo curto, frase no
 * gerúndio e no passado. Tabela nossa. O teste do servidor percorre as ferramentas registradas em
 * `packages/server/src/mcp/` e falha se faltar uma. O nome é o novo (em inglês); o antigo (pt-BR)
 * acha a linha por `LEGACY_OFFICE_TOOL_NAMES`.
 */
export const OFFICE_TOOL_PHRASES: Readonly<Record<string, OfficeToolPhrase>> = {
  // Equipe, pedidos e tarefas
  get_team: row("👥", "ver equipe", "Conferindo a equipe", "Consultou a equipe"),
  list_workspaces: row("🏢", "listar workspaces", "Listando os workspaces", "Consultou os workspaces"),
  get_usage: row("📊", "ver uso", "Conferindo o uso das assinaturas", "Consultou o uso das assinaturas"),
  open_request: row("📨", "abrir pedido", "Abrindo um pedido", "Abriu um pedido"),
  delegate_task: row("👥", "delegar", "Delegando uma tarefa", "Delegou uma tarefa"),
  get_task: row("🔎", "ver tarefa", "Conferindo uma tarefa", "Conferiu uma tarefa"),
  complete_request: row("✅", "concluir pedido", "Concluindo o pedido", "Concluiu o pedido"),
  cancel_request: row("🛑", "cancelar pedido", "Cancelando um pedido", "Cancelou um pedido"),
  update_request: row("📨", "ajustar pedido", "Ajustando um pedido", "Ajustou um pedido"),
  assign_task: row("👥", "atribuir tarefa", "Atribuindo uma tarefa", "Atribuiu uma tarefa"),
  reassign_task: row("🔁", "reatribuir tarefa", "Passando uma tarefa travada a outro agente", "Passou uma tarefa travada a outro agente"),
  move_task: row("🗂️", "mover tarefa", "Movendo uma tarefa", "Moveu uma tarefa"),
  set_workspace_summary: row("📝", "resumo do workspace", "Atualizando o resumo do workspace", "Atualizou o resumo do workspace"),
  // Aprovação e perguntas
  request_approval: row("✋", "pedir aprovação", "Pedindo seu OK", "Pediu sua aprovação"),
  ask_user: row("❓", "perguntar a você", "Fazendo perguntas a você", "Mandou perguntas para você"),
  list_pending_items: row("📋", "listar pendências", "Olhando o que espera você", "Listou o que espera você"),
  update_pending_item: row("✏️", "ajustar pendência", "Ajustando um pedido de OK", "Ajustou um pedido de OK"),
  cancel_pending_item: row("🛑", "cancelar pendência", "Cancelando um pedido de OK", "Cancelou um pedido de OK"),
  set_approval_type: row("🏷️", "criar tipo de aprovação", "Criando um tipo de aprovação", "Criou um tipo de aprovação"),
  delete_approval_type: row("🗑️", "apagar tipo de aprovação", "Apagando um tipo de aprovação", "Apagou um tipo de aprovação"),
  // Projetos e planos
  create_project: row("🗺️", "montar projeto", "Montando um projeto", "Montou um projeto"),
  add_project_tasks: row("🗺️", "incluir tarefas no projeto", "Incluindo tarefas no projeto", "Incluiu tarefas no projeto"),
  resolve_task: row("✅", "decidir tarefa do projeto", "Decidindo uma tarefa do projeto", "Decidiu uma tarefa do projeto"),
  get_project: row("🗺️", "ver projeto", "Conferindo o projeto", "Conferiu o projeto"),
  update_project: row("🗺️", "ajustar projeto", "Ajustando o projeto", "Ajustou o projeto"),
  list_projects: row("🗺️", "listar projetos", "Listando os projetos", "Listou os projetos"),
  add_sprint: row("🏁", "criar sprint", "Criando uma sprint", "Criou uma sprint"),
  update_sprint: row("🏁", "ajustar sprint", "Ajustando uma sprint", "Ajustou uma sprint"),
  close_sprint: row("🏁", "fechar sprint", "Fechando uma sprint", "Fechou uma sprint"),
  create_plan: row("🗺️", "montar plano", "Montando um plano", "Montou um plano"),
  add_plan_tasks: row("🗺️", "incluir tarefas no plano", "Incluindo tarefas no plano", "Incluiu tarefas no plano"),
  resolve_plan_task: row("✅", "decidir tarefa do plano", "Decidindo uma tarefa do plano", "Decidiu uma tarefa do plano"),
  get_plan: row("🗺️", "ver plano", "Conferindo o plano", "Conferiu o plano"),
  list_plans: row("🗺️", "listar planos", "Listando os planos", "Listou os planos"),
  // Trabalho do agente
  submit_result: row("✅", "entregar", "Entregando o resultado", "Entregou o resultado"),
  report_progress: row("📈", "progresso", "Atualizando o progresso", "Atualizou o progresso"),
  request_help: row("🆘", "pedir ajuda", "Pedindo ajuda ao Maestro", "Pediu ajuda ao Maestro"),
  send_to_colleague: row("💬", "falar com colega", "Passando a vez para um colega", "Passou a vez / falou com um colega"),
  message_agent: row("💬", "mensagem ao agente", "Mandando mensagem a um agente", "Mandou mensagem a um agente"),
  get_agent_activity: row("👀", "ver atividade do agente", "Olhando o que um agente faz", "Viu o que um agente faz"),
  // Montar o workspace
  list_room_options: row("🏠", "ver tipos de sala", "Vendo os tipos de sala", "Viu os tipos de sala"),
  create_room: row("🏠", "criar sala", "Criando uma sala", "Criou uma sala"),
  create_team: row("👥", "criar time", "Criando um time", "Criou um time"),
  create_agent: row("🧑‍💻", "criar agente", "Criando um agente", "Criou um agente"),
  set_team_lead: row("👑", "definir líder", "Definindo o líder de um time", "Definiu o líder de um time"),
  set_agent_model: row("🧩", "trocar modelo", "Trocando o modelo de um agente", "Trocou o modelo de um agente"),
  set_agent_skills: row("🧩", "skills do agente", "Ajustando as skills de um agente", "Ajustou as skills de um agente"),
  get_catalog: row("📚", "ver catálogo", "Vendo o que existe para montar o workspace", "Consultou o que existe para montar o workspace"),
  create_workspace: row("🏢", "criar workspace", "Criando um workspace", "Criou um workspace"),
  rename_workspace: row("🏢", "renomear workspace", "Renomeando um workspace", "Renomeou um workspace"),
  set_workspace_models: row("🧩", "modelos do workspace", "Mudando os modelos do workspace", "Mudou os modelos padrão de um workspace"),
  propose_workspace: row("🏢", "propor workspace", "Montando a proposta de um workspace", "Montou a proposta de um workspace"),
  update_room: row("🏠", "ajustar sala", "Ajustando uma sala", "Ajustou uma sala"),
  update_team: row("👥", "ajustar time", "Ajustando um time", "Ajustou um time"),
  update_agent: row("🧑‍💻", "ajustar agente", "Ajustando um agente", "Ajustou um agente"),
  start_agent: row("▶️", "ligar agente", "Ligando o terminal de um agente", "Ligou o terminal de um agente"),
  stop_agent: row("⏹️", "parar agente", "Parando o terminal de um agente", "Parou o terminal de um agente"),
  set_room_brain_sharing: row("🧠", "Cérebro da sala", "Ajustando o Cérebro de uma sala", "Ajustou o Cérebro de uma sala"),
  delete_workspace: row("🗑️", "apagar workspace", "Pedindo seu OK para apagar um workspace", "Pediu seu OK para apagar um workspace"),
  delete_room: row("🗑️", "apagar sala", "Pedindo seu OK para apagar uma sala", "Pediu seu OK para apagar uma sala"),
  delete_team: row("🗑️", "apagar time", "Pedindo seu OK para apagar um time", "Pediu seu OK para apagar um time"),
  delete_agent: row("🗑️", "apagar agente", "Pedindo seu OK para apagar um agente", "Pediu seu OK para apagar um agente"),
  add_connector: row("🔌", "cadastrar conector", "Pedindo seu OK para cadastrar um conector", "Pediu seu OK para cadastrar um conector"),
  set_agent_connectors: row("🔌", "conectores do agente", "Pedindo seu OK para dar conectores a um agente", "Pediu seu OK para dar conectores a um agente"),
  set_agent_access: row("🔐", "acesso do agente", "Pedindo seu OK para mudar o acesso de um agente", "Pediu seu OK para mudar o acesso de um agente"),
  set_workspace_access: row("🔐", "acesso do workspace", "Pedindo seu OK para mudar o acesso do workspace", "Pediu seu OK para mudar o acesso de um workspace"),
  run_host_command: row("💻", "comando na máquina", "Pedindo seu OK para rodar um comando", "Pediu seu OK para rodar um comando na máquina"),
  // Cérebro
  search_notes: row("🧠", "buscar notas", "Buscando no Cérebro", "Buscou no Cérebro"),
  read_note: row("🧠", "ler nota", "Lendo uma nota do Cérebro", "Leu uma nota do Cérebro"),
  save_note: row("🧠", "salvar nota", "Anotando no Cérebro", "Salvou uma nota no Cérebro"),
  // Navegador compartilhado
  browser_open: row("🧭", "abrir site", "Abrindo um site", "Abriu um site"),
  browser_tabs: row("🧭", "ver abas", "Conferindo as abas do navegador", "Conferiu as abas do navegador"),
  browser_snapshot: row("🧭", "ler página", "Lendo a página", "Leu a página"),
  browser_click: row("🖱️", "clicar", "Clicando na página", "Clicou na página"),
  browser_type: row("⌨️", "digitar", "Digitando na página", "Digitou na página"),
  browser_press: row("⌨️", "apertar tecla", "Apertando uma tecla", "Apertou uma tecla"),
  browser_scroll: row("🧭", "rolar página", "Rolando a página", "Rolou a página"),
  browser_back: row("🧭", "voltar página", "Voltando uma página", "Voltou uma página"),
  browser_screenshot: row("📸", "olhar a tela", "Olhando a tela do site", "Olhou a tela do site"),
  browser_close_tab: row("🧭", "fechar aba", "Fechando uma aba", "Fechou uma aba"),
  browser_current_url: row("🧭", "ver endereço", "Conferindo o endereço da página", "Conferiu o endereço da página"),
  browser_find: row("🔎", "achar na página", "Procurando na página", "Procurou na página"),
  browser_get_link: row("🔗", "pegar link", "Pegando um link da página", "Pegou um link da página"),
  browser_inspect: row("🔎", "inspecionar página", "Inspecionando a página", "Inspecionou a página"),
  browser_upload: row("📤", "enviar arquivo", "Enviando um arquivo pela página", "Enviou um arquivo pela página"),
  // Mídia
  media_get_file: row("📎", "pegar arquivo da mídia", "Pegando um arquivo da mídia", "Pegou um arquivo da mídia"),
  media_list: row("🖼️", "listar mídia", "Olhando a biblioteca de mídia", "Listou a biblioteca de mídia"),
  media_list_folders: row("🗂️", "listar pastas da mídia", "Olhando as pastas da mídia", "Listou as pastas da mídia"),
  media_render_html: row("🖼️", "gerar imagem", "Gerando uma imagem", "Gerou uma imagem"),
  media_save_file: row("🖼️", "guardar mídia", "Guardando um arquivo na mídia", "Guardou um arquivo na mídia"),
  media_update: row("🖼️", "ajustar mídia", "Ajustando um item de mídia", "Ajustou um item de mídia"),
  media_view: row("👁️", "olhar mídia", "Olhando uma imagem da mídia", "Olhou uma imagem da mídia"),
  // Quadros
  board_guide: row("📊", "ler guia do quadro", "Lendo o guia dos quadros", "Leu o guia dos quadros"),
  board_list: row("📊", "listar quadros", "Olhando os quadros", "Listou os quadros"),
  board_save: row("📊", "montar quadro", "Montando um quadro", "Montou um quadro"),
  board_set_data: row("📊", "atualizar dados do quadro", "Atualizando os dados de um quadro", "Atualizou os dados de um quadro"),
  board_patch_data: row("📊", "ajustar dados do quadro", "Ajustando os dados de um quadro", "Ajustou os dados de um quadro"),
  board_read_data: row("📊", "ler dados do quadro", "Lendo os dados de um quadro", "Leu os dados de um quadro"),
  // Rotinas e acompanhamentos
  routine_list: row("⏰", "listar rotinas", "Olhando as rotinas", "Listou as rotinas"),
  routine_status: row("⏰", "ver rotina", "Conferindo uma rotina", "Conferiu uma rotina"),
  routine_propose: row("⏰", "propor rotina", "Propondo uma rotina", "Propôs uma rotina"),
  routine_update_propose: row("⏰", "propor ajuste de rotina", "Propondo um ajuste de rotina", "Propôs um ajuste de rotina"),
  routine_pause: row("⏸️", "pausar rotina", "Pausando uma rotina", "Pausou uma rotina"),
  routine_resume: row("▶️", "retomar rotina", "Retomando uma rotina", "Retomou uma rotina"),
  routine_record: row("⏰", "registrar na rotina", "Registrando na rotina", "Registrou na rotina"),
  routine_items: row("📋", "itens da rotina", "Olhando os itens de uma rotina", "Listou os itens de uma rotina"),
  routine_items_list: row("📋", "itens da rotina", "Olhando os itens de uma rotina", "Listou os itens de uma rotina"),
  routine_item_add: row("📋", "incluir item", "Incluindo um item no acompanhamento", "Incluiu um item no acompanhamento"),
  routine_item_update: row("📋", "ajustar item", "Ajustando um item do acompanhamento", "Ajustou um item do acompanhamento"),
  routine_item_stop: row("🛑", "encerrar item", "Encerrando um item do acompanhamento", "Encerrou um item do acompanhamento"),
  // Agenda e calendário
  agenda_book: row("📅", "marcar na agenda", "Marcando um compromisso", "Marcou um compromisso"),
  agenda_cancel: row("📅", "cancelar compromisso", "Cancelando um compromisso", "Cancelou um compromisso"),
  agenda_free_slots: row("📅", "horários livres", "Vendo horários livres", "Viu os horários livres"),
  agenda_list: row("📅", "ver agenda", "Olhando a agenda", "Consultou a agenda"),
  agenda_move: row("📅", "remarcar", "Remarcando um compromisso", "Remarcou um compromisso"),
  create_event: row("📅", "criar evento", "Criando um evento", "Criou um evento"),
  update_event: row("📅", "ajustar evento", "Ajustando um evento", "Ajustou um evento"),
  delete_event: row("📅", "apagar evento", "Apagando um evento", "Apagou um evento"),
  list_events: row("📅", "listar eventos", "Olhando os eventos", "Listou os eventos"),
  // Mural
  mural_list: row("📌", "ver mural", "Olhando o mural", "Viu o mural"),
  mural_share: row("📌", "compartilhar no mural", "Compartilhando no mural", "Compartilhou no mural"),
  mural_unshare: row("📌", "tirar do mural", "Tirando algo do mural", "Tirou algo do mural"),
  mural_use: row("📌", "usar item do mural", "Trazendo um item do mural", "Trouxe um item do mural"),
  // Cyno (a plataforma; só o Cyno usa)
  get_today: row("🗓️", "ver o Hoje", "Olhando o Hoje", "Consultou o Hoje"),
  get_day_stats: row("📊", "ver a diária", "Olhando como foi o dia", "Consultou a diária"),
  get_metrics: row("📈", "ver os números", "Olhando os números da Gestão", "Consultou os números da Gestão"),
  get_report: row("📑", "ver o relatório", "Olhando o relatório da Gestão", "Consultou o relatório da Gestão"),
  propose_rule: row("📜", "propor regra", "Redigindo uma regra para o dono aprovar", "Propôs uma regra para o dono aprovar"),
  get_away_summary: row("🚪", "ver a ausência", "Olhando o que aconteceu na sua ausência", "Consultou a sua ausência"),
  get_workspace_card: row("🏢", "ver workspace", "Olhando um workspace", "Viu um workspace"),
  list_waiting_for_you: row("📋", "o que espera você", "Olhando o que espera você", "Listou o que espera você"),
  list_requests: row("📨", "listar pedidos", "Listando os pedidos", "Listou os pedidos"),
  list_sent_requests: row("📨", "pedidos enviados", "Olhando os pedidos enviados", "Listou os pedidos enviados"),
  get_request_status: row("🔎", "ver pedido", "Conferindo um pedido", "Conferiu um pedido"),
  send_request: row("📨", "enviar pedido", "Mandando um pedido a um workspace", "Mandou um pedido a um workspace"),
  answer_maestro: row("💬", "responder ao Maestro", "Respondendo ao Maestro", "Respondeu ao Maestro"),
  ask_cyno: row("🧭", "falar com o Cyno", "Perguntando ao Cyno", "Perguntou ao Cyno"),
  send_joint_request: row("🤝", "pedido conjunto", "Mandando um pedido conjunto", "Mandou um pedido conjunto"),
  cancel_joint_request: row("🛑", "cancelar pedido conjunto", "Cancelando um pedido conjunto", "Cancelou um pedido conjunto"),
  get_joint_status: row("🤝", "ver pedido conjunto", "Conferindo um pedido conjunto", "Conferiu um pedido conjunto"),
};

const OFFICE_PREFIX = `mcp__${OFFICE_MCP_SERVER}__`;

/**
 * Nome (novo) de uma ferramenta do escritório a partir do nome cru do log ("mcp__office__submit_result"
 * ou o antigo "mcp__office__entregar" -> "submit_result"). Undefined = não é do escritório (ou é de
 * um conector: `mcp__office__notion__create_page`).
 */
export function officeToolName(raw: string): string | undefined {
  if (!raw.startsWith(OFFICE_PREFIX)) return undefined;
  const tool = raw.slice(OFFICE_PREFIX.length);
  if (tool.includes("__")) return undefined;
  return LEGACY_OFFICE_TOOL_NAMES[tool] ?? tool;
}

/** Ferramenta do navegador compartilhado (`browser_*`)? */
export function isBrowserTool(tool: string): boolean {
  return tool.startsWith("browser_");
}

const humanizeTool = (tool: string) => tool.replace(/_/g, " ");

/** Rótulo curto pt-BR de uma ferramenta do escritório (desconhecida: o nome com espaços). */
export function officeToolShort(tool: string): string {
  return OFFICE_TOOL_PHRASES[tool]?.short ?? humanizeTool(tool);
}

/** Passo da atividade em pt-BR ("Entregou o resultado"); desconhecida: "Usou <nome>". */
export function officeToolDone(tool: string): string {
  return OFFICE_TOOL_PHRASES[tool]?.done ?? `Usou ${humanizeTool(tool)}`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "https://x.com" ou "x.com" -> "x.com". */
function hostOfInput(url: string): string {
  return browserHostLabel(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
}

/**
 * Passo da atividade com o que veio na chamada ("Abriu google.com", "Digitou “pizza de manga”",
 * "Apertou Enter"); sem o dado, o rótulo genérico da ferramenta.
 */
export function officeToolDoneWith(tool: string, input?: Input): string {
  const value = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string).trim() : "");
  if (tool === "browser_open" && value("url")) return `Abriu ${hostOfInput(value("url"))}`;
  if (tool === "browser_type" && value("text")) return `Digitou “${clip(value("text"), 40)}”${input?.submit === true ? " e enviou" : ""}`;
  if (tool === "browser_press" && value("key")) return `Apertou ${value("key")}`;
  if (tool === "browser_scroll" && value("direction") === "up") return "Rolou a página para cima";
  return officeToolDone(tool);
}

/** A frase no gerúndio de uma ferramenta do escritório, usando o que veio na chamada quando ajuda. */
function describeOffice(tool: string, input: Input): WorkPhrase {
  const known = OFFICE_TOOL_PHRASES[tool];
  if (!known) return make("🛠️", `Usando ${humanizeTool(tool)}`);
  const value = (...keys: string[]) => pick(input, keys);
  switch (tool) {
    case "browser_open":
      return value("url") ? make(known.icon, `Abrindo ${hostOfInput(value("url"))}`, value("url")) : make(known.icon, known.doing);
    case "browser_type":
      return value("text") ? make(known.icon, `Digitando “${clip(value("text"), 28)}”`) : make(known.icon, known.doing);
    case "browser_press":
      return value("key") ? make(known.icon, `Apertando ${value("key")}`) : make(known.icon, known.doing);
    case "send_to_colleague":
      return value("to") ? make(known.icon, `Passando a vez para ${value("to")}`, value("message")) : make(known.icon, known.doing, value("message"));
    case "delegate_task":
      return value("task") ? make(known.icon, `Delegando: ${value("task")}`, value("task")) : make(known.icon, known.doing);
    case "request_help":
      return make(known.icon, known.doing, value("what"));
    case "save_note":
      return value("title") ? make(known.icon, `Anotando “${clip(value("title"), 28)}” no Cérebro`) : make(known.icon, known.doing);
    case "read_note":
      return value("title", "note", "name") ? make(known.icon, `Lendo “${clip(value("title", "note", "name"), 30)}”`) : make(known.icon, known.doing);
    case "search_notes":
      return value("query") ? make(known.icon, `Buscando “${clip(value("query"), 28)}” no Cérebro`) : make(known.icon, known.doing);
    case "report_progress":
      return value("message") ? make(known.icon, `Progresso: ${value("message")}`) : make(known.icon, known.doing);
    case "message_agent":
      return make(known.icon, known.doing, value("text"));
    default:
      return make(known.icon, known.doing);
  }
}

// ------------------------------------------------------------ conectores e navegador (MCP de fora)

function humanize(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

function describeMcp(name: string, input: Input): WorkPhrase {
  const [, server = "", ...rest] = name.split("__");
  const tool = rest.join("__");
  const srv = server.replace(/^claude_ai_/, "");
  if (/playwright|chrome|browser|puppeteer/i.test(srv)) {
    const url = pick(input, ["url"]);
    if (/navigate/.test(tool)) return make("🧭", url ? `Abrindo ${domainOf(url)}` : "Navegando no navegador", url);
    if (/screenshot/.test(tool)) return make("📸", "Tirando print da página");
    if (/click/.test(tool)) return make("🖱️", "Clicando na página");
    if (/type|fill|form/.test(tool)) return make("⌨️", "Preenchendo formulário");
    if (/snapshot|read|get_page|find/.test(tool)) return make("🧭", "Lendo a página");
    return make("🧭", `Navegador: ${humanize(tool)}`);
  }
  if (/github/i.test(srv)) return make("🐙", `GitHub: ${humanize(tool)}`);
  if (/gmail|mail/i.test(srv)) return make("✉️", `E-mail: ${humanize(tool)}`);
  if (/drive|docs|notion|confluence/i.test(srv)) return make("📄", `${srv}: ${humanize(tool)}`);
  if (/sql|postgres|mysql|mongo|elastic|redis|db/i.test(srv)) return make("🗄️", `Banco (${srv}): ${humanize(tool)}`);
  return make("🔌", `${srv}: ${humanize(tool)}`);
}

// ------------------------------------------------------------ comando de terminal (simples, nosso)

const WRAPPERS = new Set(["sudo", "time", "env", "nice", "nohup", "timeout", "xargs"]);

/**
 * Frase para um comando de terminal. O agente do Cyno só tem terminal quando o dono liga (Claude
 * Code `Bash`, Antigravity `run_command`): por isso uma versão simples, sem o analisador de shell
 * do Habblaud. Olha o primeiro comando de verdade (pula `cd x &&`, `X=1`, `sudo`) e reconhece uns
 * poucos; o resto vira "Rodando <programa>". O comando inteiro (mascarado) vai no detalhe.
 */
function describeCommand(command: string): WorkPhrase {
  const full = command.trim();
  const segments = full.split(/\s*(?:&&|\|\||;|\n)\s*/).filter(Boolean);
  const useful = segments.find((s) => !/^(cd|set|export|echo|true|source|\.)\b/.test(s) && !/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(s)) ?? segments[0] ?? "";
  const words = useful.split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  while (words.length > 1 && WRAPPERS.has(words[0]!)) words.shift();
  const prog = basename(words[0] ?? "");
  const sub = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
  const rest = words.slice(1).join(" ");
  if (!prog) return make("💻", "Rodando um comando no terminal", full);
  if (prog === "git") return make("🌿", sub ? `Usando git ${sub}` : "Usando git", full);
  if (/^(npm|pnpm|yarn|bun)$/.test(prog)) {
    if (/\b(test|vitest|jest)\b/.test(rest)) return make("🧪", "Rodando os testes", full);
    if (/^(install|add|ci|i)$/.test(sub)) return make("📦", "Instalando dependências", full);
    if (/\bbuild\b/.test(rest)) return make("🏗️", "Montando o projeto (build)", full);
    if (/\b(typecheck|tsc|lint)\b/.test(rest)) return make("🔍", "Conferindo os tipos e o estilo", full);
    return make("💻", `Rodando ${prog}${sub ? ` ${sub}` : ""}`, full);
  }
  if (/^(vitest|jest|pytest|playwright)$/.test(prog)) return make("🧪", "Rodando os testes", full);
  if (/^(ls|tree|find|fd)$/.test(prog)) return make("📂", "Listando arquivos", full);
  if (/^(cat|head|tail|less|sed|awk)$/.test(prog)) return make("📖", "Lendo um arquivo no terminal", full);
  if (/^(grep|rg|ag)$/.test(prog)) return make("🔎", "Buscando no código", full);
  if (/^(curl|wget)$/.test(prog)) return make("🌐", "Baixando da internet", full);
  if (/^(mkdir|cp|mv|rm|touch)$/.test(prog)) return make("🗂️", "Mexendo em arquivos", full);
  return make("💻", /^[A-Za-z][\w.+-]{0,23}$/.test(prog) ? `Rodando ${prog}` : "Rodando um comando no terminal", full);
}

// ------------------------------------------------------------ a função principal

/** Descreve uma chamada de ferramenta (de qualquer motor) em português, no gerúndio. */
export function describeWork(rawName: string, rawInput?: unknown): WorkPhrase {
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Input;
  const office = officeToolName(rawName);
  if (office) return describeOffice(office, input);
  const name = canonicalToolName(rawName);
  const file = pick(input, PATH_KEYS);
  switch (name) {
    case "Read":
      if (IMAGE_EXT.test(file)) return make("🖼️", `Olhando ${basename(file)}`, file);
      if (/\.pdf$/i.test(file)) return make("📕", `Lendo ${basename(file)}`, file);
      return make("📖", file ? `Lendo ${basename(file)}` : "Lendo arquivo", file);
    case "Edit":
    case "MultiEdit":
      return make("✏️", file ? `Editando ${basename(file)}` : "Editando arquivo", file);
    case "Write":
      return make("📝", file ? `Escrevendo ${basename(file)}` : "Escrevendo arquivo", file);
    case "NotebookEdit":
      return make("📓", file ? `Editando notebook ${basename(file)}` : "Editando um notebook", file);
    case "Glob": {
      const pattern = maskSecrets(pick(input, ["pattern", "query", "glob"]));
      return make("🔎", `Procurando ${truncate(pattern || "arquivos", 30)}`, pattern);
    }
    case "Grep": {
      const pattern = maskSecrets(pick(input, ["pattern", "query", "searchterm"]));
      return make("🔎", pattern ? `Buscando “${truncate(pattern, 26)}”` : "Buscando no código", pattern);
    }
    case "LS":
      return make("📂", `Listando ${basename(file) || "a pasta"}`, file);
    case "WebSearch": {
      const q = maskSecrets(pick(input, ["query", "q", "searchterm"]));
      return make("🌐", q ? `Pesquisando “${truncate(q, 28)}”` : "Pesquisando na web", q);
    }
    case "WebFetch": {
      const url = pick(input, ["url"]);
      return make("🌐", url ? `Lendo ${domainOf(url)}` : "Lendo uma página", url);
    }
    case "Bash":
      return describeCommand(pick(input, ["command", "commandline"]));
    case "BashOutput":
      return make("📟", "Conferindo saída do terminal");
    case "Agent":
    case "Task": {
      const d = pick(input, ["description", "role", "task"]);
      return make("👥", d ? `Delegando: ${d}` : "Chamando um subagente", pick(input, ["prompt", "initialprompt"]));
    }
    case "SendMessage":
      return make("💬", `Mensagem para ${pick(input, ["to", "recipient"]) || "outro agente"}`, pick(input, ["message", "content"]));
    case "AskUserQuestion":
      return make("❓", "Fazendo uma pergunta a você");
    case "GenerateImage":
      return make("🎨", "Gerando uma imagem", pick(input, ["prompt"]));
    case "BrowserOpen": {
      const url = pick(input, ["url"]);
      return make("🧭", url ? `Abrindo ${domainOf(url)}` : "Navegando no navegador", url);
    }
    case "BrowserRead":
      return make("🧭", "Lendo a página");
    case "BrowserShot":
      return make("📸", "Tirando print da página");
    case "ListMcpResourcesTool":
    case "ReadMcpResourceTool":
      return make("🔌", "Lendo recursos MCP");
    case "ToolSearch":
      return make("🧰", "Procurando ferramentas");
    case "TodoWrite":
      return make("🗒️", "Atualizando a lista de tarefas");
    case "Skill":
      return make("🧩", `Usando a skill ${pick(input, ["skill", "command"])}`.trim());
    case "Cron":
      return make("⏰", "Agendando uma tarefa");
    default:
      if (rawName.startsWith("mcp__")) return describeMcp(rawName, input);
      // Navegador embutido do Antigravity (`browser_*` sem prefixo) e o resto.
      if (/^browser_/.test(rawName)) return make("🧭", `Navegador: ${humanize(rawName.replace(/^browser_/, ""))}`);
      return make("🛠️", `Usando ${rawName}`);
  }
}

/** Um evento de ferramenta (o `tool_use` do terminal ou a entrada `tool` do log). */
export type ToolEventLike = { name: string; input?: Record<string, unknown> };

/** O ponto de encaixe da cena e do resto: a frase de um evento de ferramenta (já mascarada, até 46 caracteres). */
export function fraseDeAtividade(evento: ToolEventLike): LogPhrase {
  const { icon, text } = describeWork(evento.name, evento.input);
  return { icon, text };
}

/** Frase no passado para a linha do tempo: as do escritório e do navegador têm forma própria, as outras usam a do gerúndio. */
export function describeWorkDone(rawName: string, rawInput?: unknown): string {
  const office = officeToolName(rawName);
  if (office) return officeToolDoneWith(office, rawInput && typeof rawInput === "object" ? (rawInput as Input) : undefined);
  return describeWork(rawName, rawInput).text;
}
