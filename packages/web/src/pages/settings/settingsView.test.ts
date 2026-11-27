import type { EngineInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { INITIAL_MODEL_DEFAULTS } from "@cyno/shared";
import {
  choiceFromValues,
  choiceValues,
  engineDetail,
  engineModelsNote,
  engineStatus,
  formatBytes,
  retentionLabel,
  avulsasDaysBadge,
  avulsasDaysLabel,
  avulsasDaysOptions,
  retentionOptions,
  sameModelDefaults,
  navBadges,
  DEFAULT_SETTINGS_SECTION,
  isRemoteHost,
  modelShortName,
  SEAL_LABELS,
  searchSettings,
  sectionsWithMatches,
  settingsHash,
  settingsHashHasSection,
  settingsPageOf,
  settingsPageSeal,
  settingsPagesOf,
  SETTINGS_PAGES,
  settingsSection,
  settingsSectionFromHash,
  settingsSectionsOf,
  settingsWarnings,
  SETTINGS_OPTIONS,
  SETTINGS_SECTIONS,
  subagentFromValues,
} from "./settingsView";
import { parseHash } from "../../store/navStore";

const MOCK: EngineInfo = { engine: "mock", label: "Simulado", available: true, models: [], freeModel: false };
const CLAUDE: EngineInfo = { engine: "claude", label: "Claude Code", available: true, version: "2.1.319 (Claude Code)", models: [{ id: "sonnet", label: "Sonnet" }], freeModel: true };
const AGY_OFF: EngineInfo = { engine: "gemini", label: "Antigravity", available: false, reason: "comando agy não encontrado", models: [], freeModel: false };
const AGY_ON: EngineInfo = { engine: "gemini", label: "Antigravity", available: true, version: "1.5.3", models: [{ id: "gemini-3.8-flash-low" }], freeModel: false };

describe("seção das Configurações no endereço", () => {
  it("lê a seção depois de configuracoes e cai na primeira se não reconhecer", () => {
    expect(settingsSectionFromHash("#/principal/configuracoes/motores")).toBe("motores");
    expect(settingsSectionFromHash("#/principal/configuracoes/skills")).toBe("senha") // `skills` agora redireciona para #/biblioteca/skills;
    expect(settingsSectionFromHash("#/principal/configuracoes")).toBe("senha");
    expect(settingsSectionFromHash("#/principal/configuracoes/nada")).toBe("senha");
    // Outra página com o mesmo sufixo não abre seção nenhuma.
    expect(settingsSectionFromHash("#/principal/cerebro/motores")).toBe("senha");
    expect(settingsSectionFromHash("")).toBe("senha");
  });

  it("monta o endereço e volta à mesma seção", () => {
    expect(settingsHash("principal", "senha")).toBe("#/principal/configuracoes");
    expect(settingsHash("principal", "motores")).toBe("#/principal/configuracoes/motores");
    expect(settingsHash(null, "conectores")).toBe("#/configuracoes/conectores");
    for (const section of SETTINGS_SECTIONS) expect(settingsSectionFromHash(settingsHash("ws1", section.id))).toBe(section.id);
  });

  it("sem workspace no endereço (#/configuracoes/<seção>) também ida e volta", () => {
    expect(settingsHash(null, "senha")).toBe("#/configuracoes");
    expect(settingsSectionFromHash("#/configuracoes")).toBe("senha");
    expect(settingsSectionFromHash("#/configuracoes/motores")).toBe("motores");
    for (const section of SETTINGS_SECTIONS) expect(settingsSectionFromHash(settingsHash(null, section.id))).toBe(section.id);
  });

  it("no celular o endereço sem seção é o menu: a primeira página pede a seção escrita", () => {
    expect(settingsHash("ws1", "senha", true)).toBe("#/ws1/configuracoes/senha");
    expect(settingsHash(null, "motores", true)).toBe("#/configuracoes/motores");
    expect(settingsHashHasSection("#/ws1/configuracoes")).toBe(false);
    expect(settingsHashHasSection("#/configuracoes")).toBe(false);
    expect(settingsHashHasSection("#/ws1/configuracoes/senha")).toBe(true);
    expect(settingsHashHasSection("#/configuracoes/motores")).toBe(true);
    expect(settingsHashHasSection("#/ws1/arquivos")).toBe(false);
  });

  it("links antigos e apelidos caem na seção equivalente", () => {
    // "modelos" continua existindo: é a seção do workspace (padrões + Maestro).
    expect(settingsSectionFromHash("#/principal/configuracoes/modelos")).toBe("modelos");
    expect(settingsSectionFromHash("#/principal/configuracoes/maestro")).toBe("modelos");
    expect(settingsSectionFromHash("#/principal/configuracoes/dispatch")).toBe("distribuicao");
    expect(settingsSectionFromHash("#/principal/configuracoes/modelos-globais")).toBe("modelos-padrao");
    expect(settingsSectionFromHash("#/principal/configuracoes/conectores")).toBe("conectores");
  });
});

describe("áreas das Configurações", () => {
  it("Da plataforma: acesso, motores, contas, modelos padrão, histórico, aparência; Do workspace: o resto", () => {
    expect(settingsSectionsOf("plataforma").map((section) => section.id)).toEqual(["senha", "motores", "contas", "limites", "modelos-padrao", "cyno-ajustes", "avisos", "versao", "historico", "armazenamento", "conectores-locais", "primeiro-uso", "escritorio", "atalhos"]);
    expect(settingsSectionsOf("workspace").map((section) => section.id)).toEqual(["modelos", "distribuicao", "acesso", "seguranca", "pastas", "relatorios", "aprovacoes", "conectores"]);
    // As áreas vêm em ordem na página (toda a plataforma antes do workspace).
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...settingsSectionsOf("plataforma"), ...settingsSectionsOf("workspace")].map((section) => section.id));
  });

  it("o selo de cada seção bate com a área (e a aparência é só do navegador)", () => {
    for (const section of SETTINGS_SECTIONS) {
      if (section.id === "escritorio" || section.id === "atalhos") expect(section.seal).toBe("navegador");
      else expect(section.seal).toBe(section.area);
    }
    expect(SEAL_LABELS).toEqual({ plataforma: "Toda a plataforma", workspace: "Só este workspace", navegador: "Só neste navegador" });
  });

  it("nenhuma seção tem o id de uma página (senão #/configuracoes/<seção> se confunde com a página)", () => {
    for (const section of SETTINGS_SECTIONS) expect(parseHash(`#/configuracoes/${section.id}`)).toEqual({ workspaceId: null, page: "configuracoes", sub: section.id });
  });

  it("todo id de opção do catálogo aponta para uma seção que existe, com o selo da seção", () => {
    const ids = new Set(SETTINGS_SECTIONS.map((section) => section.id as string));
    expect(new Set(SETTINGS_OPTIONS.map((option) => option.id)).size).toBe(SETTINGS_OPTIONS.length);
    for (const option of SETTINGS_OPTIONS) {
      expect(ids.has(option.section)).toBe(true);
      expect(option.seal).toBe(settingsSection(option.section).seal);
      expect(option.line.length).toBeGreaterThan(10);
    }
  });
});

describe("busca por nome da opção", () => {
  it("busca vazia devolve todas; ignora acento e caixa", () => {
    expect(searchSettings("").length).toBe(SETTINGS_OPTIONS.length);
    expect(searchSettings("SENHA").map((option) => option.id)).toContain("senha");
    expect(searchSettings("conexão").length).toBe(0);
    expect(searchSettings("seguranca").map((option) => option.section)).toContain("seguranca");
    // Armazenamento dos motores: acha por disco, cache e espaço.
    for (const term of ["disco", "cache", "espaço", "armazenamento", "freebuff chats", "antigravity logs"]) expect(searchSettings(term).map((option) => option.section)).toContain("armazenamento");
  });

  it("todas as palavras precisam aparecer", () => {
    expect(searchSettings("terminal servidor").map((option) => option.id)).toEqual(["ws-terminal"]);
    expect(searchSettings("terminal xyzzy")).toEqual([]);
  });

  it("acha pelo apelido (paralelo, gemini, localhost) e diz de que seção veio", () => {
    expect(searchSettings("paralelo").map((option) => option.id)).toEqual(["ws-paralelo"]);
    expect(searchSettings("localhost").map((option) => option.id)).toContain("ws-rede-local");
    expect(sectionsWithMatches(searchSettings("gemini"))).toEqual(new Set(["motores", "contas", "modelos-padrao", "modelos"]));
    expect(searchSettings("contas").map((option) => option.section)).toContain("contas");
    for (const term of ["aprovação", "aprovar", "plano", "autonomia"]) {
      expect(searchSettings(term).map((option) => option.id)).toContain("ws-aprovacao-planos");
    }
  });
});

describe("endereços das seções novas e antigas", () => {
  it("ida e volta de todas as seções, com e sem workspace", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsSectionFromHash(settingsHash("ws1", section.id))).toBe(section.id);
      expect(settingsSectionFromHash(settingsHash(null, section.id))).toBe(section.id);
    }
    expect(settingsHash(null, "motores")).toBe("#/configuracoes/motores");
    expect(settingsHash("ws1", "acesso")).toBe("#/ws1/configuracoes/acesso");
    expect(settingsHash("ws1", DEFAULT_SETTINGS_SECTION)).toBe("#/ws1/configuracoes");
  });

  it("apelidos antigos viram a seção que tem aquilo hoje", () => {
    expect(settingsSectionFromHash("#/ws1/configuracoes/skills")).toBe("senha") // idem: vai para a Biblioteca;
    expect(settingsSectionFromHash("#/ws1/configuracoes/paralelo")).toBe("distribuicao");
    expect(settingsSectionFromHash("#/ws1/configuracoes/dominios")).toBe("seguranca");
    expect(settingsSectionFromHash("#/ws1/configuracoes/aparencia")).toBe("escritorio");
    expect(settingsSectionFromHash("#/ws1/configuracoes/armazenamento")).toBe("armazenamento");
    expect(settingsSectionFromHash("#/ws1/configuracoes/contas")).toBe("contas");
    expect(settingsSectionFromHash("#/ws1/configuracoes/conta")).toBe("contas");
    for (const alias of ["disco", "cache", "espaco"]) expect(settingsSectionFromHash(`#/ws1/configuracoes/${alias}`)).toBe("armazenamento");
    for (const alias of ["plano", "planos", "aprovar", "autonomia", "aprovacao-planos", "plan-approval"]) {
      expect(settingsSectionFromHash(`#/ws1/configuracoes/${alias}`)).toBe("distribuicao");
    }
    expect(settingsSectionFromHash("#/configuracoes/plataforma")).toBe("senha");
  });
});

describe("páginas das Configurações", () => {
  it("toda seção mora em uma página só, na mesma área e na ordem das seções", () => {
    expect(SETTINGS_PAGES.flatMap((page) => [...page.sections])).toEqual(SETTINGS_SECTIONS.map((section) => section.id));
    for (const page of SETTINGS_PAGES) for (const id of page.sections) expect(settingsSection(id).area).toBe(page.area);
    expect(SETTINGS_PAGES.length).toBeLessThan(SETTINGS_SECTIONS.length);
  });

  it("acha a página de uma seção e as páginas de cada área", () => {
    expect(settingsPageOf("historico").label).toBe("Sistema");
    expect(settingsPageOf("armazenamento").label).toBe("Sistema");
    expect(settingsPageOf("armazenamento").sections).toEqual(["versao", "historico", "armazenamento", "conectores-locais", "primeiro-uso"]);
    expect(settingsPageOf("distribuicao").sections[0]).toBe("modelos");
    expect(settingsPageOf("senha").sections).toEqual(["senha"]);
    expect(settingsPagesOf("plataforma").map((page) => page.label)).toEqual(["Acesso e senha", "Motores", "Limites do plano", "Modelos e Cyno", "Avisos", "Sistema", "Aparência e atalhos"]);
    expect(settingsPagesOf("workspace").map((page) => page.label)).toEqual(["Agentes e Maestro", "Acesso e segurança", "Pastas de trabalho", "Relatórios e aprovações", "Conectores"]);
  });

  it("o selo da página só existe quando as seções concordam", () => {
    expect(settingsPageSeal(settingsPageOf("escritorio"))).toBe("navegador");
    expect(settingsPageSeal(settingsPageOf("modelos"))).toBe("workspace");
    expect(settingsPageSeal(settingsPageOf("versao"))).toBe("plataforma");
  });
});

describe("nome curto do modelo", () => {
  it("encurta o nome dos modelos conhecidos", () => {
    expect(modelShortName({ engine: "claude", model: "opus" })).toBe("Opus");
    expect(modelShortName({ engine: "claude", model: "claude-haiku-4-5" })).toBe("Haiku");
    expect(modelShortName({ engine: "gemini", model: "gemini-3.8-flash-medium" })).toBe("Gemini 3.8 Flash");
    expect(modelShortName({ engine: "claude" })).toBe("padrão da CLI");
    expect(modelShortName({ engine: "gemini", model: "outro" })).toBe("outro");
  });
});

describe("estado das seções no índice", () => {
  const defaults = { agentes: { engine: "claude", model: "sonnet", effort: "medium" } } as const;
  it("resume senha, motores, modelo padrão e conectores em poucas letras", () => {
    expect(navBadges({ auth: { enabled: false }, engines: [MOCK, CLAUDE, AGY_OFF], defaults, connectorCount: 3 })).toEqual({
      senha: { text: "desligada", tone: "warn" },
      motores: { text: "1 de 2", tone: "warn" },
      "modelos-padrao": { text: "Sonnet", tone: "neutral" },
      conectores: { text: "3", tone: "neutral" },
    });
    expect(navBadges({ auth: { enabled: true }, engines: [CLAUDE, AGY_ON], defaults: null, connectorCount: null })).toEqual({
      senha: { text: "ligada", tone: "ok" },
      motores: { text: "2 de 2", tone: "ok" },
    });
  });

  it("pausa por limite do plano aparece só quando há alguma", () => {
    const base = { auth: null, engines: null, defaults: null, connectorCount: null };
    expect(navBadges({ ...base, pauses: 0 })).toEqual({});
    expect(navBadges({ ...base, pauses: 1 })).toEqual({ limites: { text: "1 pausa", tone: "warn" } });
    expect(navBadges({ ...base, pauses: 2 })).toEqual({ limites: { text: "2 pausas", tone: "warn" } });
  });

  it("sem motor nenhum pede atenção; dado que não chegou não vira selo", () => {
    expect(navBadges({ auth: null, engines: [MOCK], defaults: null, connectorCount: null })).toEqual({ motores: { text: "nenhum", tone: "warn" } });
    expect(navBadges({ auth: null, engines: null, defaults: null, connectorCount: null })).toEqual({});
  });
});

describe("avisos de estados incomuns", () => {
  const quiet = { terminal: false, allowLocalNetwork: false };
  it("nada de aviso quando está tudo no padrão (ou o dado ainda não chegou)", () => {
    expect(settingsWarnings({ auth: { enabled: true }, remote: true, workspaceName: "A", access: quiet })).toEqual([]);
    expect(settingsWarnings({ auth: null, remote: true, workspaceName: null, access: null })).toEqual([]);
  });

  it("terminal ligado, rede local liberada e senha desligada", () => {
    const warnings = settingsWarnings({ auth: { enabled: false }, remote: true, workspaceName: "Principal", access: { terminal: true, allowLocalNetwork: true } });
    expect(warnings.map((warning) => [warning.id, warning.section])).toEqual([
      ["sem-senha", "senha"],
      ["terminal", "acesso"],
      ["rede-local", "seguranca"],
    ]);
    expect(warnings[0]!.text).toMatch(/de fora da sua rede/);
    expect(warnings[1]!.text).toMatch(/Principal/);
    expect(settingsWarnings({ auth: { enabled: false }, remote: false, workspaceName: null, access: null })[0]!.text).not.toMatch(/de fora/);
  });

  it("reconhece o app aberto de fora da rede", () => {
    expect(isRemoteHost("app.exemplo.com")).toBe(true);
    for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "10.0.0.4", "172.20.1.1", "casa.local"]) expect(isRemoteHost(host)).toBe(false);
    expect(isRemoteHost("172.32.0.1")).toBe(true);
  });
});

describe("cartões dos motores", () => {
  it("o selo diz se a CLI está disponível", () => {
    expect(engineStatus(CLAUDE)).toEqual({ tone: "success", label: "Disponível" });
    expect(engineStatus(AGY_OFF)).toEqual({ tone: "danger", label: "Indisponível" });
  });

  it("mostra a versão, o motivo da falha ou que o simulado não tem CLI", () => {
    expect(engineDetail(CLAUDE)).toBe("Versão 2.1.319 (Claude Code)");
    expect(engineDetail(AGY_OFF)).toBe("Não respondeu: comando agy não encontrado.");
    expect(engineDetail({ ...AGY_OFF, reason: undefined })).toBe("A CLI não respondeu.");
    expect(engineDetail({ ...AGY_ON, version: undefined })).toBe("Instalado (a CLI não disse a versão).");
    expect(engineDetail(MOCK)).toMatch(/simulado/i);
  });

  it("só fala de modelos de CLI disponível", () => {
    expect(engineModelsNote(MOCK)).toBeNull();
    expect(engineModelsNote(AGY_OFF)).toBeNull();
    expect(engineModelsNote(CLAUDE)).toMatch(/qualquer nome/);
    expect(engineModelsNote(AGY_ON)).toBe("Modelos que a CLI listou:");
    expect(engineModelsNote({ ...AGY_ON, models: [] })).toBe("Sem lista de modelos: vale o padrão da CLI.");
  });
});

describe("seção Histórico", () => {
  it("abre pelo endereço", () => {
    expect(settingsSectionFromHash("#/principal/configuracoes/historico")).toBe("historico");
  });

  it("bytes legíveis", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("rótulos e opções dos dias (0 = nunca, por último; o valor atual sempre aparece)", () => {
    expect(retentionLabel(0)).toBe("Nunca apagar");
    expect(retentionLabel(1)).toBe("1 dia");
    expect(retentionLabel(90)).toBe("90 dias");
    expect(retentionLabel(365)).toBe("1 ano");
    expect(retentionOptions("transcripts", 7)).toEqual([1, 3, 7, 14, 30, 90, 0]);
    expect(retentionLabel(0, "approvals")).toBe("Sempre");
    expect(retentionLabel(7, "approvals")).toBe("7 dias");
    expect(retentionLabel(0, "logs")).toBe("Nunca apagar");
    expect(retentionOptions("approvals", 7)).toEqual([1, 3, 7, 14, 30, 0]);
    expect(retentionOptions("approvals", 10)).toEqual([1, 3, 7, 10, 14, 30, 0]);
    expect(retentionOptions("logs", 45)).toEqual([7, 30, 45, 90, 180, 365, 0]);
  });
});

describe("modelos padrão (campos)", () => {
  it("ida e volta dos campos; simulado e vazios saem", () => {
    expect(choiceFromValues(choiceValues({ engine: "claude", model: "opus", effort: "high" }))).toEqual({ engine: "claude", model: "opus", effort: "high" });
    expect(choiceFromValues({ engine: "claude", model: " ", effort: "" })).toEqual({ engine: "claude" });
    expect(choiceFromValues({ engine: "mock", model: "sonnet", effort: "low" })).toEqual({ engine: "mock" });
    expect(subagentFromValues(" haiku ", "low")).toEqual({ model: "haiku", effort: "low" });
    expect(subagentFromValues("", "")).toBeUndefined();
  });

  it("sameModelDefaults ignora diferenças que não mudam nada", () => {
    expect(sameModelDefaults(INITIAL_MODEL_DEFAULTS, structuredClone(INITIAL_MODEL_DEFAULTS))).toBe(true);
    expect(sameModelDefaults(INITIAL_MODEL_DEFAULTS, { ...INITIAL_MODEL_DEFAULTS, agentes: { engine: "claude", model: "opus", effort: "medium" } })).toBe(false);
    expect(sameModelDefaults({ ...INITIAL_MODEL_DEFAULTS, maestro: { engine: "mock", model: "x" } }, { ...INITIAL_MODEL_DEFAULTS, maestro: { engine: "mock" } })).toBe(true);
    expect(sameModelDefaults(null, INITIAL_MODEL_DEFAULTS)).toBe(false);
  });

  it("as duas seções de modelos têm endereço próprio", () => {
    expect(settingsSectionFromHash("#/principal/configuracoes/modelos")).toBe("modelos");
    expect(settingsSectionFromHash("#/principal/configuracoes/modelos-padrao")).toBe("modelos-padrao");
  });
});

describe("seções novas: Cyno e Conectores locais", () => {
  it("existem na área da plataforma, abrem por endereço e entram na busca", () => {
    expect(settingsSectionFromHash("#/principal/configuracoes/cyno-ajustes")).toBe("cyno-ajustes");
    expect(settingsSectionFromHash("#/configuracoes/cyno")).toBe("cyno-ajustes");
    expect(settingsSectionFromHash("#/configuracoes/conectores-locais")).toBe("conectores-locais");
    expect(settingsSectionFromHash("#/configuracoes/primeiro-uso")).toBe("primeiro-uso");
    expect(searchSettings("teto de turnos").map((option) => option.section)).toContain("cyno-ajustes");
    expect(searchSettings("stdio").map((option) => option.section)).toContain("conectores-locais");
    expect(searchSettings("primeiro uso").map((option) => option.section)).toContain("primeiro-uso");
  });
});

describe("avulsas terminadas: apagar sozinho", () => {
  it("opções com Nunca primeiro; um valor de fora da lista é mantido", () => {
    expect(avulsasDaysOptions(0)).toEqual([0, 7, 14, 30, 90, 180]);
    expect(avulsasDaysOptions(30)).toEqual([0, 7, 14, 30, 90, 180]);
    expect(avulsasDaysOptions(45)).toEqual([0, 7, 14, 30, 45, 90, 180]);
  });

  it("rótulos e selo", () => {
    expect(avulsasDaysLabel(0)).toBe("Nunca");
    expect(avulsasDaysLabel(1)).toBe("1 dia");
    expect(avulsasDaysLabel(14)).toBe("14 dias");
    expect(avulsasDaysBadge(0)).toBe("Nunca apaga");
    expect(avulsasDaysBadge(90)).toBe("Apaga depois de 90 dias");
  });
});
