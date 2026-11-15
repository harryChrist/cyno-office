import { isCliEngine, RETENTION_DAY_OPTIONS, type AgentEffort, type EngineInfo, type ModelChoice, type ModelDefaults, type SubagentChoice, type WorkspaceAccess } from "@cyno/shared";
import { hashFor, parseHash, type Location } from "../../store/navStore";

/**
 * As duas áreas da página: "plataforma" vale para tudo (todos os workspaces); "workspace" vale só
 * para o workspace escolhido no seletor da área.
 */
export type SettingsArea = "plataforma" | "workspace";

/** O que vale para cada opção: a plataforma inteira, só o workspace escolhido ou só este navegador. */
export type SettingsSeal = "plataforma" | "workspace" | "navegador";

export const AREA_LABELS: Record<SettingsArea, string> = { plataforma: "Da plataforma", workspace: "Do workspace" };
export const SEAL_LABELS: Record<SettingsSeal, string> = { plataforma: "Toda a plataforma", workspace: "Só este workspace", navegador: "Só neste navegador" };

/**
 * Seções da página, na ordem em que aparecem (cada área em sequência). O id vai no endereço
 * (`#/<ws>/configuracoes/motores`). Cuidado: o id de uma seção nunca pode ser o id de uma página
 * (`navegador`, `gestao`...), senão o endereço sem workspace (`#/configuracoes/<seção>`) se confunde.
 */
export const SETTINGS_SECTIONS = [
  { id: "senha", area: "plataforma", label: "Acesso e senha", hint: "Quem pode abrir o app", seal: "plataforma" },
  { id: "motores", area: "plataforma", label: "Motores", hint: "O que está instalado e funcionando", seal: "plataforma" },
  { id: "modelos-padrao", area: "plataforma", label: "Modelos padrão", hint: "Maestro, agentes, subagentes e Cyno", seal: "plataforma" },
  { id: "cyno-ajustes", area: "plataforma", label: "Cyno", hint: "Sono, teto de turnos e resumo", seal: "plataforma" },
  { id: "avisos", area: "plataforma", label: "Avisos", hint: "Som, notificação e o que avisa", seal: "plataforma" },
  { id: "conectores-locais", area: "plataforma", label: "Conectores locais", hint: "Comandos e apps nesta máquina", seal: "plataforma" },
  { id: "historico", area: "plataforma", label: "Histórico guardado", hint: "Conversas e logs no disco", seal: "plataforma" },
  { id: "versao", area: "plataforma", label: "Versão e atualizações", hint: "Qual versão roda e se há novidade", seal: "plataforma" },
  { id: "escritorio", area: "plataforma", label: "Aparência", hint: "Sons e bichos do escritório", seal: "navegador" },
  { id: "modelos", area: "workspace", label: "Modelos e Maestro", hint: "Agentes novos e o Maestro daqui", seal: "workspace" },
  { id: "acesso", area: "workspace", label: "O que os agentes acessam", hint: "Internet, navegador e terminal", seal: "workspace" },
  { id: "pastas", area: "workspace", label: "Pastas de trabalho", hint: "Projetos e vaults que os agentes usam", seal: "workspace" },
  { id: "seguranca", area: "workspace", label: "Segurança na web", hint: "Rede local, domínios e aprovação", seal: "workspace" },
  { id: "distribuicao", area: "workspace", label: "Trabalho em paralelo", hint: "Quantos trabalham ao mesmo tempo", seal: "workspace" },
  { id: "relatorios", area: "workspace", label: "Relatórios da Gestão", hint: "Resumo do dia e revisão da semana", seal: "workspace" },
  { id: "aprovacoes", area: "workspace", label: "Tipos de aprovação", hint: "O que conta como aprovação", seal: "workspace" },
  { id: "conectores", area: "workspace", label: "Conectores", hint: "Ferramentas externas (MCP)", seal: "workspace" },
] as const satisfies readonly { id: string; area: SettingsArea; label: string; hint: string; seal: SettingsSeal }[];
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));
/** Sem seção no endereço: o topo da página (a primeira seção da plataforma). */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "senha";

/** Ids que já existiram (ou apelidos óbvios) -> a seção que hoje tem aquilo. Links antigos não quebram. */
const SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  maestro: "modelos",
  dispatch: "distribuicao",
  planos: "distribuicao",
  paralelo: "distribuicao",
  relatorio: "relatorios",
  daily: "relatorios",
  "modelos-globais": "modelos-padrao",
  globais: "modelos-padrao",
  bichos: "escritorio",
  aparencia: "escritorio",
  versoes: "versao",
  atualizacao: "versao",
  atualizacoes: "versao",
  update: "versao",
  armazenamento: "historico",
  motor: "motores",
  plataforma: "senha",
  workspace: "modelos",
  navegador: "seguranca",
  web: "seguranca",
  dominios: "seguranca",
  aprovacao: "aprovacoes",
  // As skills vão para a Biblioteca; até ela chegar, o que existe delas mora junto dos conectores.
  skills: "conectores",
  cyno: "cyno-ajustes",
  stdio: "conectores-locais",
  locais: "conectores-locais",
};

export function settingsSection(id: SettingsSectionId): SettingsSection {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
}

/** As seções de uma área, na ordem da página. */
export function settingsSectionsOf(area: SettingsArea): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.area === area);
}

/**
 * Seção aberta a partir do endereço: `#/<ws>/configuracoes/<seção>` ou, sem workspace,
 * `#/configuracoes/<seção>`. Ids antigos viram a seção equivalente; qualquer outra coisa = a primeira.
 */
export function settingsSectionFromHash(hash: string): SettingsSectionId {
  if (parseHash(hash).page !== "configuracoes" && !/^#?\/?configuracoes(\/|$)/.test(hash)) return DEFAULT_SETTINGS_SECTION;
  const parts = hash.replace(/^#\/?/, "").split(/[?]/)[0]!.split("/").filter(Boolean);
  const raw = parts[1] === "configuracoes" ? (parts[2] ?? "") : parts[0] === "configuracoes" ? (parts[1] ?? "") : "";
  if (SECTION_IDS.has(raw)) return raw as SettingsSectionId;
  return SECTION_ALIASES[raw] ?? DEFAULT_SETTINGS_SECTION;
}

/** Endereço das Configurações numa seção (a primeira seção fica sem sufixo; sem workspace, `#/configuracoes/...`). */
export function settingsHash(workspaceId: Location["workspaceId"], section: SettingsSectionId): string {
  const base = hashFor({ workspaceId, page: "configuracoes" });
  return section === DEFAULT_SETTINGS_SECTION ? base : `${base}/${section}`;
}

// ---------- Opções (para a busca e o resumo) ----------

/** Uma opção que o dono pode mexer ou conferir: título simples, o que faz e o que vale. */
export type SettingsOption = { id: string; section: SettingsSectionId; title: string; line: string; seal: SettingsSeal; keywords: string };

/** Catálogo das opções, na ordem da página (a busca olha título, frase e palavras-chave). */
export const SETTINGS_OPTIONS: readonly SettingsOption[] = [
  { id: "senha", section: "senha", title: "Senha do app", line: "Pede a senha em cada aparelho novo. Desligada, qualquer pessoa com o link entra.", seal: "plataforma", keywords: "login entrar proteger segurança" },
  { id: "trocar-senha", section: "senha", title: "Trocar a senha", line: "Troca a senha e desconecta os outros aparelhos.", seal: "plataforma", keywords: "mudar alterar senha sair desconectar" },
  { id: "motor-claude", section: "motores", title: "Claude Code", line: "A CLI da assinatura Claude que roda os agentes: estado, versão, caminho, teste e padrão.", seal: "plataforma", keywords: "motor claude anthropic cli versão instalado" },
  { id: "motor-gemini", section: "motores", title: "Antigravity", line: "A CLI da assinatura Gemini que roda os agentes: estado, versão, caminho, teste e padrão.", seal: "plataforma", keywords: "motor gemini google agy cli versão instalado" },
  { id: "motor-freebuff", section: "motores", title: "Freebuff", line: "Terminal de IA gratuito, pago por anúncios (por hora aberta): serve a qualquer papel.", seal: "plataforma", keywords: "motor freebuff codebuff gratuito anúncios horas" },
  { id: "motor-openclaw", section: "motores", title: "OpenClaw", line: "Assistente de código aberto (agent exec): conta pelo OpenRouter ou pela configuração do próprio programa, modelo e Verificar.", seal: "plataforma", keywords: "motor openclaw openrouter chave conta provedor modelo verificar instalado" },
  { id: "motor-hermes", section: "motores", title: "Hermes", line: "Agente de terminal da Nous Research: instalar, conta pelo OpenRouter ou pela configuração do próprio programa, modelo e Verificar.", seal: "plataforma", keywords: "motor hermes nous openrouter instalar chave conta provedor modelo verificar" },
  { id: "padrao-maestro", section: "modelos-padrao", title: "Modelo padrão do Maestro", line: "Vale para o Maestro de cada workspace novo.", seal: "plataforma", keywords: "modelo maestro sonnet opus haiku esforço padrão" },
  { id: "padrao-agentes", section: "modelos-padrao", title: "Modelo padrão dos agentes", line: "Cada agente novo nasce com este motor e modelo.", seal: "plataforma", keywords: "modelo agentes sonnet opus haiku gemini esforço padrão" },
  { id: "padrao-subagentes", section: "modelos-padrao", title: "Modelo padrão dos subagentes", line: "As cópias focadas que os agentes chamam usam este modelo.", seal: "plataforma", keywords: "modelo subagentes sonnet haiku gemini flash padrão" },
  { id: "padrao-cyno", section: "modelos-padrao", title: "Modelo do Cyno", line: "O agente da plataforma (a página do Cyno) usa este modelo.", seal: "plataforma", keywords: "modelo cyno sonnet opus haiku esforço padrão" },
  { id: "cyno-sono", section: "cyno-ajustes", title: "Quando o Cyno dorme", line: "Minutos parado até o processo do Cyno parar (a conversa continua guardada).", seal: "plataforma", keywords: "cyno dormir ocioso minutos acordar" },
  { id: "cyno-teto", section: "cyno-ajustes", title: "Teto de turnos do Cyno por dia", line: "Quantos turnos o Cyno pode usar por dia; protege a cota da sua assinatura.", seal: "plataforma", keywords: "cyno limite turnos cota teto dia gasto" },
  { id: "cyno-resumo", section: "cyno-ajustes", title: "Resumo diário do Cyno", line: "Uma mensagem por dia no chat com o resumo dos workspaces, montada por código. Desligado por padrão.", seal: "plataforma", keywords: "cyno resumo digest diário semanal hora" },
  { id: "avisos-tela", section: "avisos", title: "Aviso na tela", line: "O aviso com o botão Responder quando algo espera você, em qualquer página.", seal: "plataforma", keywords: "avisos notificação toast responder alerta" },
  { id: "avisos-som", section: "avisos", title: "Som dos avisos", line: "Um sino curto quando algo espera você, mesmo com a aba escondida. Desligado por padrão.", seal: "plataforma", keywords: "avisos som sino volume áudio alerta falha" },
  { id: "avisos-notificacao", section: "avisos", title: "Notificação do navegador", line: "Uma notificação com a aba escondida; ao clicar, o Cyno abre o item.", seal: "plataforma", keywords: "avisos notificação navegador permissão celular push alerta" },
  { id: "avisos-site-fechado", section: "avisos", title: "Avisar com o site fechado", line: "O aviso chega no celular ou no computador mesmo sem nenhuma aba aberta. Precisa de endereço seguro.", seal: "plataforma", keywords: "avisos push celular fechado notificação aparelho teste https iphone" },
  { id: "avisos-tipos", section: "avisos", title: "O que avisa", line: "Liga e desliga cada tipo de alerta: aprovação, pergunta, plano, falha, terminal, limite de uso.", seal: "plataforma", keywords: "avisos tipos alerta aprovação falha limite uso terminal" },
  { id: "avisos-silenciar", section: "avisos", title: "Silenciar um workspace", line: "Sem aviso, som nem notificação de um workspace, por 1 hora, até amanhã ou sempre.", seal: "plataforma", keywords: "avisos silenciar mudo workspace" },
  { id: "avisos-nao-perturbe", section: "avisos", title: "Não perturbe", line: "Pausa todos os avisos por 1 hora ou até amanhã, em todos os aparelhos.", seal: "plataforma", keywords: "avisos não perturbe silêncio pausa descanso" },
  { id: "conectores-locais", section: "conectores-locais", title: "Permitir conectores locais", line: "Conectores de comando e apps rodam programas nesta máquina. Liga ou desliga aqui; sem escolha, vale o .env.", seal: "plataforma", keywords: "stdio comando local apps instalar máquina segurança env" },
  { id: "hist-conversas", section: "historico", title: "Guardar as conversas das CLIs", line: "Por quanto tempo ficam as conversas internas do Claude Code no disco.", seal: "plataforma", keywords: "histórico apagar retenção disco dias conversas" },
  { id: "hist-logs", section: "historico", title: "Guardar os logs das tarefas", line: "Por quanto tempo fica o passo a passo de cada tarefa.", seal: "plataforma", keywords: "histórico apagar retenção disco dias logs" },
  { id: "hist-limpar", section: "historico", title: "Limpar o histórico agora", line: "Apaga já o que passou do prazo (tarefas e Cérebro nunca são apagados).", seal: "plataforma", keywords: "apagar limpar histórico disco espaço" },
  { id: "versao-instalada", section: "versao", title: "Versão instalada", line: "A versão do projeto, o número do build (commits) e o commit que roda agora.", seal: "plataforma", keywords: "versão build commit hash ramo branch release" },
  { id: "versao-atualizacao", section: "versao", title: "Atualizações no GitHub", line: "Avisa quando o ramo estável tem commits novos e mostra como atualizar. O app só avisa; quem atualiza é você.", seal: "plataforma", keywords: "atualizar atualização novidade github git pull docker pm2 verificar" },
  { id: "som", section: "escritorio", title: "Sons do escritório", line: "Liga o som do mapa do Escritório (teclado, elevador, ping-pong, fliperama) e o volume. Vem desligado.", seal: "navegador", keywords: "aparência som áudio volume barulho teclado elevador" },
  { id: "bichos", section: "escritorio", title: "Bichos do escritório", line: "Liga ou desliga o gato, o cachorro e a calopsita do escritório (e onde ela mora). Só enfeite.", seal: "navegador", keywords: "aparência gato cachorro calopsita pássaro pets enfeite" },
  { id: "ws-modelos", section: "modelos", title: "Modelos deste workspace", line: "Motor e modelo de cada agente novo daqui, do Maestro e dos subagentes.", seal: "workspace", keywords: "modelo agentes subagentes maestro sonnet haiku gemini esforço padrão" },
  { id: "ws-maestro-sempre", section: "modelos", title: "Manter o Maestro sempre rodando", line: "Ligado: o Maestro fica de pé o tempo todo. Desligado: acorda quando você pede e dorme depois.", seal: "workspace", keywords: "maestro terminal remote control ocioso" },
  { id: "ws-internet", section: "acesso", title: "Internet", line: "Os agentes pesquisam na web e leem páginas. Desligado: só trabalham com o que têm aqui.", seal: "workspace", keywords: "acesso web pesquisa páginas rede agentes" },
  { id: "ws-navegador", section: "acesso", title: "Navegador dos agentes", line: "Os agentes abrem um navegador que você acompanha ao vivo. Precisa da internet.", seal: "workspace", keywords: "acesso navegador browser agentes" },
  { id: "ws-terminal", section: "acesso", title: "Terminal no servidor", line: "Os agentes rodam comandos na sua máquina. Desligado por padrão; ligue só se precisar.", seal: "workspace", keywords: "acesso terminal comandos bash shell servidor máquina agentes" },
  { id: "ws-pastas", section: "pastas", title: "Pastas de trabalho", line: "Pastas do seu computador (um projeto, um vault do Obsidian) que os agentes leem e editam, só leitura ou com escrita.", seal: "workspace", keywords: "pastas projeto código vault obsidian notas arquivos diretório caminho leitura escrita agentes" },
  { id: "ws-aprovar", section: "seguranca", title: "Aprovação antes de publicar, enviar ou comprar", line: "Ações que saem em seu nome no navegador esperam o seu OK em Aprovações.", seal: "workspace", keywords: "segurança aprovação publicar enviar comprar navegador" },
  { id: "ws-rede-local", section: "seguranca", title: "Rede local", line: "Deixa os agentes abrirem endereços da sua casa ou empresa (localhost, 192.168...).", seal: "workspace", keywords: "segurança rede local localhost ip navegador" },
  { id: "ws-dominios", section: "seguranca", title: "Domínios permitidos e bloqueados", line: "Limita ou barra os sites que os agentes abrem.", seal: "workspace", keywords: "segurança domínios sites bloquear permitir lista" },
  { id: "ws-paralelo", section: "distribuicao", title: "Quantos trabalham ao mesmo tempo", line: "O limite de tarefas rodando juntas neste workspace e por agente; as outras esperam a vez.", seal: "workspace", keywords: "paralelo distribuição projetos tarefas simultâneo limite fila agentes" },
  { id: "ws-relatorios", section: "relatorios", title: "Horário do resumo do dia e da revisão da semana", line: "A que horas o servidor monta o resumo do dia e a revisão da semana (por código, sem gastar IA). Ficam guardados em Gestão > Relatórios.", seal: "workspace", keywords: "gestão relatórios resumo dia revisão semana horário daily segunda 18:30 pdf" },
  { id: "ws-relatorios-ia", section: "relatorios", title: "Parágrafo do Maestro nos relatórios", line: "Liga um parágrafo curto escrito pelo Maestro por cima dos números do dia ou da semana. Gasta um pouco da cota; vem desligado.", seal: "workspace", keywords: "gestão relatórios ia maestro parágrafo daily semana cota custo" },
  { id: "ws-aprovacoes", section: "aprovacoes", title: "Tipos de aprovação", line: "O que conta como aprovação e vai para Aprovações. Abre a lista em Aprovações.", seal: "workspace", keywords: "aprovações para você tipos pedir ok" },
  { id: "ws-conectores", section: "conectores", title: "Conectores", line: "Ferramentas externas (MCP) que o Maestro e os agentes usam. Vão para a Biblioteca.", seal: "workspace", keywords: "mcp ferramentas externas notion github biblioteca" },
];

/** Minúsculas e sem acento, para a busca achar "senha" em "Senha" e "agentes" em "ágentes". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Opções que casam com a busca (todas as palavras digitadas precisam aparecer); busca vazia = todas. */
export function searchSettings(query: string, options: readonly SettingsOption[] = SETTINGS_OPTIONS): SettingsOption[] {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = foldText(`${option.title} ${option.line} ${option.keywords} ${settingsSection(option.section).label}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** Ids das seções que têm alguma opção entre as achadas. */
export function sectionsWithMatches(matches: readonly SettingsOption[]): Set<SettingsSectionId> {
  return new Set(matches.map((option) => option.section));
}

// ---------- Resumo do topo e avisos ----------

/** Nome curto de um modelo: "sonnet" -> "Sonnet"; "gemini-3.8-flash-medium" -> "Gemini 3.8 Flash". */
export function modelShortName(choice: Partial<ModelChoice> | undefined): string {
  const model = choice?.model?.trim();
  if (!model) return choice?.engine === "gemini" ? "Gemini" : "padrão da CLI";
  const claude = /(sonnet|opus|haiku)/i.exec(model);
  if (claude) return claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1).toLowerCase();
  const gemini = /^gemini-(\d+(?:\.\d+)*)-(flash|pro)/i.exec(model);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2]!.charAt(0).toUpperCase()}${gemini[2]!.slice(1).toLowerCase()}`;
  return model;
}

export type SummaryItem = { id: string; label: string; value: string; tone: "ok" | "warn" | "neutral"; section: SettingsSectionId };

/** Os pontos que o dono mais confere. Dado que ainda não chegou vira "…" (neutro), nunca um valor inventado. */
export function buildSummary(input: {
  auth: { enabled: boolean } | null;
  engines: readonly EngineInfo[] | null;
  defaults: Pick<ModelDefaults, "agentes"> | null;
  connectorCount: number | null;
}): SummaryItem[] {
  const { auth, engines, defaults, connectorCount } = input;
  const cli = engines?.filter((info) => info.engine !== "mock") ?? null;
  return [
    { id: "senha", label: "Senha", value: auth ? (auth.enabled ? "ligada" : "desligada") : "…", tone: auth ? (auth.enabled ? "ok" : "warn") : "neutral", section: "senha" },
    {
      id: "motores",
      label: "Motores",
      value: cli ? (cli.length === 0 ? "nenhum" : cli.map((info) => `${info.label} ${info.available ? "✓" : "✗"}`).join(", ")) : "…",
      tone: cli ? (cli.length > 0 && cli.every((info) => info.available) ? "ok" : "warn") : "neutral",
      section: "motores",
    },
    { id: "modelo", label: "Modelo padrão", value: defaults ? modelShortName(defaults.agentes) : "…", tone: "neutral", section: "modelos-padrao" },
    { id: "conectores", label: "Conectores", value: connectorCount === null ? "…" : connectorCount === 1 ? "1 conector" : `${connectorCount} conectores`, tone: "neutral", section: "conectores" },
  ];
}

export type SettingsWarning = { id: string; text: string; section: SettingsSectionId };

/** O app está sendo aberto de fora da casa (nem localhost nem rede privada)? */
export function isRemoteHost(hostname: string): boolean {
  if (!hostname || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
  return !hostname.endsWith(".local");
}

/** Avisos para estados incomuns. Só avisa do que já foi lido (dado ausente não vira aviso). */
export function settingsWarnings(input: {
  auth: { enabled: boolean } | null;
  remote: boolean;
  workspaceName: string | null;
  access: Pick<WorkspaceAccess, "terminal" | "allowLocalNetwork"> | null;
}): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (input.auth && !input.auth.enabled) {
    warnings.push({
      id: "sem-senha",
      section: "senha",
      text: input.remote ? "Sem senha e o app está aberto de fora da sua rede: qualquer pessoa com o link entra e mexe em tudo." : "Sem senha: qualquer pessoa com o link entra e mexe em tudo.",
    });
  }
  const name = input.workspaceName ? ` no workspace ${input.workspaceName}` : "";
  if (input.access?.terminal) warnings.push({ id: "terminal", section: "acesso", text: `Terminal ligado${name}: os agentes podem rodar comandos na sua máquina.` });
  if (input.access?.allowLocalNetwork) warnings.push({ id: "rede-local", section: "seguranca", text: `Rede local liberada${name}: os agentes podem abrir painéis e serviços da sua casa ou empresa.` });
  return warnings;
}

/** Selo de um motor: disponível (verde) ou não (vermelho), sempre com o texto. */
export function engineStatus(info: EngineInfo): { tone: "success" | "danger"; label: string } {
  return info.available ? { tone: "success", label: "Disponível" } : { tone: "danger", label: "Indisponível" };
}

/** O que dizer de um motor, além do nome (o simulado não tem CLI; as CLIs mostram versão ou o motivo da falha). */
export function engineDetail(info: EngineInfo): string {
  if (info.engine === "mock") return "Agente simulado, sem CLI: serve para testar o escritório e não gasta nada.";
  if (!info.available) return info.reason ? `Não respondeu: ${info.reason}.` : "A CLI não respondeu.";
  return info.version ? `Versão ${info.version}` : "Instalado (a CLI não disse a versão).";
}

/** Texto sobre os modelos de uma CLI (o simulado não tem). */
export function engineModelsNote(info: EngineInfo): string | null {
  if (info.engine === "mock" || !info.available) return null;
  if (info.models.length === 0) return "Sem lista de modelos: vale o padrão da CLI.";
  return info.freeModel ? "Sugestões (o campo de modelo aceita qualquer nome que a CLI aceite):" : "Modelos que a CLI listou:";
}

/** "1,2 MB" (base 1024, uma casa decimal a partir de KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** Rótulo de uma opção de retenção: 0 = nunca apagar. */
export function retentionLabel(days: number): string {
  if (days <= 0) return "Nunca apagar";
  if (days === 1) return "1 dia";
  if (days % 365 === 0) return days === 365 ? "1 ano" : `${days / 365} anos`;
  return `${days} dias`;
}

/** Opções do select (as padrão, mais o valor atual se ele não estiver entre elas), "nunca" por último. */
export function retentionOptions(kind: keyof typeof RETENTION_DAY_OPTIONS, current: number): number[] {
  const options = new Set<number>([...RETENTION_DAY_OPTIONS[kind], current]);
  return [...options].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
}

// ---------- Modelos padrão ----------

/** Valores dos campos de motor/modelo/esforço (strings vazias = o padrão da CLI/do server). */
export type ChoiceValues = { engine: ModelChoice["engine"]; model: string; effort: AgentEffort | "" };

export function choiceValues(choice: ModelChoice): ChoiceValues {
  return { engine: choice.engine, model: choice.model ?? "", effort: choice.effort ?? "" };
}

/** Campos -> padrão (simulado não leva modelo nem esforço; vazio sai). */
export function choiceFromValues(values: ChoiceValues): ModelChoice {
  if (!isCliEngine(values.engine)) return { engine: values.engine };
  const model = values.model.trim();
  return { engine: values.engine, ...(model ? { model } : {}), ...(values.effort ? { effort: values.effort } : {}) };
}

/** Padrão dos subagentes de um motor a partir dos campos (vazio = sem padrão: o subagente herda o modelo do agente). */
export function subagentFromValues(model: string, effort: AgentEffort | ""): SubagentChoice | undefined {
  const trimmed = model.trim();
  const choice: SubagentChoice = { ...(trimmed ? { model: trimmed } : {}), ...(effort ? { effort } : {}) };
  return Object.keys(choice).length > 0 ? choice : undefined;
}

/** Os mesmos padrões? (para o "Salvar" só acender quando algo mudou) */
export function sameModelDefaults(a: ModelDefaults | null | undefined, b: ModelDefaults | null | undefined): boolean {
  const norm = (value: ModelDefaults | null | undefined) =>
    value
      ? JSON.stringify({
          maestro: choiceFromValues(choiceValues(value.maestro)),
          agentes: choiceFromValues(choiceValues(value.agentes)),
          subagentes: {
            claude: subagentFromValues(value.subagentes.claude?.model ?? "", value.subagentes.claude?.effort ?? "") ?? null,
            gemini: subagentFromValues(value.subagentes.gemini?.model ?? "", value.subagentes.gemini?.effort ?? "") ?? null,
          },
        })
      : "";
  return norm(a) === norm(b);
}
