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
 * Seções das Configurações, na ordem em que aparecem (cada área em sequência). Elas se juntam em páginas
 * (`SETTINGS_PAGES`): o índice lista as páginas e uma página mostra as suas seções. O id vai no endereço
 * (`#/<ws>/configuracoes/motores`). Cuidado: o id de uma seção nunca pode ser o id de uma página
 * (`navegador`, `gestao`...), senão o endereço sem workspace (`#/configuracoes/<seção>`) se confunde.
 */
export const SETTINGS_SECTIONS = [
  { id: "senha", area: "plataforma", label: "Acesso e senha", hint: "Quem pode abrir o app", seal: "plataforma" },
  { id: "motores", area: "plataforma", label: "Motores", hint: "O que está instalado e funcionando", seal: "plataforma" },
  { id: "contas", area: "plataforma", label: "Contas", hint: "Contas do Claude Code e do Antigravity neste servidor", seal: "plataforma" },
  { id: "limites", area: "plataforma", label: "Limites do plano", hint: "Pausar o trabalho quando o plano chega perto do fim", seal: "plataforma" },
  { id: "modelos-padrao", area: "plataforma", label: "Modelos padrão", hint: "Maestro, agentes, subagentes e Cyno", seal: "plataforma" },
  { id: "cyno-ajustes", area: "plataforma", label: "Cyno", hint: "Sono, teto de turnos e resumo", seal: "plataforma" },
  { id: "avisos", area: "plataforma", label: "Avisos", hint: "Som, notificação e o que avisa", seal: "plataforma" },
  { id: "versao", area: "plataforma", label: "Versão e atualizações", hint: "Qual versão roda e se há novidade", seal: "plataforma" },
  { id: "historico", area: "plataforma", label: "Histórico guardado", hint: "Conversas, logs e aprovações antigas", seal: "plataforma" },
  { id: "armazenamento", area: "plataforma", label: "Armazenamento dos motores", hint: "Quanto cada motor guarda em disco", seal: "plataforma" },
  { id: "conectores-locais", area: "plataforma", label: "Conectores locais", hint: "Comandos e apps nesta máquina", seal: "plataforma" },
  { id: "primeiro-uso", area: "plataforma", label: "Tela de primeiro uso", hint: "Mostra de novo a tela que quem instala vê, sem apagar nada", seal: "plataforma" },
  { id: "escritorio", area: "plataforma", label: "Aparência", hint: "Sons e bichos do escritório", seal: "navegador" },
  { id: "atalhos", area: "plataforma", label: "Atalhos do teclado", hint: "Abrir o chat do Maestro pelo teclado", seal: "navegador" },
  { id: "modelos", area: "workspace", label: "Modelos e Maestro", hint: "Agentes novos e o Maestro daqui", seal: "workspace" },
  { id: "distribuicao", area: "workspace", label: "Projetos e distribuição", hint: "Quantos trabalham ao mesmo tempo e aprovação de planos", seal: "workspace" },
  { id: "acesso", area: "workspace", label: "O que os agentes acessam", hint: "Internet, navegador e terminal", seal: "workspace" },
  { id: "seguranca", area: "workspace", label: "Segurança na web", hint: "Rede local, domínios e aprovação", seal: "workspace" },
  { id: "pastas", area: "workspace", label: "Pastas de trabalho", hint: "Projetos e vaults que os agentes usam", seal: "workspace" },
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
  plano: "distribuicao",
  planos: "distribuicao",
  paralelo: "distribuicao",
  aprovar: "distribuicao",
  autonomia: "distribuicao",
  "aprovacao-planos": "distribuicao",
  "plan-approval": "distribuicao",
  relatorio: "relatorios",
  daily: "relatorios",
  "modelos-globais": "modelos-padrao",
  globais: "modelos-padrao",
  bichos: "escritorio",
  aparencia: "escritorio",
  atalho: "atalhos",
  teclado: "atalhos",
  teclas: "atalhos",
  shortcuts: "atalhos",
  versoes: "versao",
  atualizacao: "versao",
  atualizacoes: "versao",
  update: "versao",
  disco: "armazenamento",
  cache: "armazenamento",
  espaco: "armazenamento",
  storage: "armazenamento",
  motor: "motores",
  conta: "contas",
  "contas-motores": "contas",
  limite: "limites",
  pausa: "limites",
  cota: "limites",
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
 * Páginas das Configurações: o que o índice lista. Cada uma junta uma ou mais seções de assunto parecido, para
 * uma seção pequena não virar página sozinha. A página é conhecida pela sua primeira seção (é ela que vai no
 * endereço); as seções de uma página são vizinhas em `SETTINGS_SECTIONS`.
 */
export const SETTINGS_PAGES = [
  { area: "plataforma", label: "Acesso e senha", hint: "Quem pode abrir o app", sections: ["senha"] },
  { area: "plataforma", label: "Motores", hint: "O que está instalado, contas e como funcionam", sections: ["motores", "contas"] },
  { area: "plataforma", label: "Limites do plano", hint: "Pausar o trabalho quando o plano chega perto do fim", sections: ["limites"] },
  { area: "plataforma", label: "Modelos e Cyno", hint: "Modelos padrão e o jeito do Cyno", sections: ["modelos-padrao", "cyno-ajustes"] },
  { area: "plataforma", label: "Avisos", hint: "Som, notificação e o que avisa", sections: ["avisos"] },
  { area: "plataforma", label: "Sistema", hint: "Versão, histórico guardado, armazenamento dos motores, conectores locais e tela de primeiro uso", sections: ["versao", "historico", "armazenamento", "conectores-locais", "primeiro-uso"] },
  { area: "plataforma", label: "Aparência e atalhos", hint: "Sons, bichos e teclado deste navegador", sections: ["escritorio", "atalhos"] },
  { area: "workspace", label: "Agentes e Maestro", hint: "Modelos, distribuição e aprovação de planos", sections: ["modelos", "distribuicao"] },
  { area: "workspace", label: "Acesso e segurança", hint: "Internet, navegador, terminal e domínios", sections: ["acesso", "seguranca"] },
  { area: "workspace", label: "Pastas de trabalho", hint: "Projetos e vaults que os agentes usam", sections: ["pastas"] },
  { area: "workspace", label: "Relatórios e aprovações", hint: "Resumo do dia, revisão da semana e o que pede o seu OK", sections: ["relatorios", "aprovacoes"] },
  { area: "workspace", label: "Conectores", hint: "Ferramentas externas (MCP)", sections: ["conectores"] },
] as const satisfies readonly { area: SettingsArea; label: string; hint: string; sections: readonly [SettingsSectionId, ...SettingsSectionId[]] }[];
export type SettingsPageInfo = (typeof SETTINGS_PAGES)[number];

/** A página que mostra uma seção. */
export function settingsPageOf(section: SettingsSectionId): SettingsPageInfo {
  return SETTINGS_PAGES.find((page) => (page.sections as readonly SettingsSectionId[]).includes(section)) ?? SETTINGS_PAGES[0];
}

/** As páginas de uma área, na ordem do índice. */
export function settingsPagesOf(area: SettingsArea): SettingsPageInfo[] {
  return SETTINGS_PAGES.filter((page) => page.area === area);
}

/** O selo de uma página: o das suas seções quando todas concordam; senão nenhum (cada seção mostra o seu). */
export function settingsPageSeal(page: SettingsPageInfo): SettingsSeal | null {
  const seals = new Set(page.sections.map((id) => settingsSection(id).seal));
  return seals.size === 1 ? [...seals][0]! : null;
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

/**
 * Endereço das Configurações numa seção (sem workspace, `#/configuracoes/...`). A primeira seção fica sem sufixo,
 * a não ser com `explicit`: no celular o endereço sem seção é o menu, então abrir a primeira página pede o sufixo.
 */
export function settingsHash(workspaceId: Location["workspaceId"], section: SettingsSectionId, explicit = false): string {
  const base = hashFor({ workspaceId, page: "configuracoes" });
  return section === DEFAULT_SETTINGS_SECTION && !explicit ? base : `${base}/${section}`;
}

/** O endereço diz qual seção abrir (`.../configuracoes/<algo>`)? Sem isso, no celular, abre o menu. */
export function settingsHashHasSection(hash: string): boolean {
  return /(^|\/)configuracoes\/[^/?]+/.test(hash.replace(/^#\/?/, ""));
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
  { id: "contas-motores", section: "contas", title: "Contas dos motores", line: "Entrar pelo navegador, instalar e cadastrar contas extras do Claude Code e do Antigravity.", seal: "plataforma", keywords: "contas conta login entrar claude antigravity gemini instalar perfil" },
  { id: "limite-plano", section: "limites", title: "Pausar ao chegar no limite do plano", line: "Ao bater o percentual, os agentes do motor param e voltam sozinhos quando a janela reinicia.", seal: "plataforma", keywords: "limite uso plano pausa pausar cota 5 horas semanal semana percentual 90 reset voltar assinatura" },
  { id: "limite-carteira", section: "limites", title: "Não gastar a carteira do Freebuff", line: "Para o Freebuff quando a cota do dia acaba, em vez de gastar o saldo da carteira.", seal: "plataforma", keywords: "freebuff carteira wallet saldo horas cota diária" },
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
  { id: "primeiro-uso", section: "primeiro-uso", title: "Rever tela de primeiro uso", line: "Mostra de novo a tela que quem instala vê, sem apagar nada.", seal: "plataforma", keywords: "primeiro uso boas vindas onboarding rever inicial tela cyno" },
  { id: "hist-conversas", section: "historico", title: "Guardar as conversas das CLIs", line: "Por quanto tempo ficam as conversas internas do Claude Code no disco.", seal: "plataforma", keywords: "histórico apagar retenção disco dias conversas" },
  { id: "hist-logs", section: "historico", title: "Guardar os logs das tarefas", line: "Por quanto tempo fica o passo a passo de cada tarefa.", seal: "plataforma", keywords: "histórico apagar retenção disco dias logs" },
  { id: "hist-aprovacoes", section: "historico", title: "Aprovações decididas", line: "Por quanto tempo uma aprovação decidida fica na lista antes de ir para o arquivo.", seal: "plataforma", keywords: "aprovações arquivo arquivar antigas lista dias decididas mais antigos" },
  { id: "hist-limpar", section: "historico", title: "Limpar o histórico agora", line: "Apaga já o que passou do prazo (tarefas e Cérebro nunca são apagados).", seal: "plataforma", keywords: "apagar limpar histórico disco espaço" },
  { id: "arm-uso", section: "armazenamento", title: "Quanto cada motor guarda", line: "Tamanho em disco do Claude Code, Antigravity, Freebuff, Hermes e OpenClaw.", seal: "plataforma", keywords: "armazenamento disco espaço cache tamanho motor gigas mb pasta" },
  { id: "arm-antigravity-logs", section: "armazenamento", title: "Logs do Antigravity", line: "Apagar sozinho os logs antigos do Antigravity (nunca, 7, 14, 30 ou 90 dias).", seal: "plataforma", keywords: "armazenamento disco antigravity agy logs log apagar limpar dias" },
  { id: "arm-freebuff-chats", section: "armazenamento", title: "Chats dos agentes no Freebuff", line: "Apagar sozinho os chats antigos dos agentes do Cyno no Freebuff (nunca, 7, 14, 30 ou 90 dias).", seal: "plataforma", keywords: "armazenamento disco freebuff chats conversas apagar limpar dias" },
  { id: "arm-limpar", section: "armazenamento", title: "Limpar o armazenamento agora", line: "Mostra o que sairia e apaga só o que for dos agentes do Cyno.", seal: "plataforma", keywords: "armazenamento apagar limpar disco espaço cache" },
  { id: "versao-instalada", section: "versao", title: "Versão instalada", line: "A versão do projeto, o número do build (commits) e o commit que roda agora.", seal: "plataforma", keywords: "versão build commit hash ramo branch release" },
  { id: "versao-atualizacao", section: "versao", title: "Atualizações no GitHub", line: "Avisa quando o ramo estável tem commits novos e mostra como atualizar. O app só avisa; quem atualiza é você.", seal: "plataforma", keywords: "atualizar atualização novidade github git pull docker pm2 verificar" },
  { id: "som", section: "escritorio", title: "Sons do escritório", line: "Liga o som do mapa do Escritório (teclado, elevador, ping-pong, fliperama) e o volume. Vem desligado.", seal: "navegador", keywords: "aparência som áudio volume barulho teclado elevador" },
  { id: "bichos", section: "escritorio", title: "Bichos do escritório", line: "Liga ou desliga o gato, o cachorro e a calopsita do escritório (e onde ela mora). Só enfeite.", seal: "navegador", keywords: "aparência gato cachorro calopsita pássaro pets enfeite" },
  { id: "atalho-maestro", section: "atalhos", title: "Abrir o chat do Maestro", line: "O atalho que abre o chat do Maestro de qualquer tela (padrão Ctrl+K). Dá para trocar a combinação.", seal: "navegador", keywords: "atalho teclado tecla ctrl k comando bind combinação maestro chat abrir shortcut" },
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
  { id: "ws-aprovacao-planos", section: "distribuicao", title: "Aprovação de planos", line: "Se o Maestro pede o seu OK antes de começar um projeto novo ou começa direto.", seal: "workspace", keywords: "aprovação aprovar plano planos autonomia maestro sempre nunca pedir projetos distribuição" },
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

// ---------- Estado no índice e avisos ----------

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

/** Estado curto que vai ao lado do nome da seção no índice (o índice faz as vezes de resumo). */
export type NavBadge = { text: string; tone: "ok" | "warn" | "neutral" };

/**
 * O estado das seções que o dono mais confere, em poucas letras: senha ligada ou desligada, quantos motores
 * funcionam, se há pausa por limite do plano, o modelo padrão e quantos conectores há. Dado que ainda não chegou
 * não vira selo.
 */
export function navBadges(input: {
  auth: { enabled: boolean } | null;
  engines: readonly EngineInfo[] | null;
  defaults: Pick<ModelDefaults, "agentes"> | null;
  connectorCount: number | null;
  /** Pausas por limite do plano valendo agora (ausente ou null: ainda não se sabe). */
  pauses?: number | null;
}): Partial<Record<SettingsSectionId, NavBadge>> {
  const { auth, engines, defaults, connectorCount } = input;
  const badges: Partial<Record<SettingsSectionId, NavBadge>> = {};
  if (auth) badges.senha = auth.enabled ? { text: "ligada", tone: "ok" } : { text: "desligada", tone: "warn" };
  if (engines) {
    const cli = engines.filter((info) => info.engine !== "mock");
    const working = cli.filter((info) => info.available).length;
    badges.motores = cli.length === 0 ? { text: "nenhum", tone: "warn" } : { text: `${working} de ${cli.length}`, tone: working === cli.length ? "ok" : "warn" };
  }
  if (input.pauses) badges.limites = { text: input.pauses === 1 ? "1 pausa" : `${input.pauses} pausas`, tone: "warn" };
  if (defaults) badges["modelos-padrao"] = { text: modelShortName(defaults.agentes), tone: "neutral" };
  if (connectorCount !== null) badges.conectores = { text: String(connectorCount), tone: "neutral" };
  return badges;
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

/**
 * Rótulo de uma opção de retenção: 0 = nunca apagar. Nas aprovações decididas nada é apagado (só sai da lista para o
 * arquivo), então o 0 vira "Sempre" (na lista para sempre).
 */
export function retentionLabel(days: number, kind?: keyof typeof RETENTION_DAY_OPTIONS): string {
  if (days <= 0) return kind === "approvals" ? "Sempre" : "Nunca apagar";
  if (days === 1) return "1 dia";
  if (days % 365 === 0) return days === 365 ? "1 ano" : `${days / 365} anos`;
  return `${days} dias`;
}

/** Opções do select (as padrão, mais o valor atual se ele não estiver entre elas), "nunca" por último. */
export function retentionOptions(kind: keyof typeof RETENTION_DAY_OPTIONS, current: number): number[] {
  const options = new Set<number>([...RETENTION_DAY_OPTIONS[kind], current]);
  return [...options].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
}

/** Prazos do "Apagar sozinho depois de" das avulsas terminadas (0 = Nunca, o padrão). */
export const AVULSAS_AUTO_DAYS = [0, 7, 14, 30, 90, 180] as const;

/** Opções do select das avulsas: Nunca primeiro, depois os prazos (e o valor atual, se vier de fora da lista). */
export function avulsasDaysOptions(current: number): number[] {
  const options = new Set<number>([...AVULSAS_AUTO_DAYS, current]);
  return [...options].sort((a, b) => a - b);
}

/** "Nunca" ou "30 dias". */
export function avulsasDaysLabel(days: number): string {
  if (days <= 0) return "Nunca";
  return days === 1 ? "1 dia" : `${days} dias`;
}

/** O selo da linha: "Nunca apaga" ou "Apaga depois de 30 dias". */
export function avulsasDaysBadge(days: number): string {
  return days <= 0 ? "Nunca apaga" : `Apaga depois de ${avulsasDaysLabel(days)}`;
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
