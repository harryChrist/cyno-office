// Protocolo da cena ao vivo (WebSocket `GET /ws/scene?workspace=<id>`, só servidor -> cliente).
//
// O servidor roda a simulação do Escritório (o `Sim` do motor de cena) e as telas só desenham. A conexão aberta É o
// "estou olhando": a simulação liga na primeira conexão e desliga `SCENE_LIVE_IDLE_MS` depois da última sair.
// Nada de posição vai para o disco; o estado vive só na memória enquanto alguém assiste.
//
// Mensagens JSON, todas com `v: 1` e `t` (o tipo). Tempo: `at` é o relógio do servidor (ms, epoch). Todo valor de
// tempo de um personagem ou sala é uma IDADE ou um RESTANTE em ms em relação ao `at` da mensagem (não um epoch), para
// a tela não depender de o relógio dela bater com o do servidor: ela soma ao relógio local no instante em que recebe.
//
// Nada aqui importa o motor (nem DOM): pose, objeto na mão e ícone vão como texto (os nomes do motor: `Pose`,
// `HeldItem`, `IconName`); a tela estreita para os tipos dela.

/** Rota do WebSocket da cena ao vivo (o workspace vai em `?workspace=`, como no `/ws`). */
export const SCENE_LIVE_PATH = "/ws/scene";

/** Versão do protocolo (campo `v` de toda mensagem). */
export const SCENE_LIVE_VERSION = 1;

/** Passo da simulação no servidor (Hz). */
export const SCENE_LIVE_TICK_HZ = 20;
/** Frequência com que o servidor manda `scene:delta` (Hz), só quando algo mudou. */
export const SCENE_LIVE_SEND_HZ = 10;
/** Padrão de quanto tempo a simulação segue ligada sem nenhuma tela olhando (5 min). */
export const SCENE_LIVE_IDLE_MS = 5 * 60_000;

/** Direção do personagem: d = down (de frente), u = up (de costas), l = left, r = right. */
export type SceneDir = "d" | "u" | "l" | "r";

/** Fase de uma sala (a construção e a desmontagem animam; a tela calcula o progresso pela idade `pa`). */
export type ScenePhase = "building" | "ready" | "dismantling";

/**
 * Modo do personagem (`Mode` do motor): work = trabalhando na mesa, wait = esperando o dono, idle = ocioso,
 * shell = esperando um comando longo (pipoca), deliver = levando algo ao pai (subagente), leave = indo embora.
 */
export type SceneMode = "work" | "wait" | "idle" | "shell" | "deliver" | "leave";

/**
 * Um personagem inteiro (`scene:full` e personagem novo no delta). No delta, o personagem vem com `id` e SÓ as chaves que
 * mudaram; `null` apaga um campo opcional. Todas as posições são em px de mundo (o ponto é o pé, como no motor).
 *
 * O que NÃO vai (a tela refaz): `info` (nome, cargo, atividade, status: vem do retrato que a tela já monta das lojas),
 * `appearance` (sai da semente e das peças do retrato), `animT` (relógio de animação local, zera quando a pose muda),
 * `offX`/`offY` (a faixa lateral ao andar: `lane` vem da semente do personagem e a suavização é local), `popcornAt`.
 */
export type SceneChar = {
  /** Id do personagem (o do agente; subagente: `<pai>::<id>`). */
  id: string;
  /** Posição do pé em px de mundo (1 casa decimal). */
  x: number;
  y: number;
  /** Direção. */
  d: SceneDir;
  /** Pose (`Pose` do motor: stand, walk, sit, type, sleep, drink, use, talk, wait, play...). */
  p: string;
  /** Objeto na mão (`HeldItem`: none, coffee, papers, popcorn...). */
  h: string;
  /** 1 = sentado (o corpo desce e as pernas somem). */
  s: 0 | 1;
  /** Opacidade 0..1 (2 casas); some e aparece nas portas dos elevadores. */
  a: number;
  /** Modo (decide a tela do monitor, o alerta, o balão de espera). */
  m: SceneMode;
  /** Sala em que ele está (id da sala do retrato; pode ser "?" = recepção). */
  r: string;
  /** 1 = está indo embora (a tela do monitor apaga, sem teia). */
  lv: 0 | 1;
  /** 1 = dentro de cabine/elevador fechado (não desenha). */
  in: 0 | 1;
  /** Fica escondido por mais este tanto de ms (fila no elevador); 0 = visível. */
  hu: number;
  /** Profundidade forçada (assento) ou null = usa `y`. */
  sy: number | null;
  /** Lugar onde está agora (id do spot: mesa, sofá, máquina) ou null. */
  as: string | null;
  /** Lugar de casa (a mesa dele) ou null. */
  hs: string | null;
  /** Ícone sobre a cabeça (`IconName`) ou null; some sozinho quando o servidor manda null. */
  i: string | null;
  /** Balão de atividade da simulação: [ícone, texto, idade ms, restante ms] ou null. */
  b: [string, string, number, number] | null;
  /** Fala curta das rodas (convite, papo, torcida): [texto, idade ms, restante ms] ou null. */
  sa: [string, number, number] | null;
  /** Emoji de conversa: [emoji, restante ms] ou null. */
  ce: [string, number] | null;
  /** Idade (ms) da última mudança de atividade (o balão de atividade usa para aparecer e esmaecer). */
  ca: number;
  /**
   * Espera de comando longo (modo shell): [idade da espera ms, quantos, rótulo, estágio, idade ms desde que entrou no modo]
   * ou null. O estágio (`ShellStage`: popcorn, cobweb, nap...) já vem decidido.
   */
  sh: [number, number, string, string | null, number] | null;
};

/** Um delta de personagem: `id` e só o que mudou (as mesmas chaves e tipos de `SceneChar`). */
export type SceneCharDelta = { id: string } & Partial<Omit<SceneChar, "id">>;

/** Uma sala do layout (as que ocupam vaga no prédio, inclusive a sala fantasma de uma mudança). */
export type SceneLayoutRoom = {
  /** Id da sala (a fantasma de uma mudança: `<id>#mudançaN`). */
  id: string;
  /** Vaga REAL no prédio, escolhida pelo simulador (não é o `slot` do retrato). Entra em `layoutProjectRoom`. */
  s: number;
  /** Semente com que o tema e a planta foram gerados (fixa desde a criação da sala). Entra em `layoutProjectRoom` e em `roomTheme`. */
  sd: number;
  /** "maestro" = a Sala do Maestro (planta própria); ausente = sala de time. Entra em `layoutProjectRoom`. */
  k?: "maestro";
  /** 1 = sala fantasma (endereço antigo de uma mudança): existe na planta, mas não no retrato. */
  g?: 1;
  /** Nome na placa (o do retrato, com "· N esperam" se houver). */
  n: string;
};

/**
 * O layout do prédio: tudo que a tela precisa para montar a MESMA cena. O prédio é função pura disto:
 * `assembleBuilding(cols, salas.map(r => layoutProjectRoom({ id: r.id, slot: r.s, seed: r.sd, kind: r.k }, roomTheme(r.sd))), lv)`
 * (as quatro funções saem de `@cyno/cena/sim`). Os ids dos lugares (spots) e dos móveis nascem do id e da vaga da sala,
 * então `as`/`hs`/`u` dos personagens e salas só fazem sentido nesse prédio.
 */
export type SceneLayout = {
  /** Largura do prédio em colunas (pode ser maior que a das salas: o prédio só encolhe quando ninguém está na faixa). */
  cols: number;
  /** As salas que ocupam o prédio, na ordem de criação do simulador. */
  rooms: SceneLayoutRoom[];
};

/** O estado visível de uma sala (muda pouco: só vai no delta quando muda). */
export type SceneRoomState = {
  id: string;
  /** Fase: a construção e a desmontagem são animações de `BUILD_MS`/`DISMANTLE_MS`. */
  ph: ScenePhase;
  /** Idade (ms) da fase atual: a tela calcula o progresso com ela. */
  pa: number;
  /** Luz acesa? (1 = sim). */
  l: 0 | 1;
  /** Idade (ms) da última troca da luz (o brilho acende e apaga em rampa). */
  la: number;
};

/** Toda mensagem do servidor leva a versão e o tipo. */
type Base = { v: typeof SCENE_LIVE_VERSION; t: string };

/** Primeira mensagem ao conectar. */
export type SceneHello = Base & {
  t: "scene:hello";
  /** Relógio do servidor (ms, epoch) no envio. */
  at: number;
  /** Passo da simulação e frequência dos deltas (Hz). */
  tickHz: number;
  sendHz: number;
  /** Folga (ms) de desligamento sem ninguém olhando (informativo). */
  idleMs: number;
};

/** O estado completo: logo depois do `hello` e de novo toda vez que o layout muda. A tela substitui tudo o que tinha. */
export type SceneFull = Base & {
  t: "scene:full";
  at: number;
  /** Versão do layout (`Sim.layoutVersion`): sobe quando o prédio muda. */
  lv: number;
  layout: SceneLayout;
  /** Todos os personagens (os que existem no simulador, com o estado completo). */
  chars: SceneChar[];
  /** O estado visível de cada sala do layout. */
  rooms: SceneRoomState[];
  /** Estado das portas dos elevadores (0 fechada .. 4 aberta), na ordem dos elevadores da recepção. */
  el: number[];
  /** Ids dos móveis em uso: cafeteiras passando café e cabines ocupadas. */
  u: string[];
};

/** O que mudou desde a mensagem anterior (só chega se algo mudou). Ausente = não mudou. */
export type SceneDelta = Base & {
  t: "scene:delta";
  at: number;
  /** Personagens que mudaram (só as chaves alteradas) ou que entraram (com todas as chaves). */
  c?: SceneCharDelta[];
  /** Ids dos personagens que saíram. */
  x?: string[];
  /** Salas cujo estado mudou (fase, luz). Mudança de layout NÃO vem aqui: vem um novo `scene:full`. */
  r?: SceneRoomState[];
  /** Portas dos elevadores (a lista inteira, quando alguma mudou de estado). */
  el?: number[];
  /** Móveis em uso (a lista inteira, quando mudou). */
  u?: string[];
};

export type SceneLiveMessage = SceneHello | SceneFull | SceneDelta;

/** Lê uma mensagem do servidor (texto JSON); `null` se não for do protocolo. */
export function parseSceneMessage(text: string): SceneLiveMessage | null {
  try {
    const value = JSON.parse(text) as { v?: unknown; t?: unknown } | null;
    if (!value || typeof value !== "object" || value.v !== SCENE_LIVE_VERSION) return null;
    return value.t === "scene:hello" || value.t === "scene:full" || value.t === "scene:delta" ? (value as SceneLiveMessage) : null;
  } catch {
    return null;
  }
}
