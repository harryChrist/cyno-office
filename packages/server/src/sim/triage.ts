import { MAESTRO_TEXTS, MOCK_PROMPT_MARKERS, type OfficeState, type Room, type Team } from "@cyno/shared";

/** Palavras que não dizem nada sobre o time (artigos, preposições, verbos genéricos). */
const STOPWORDS = new Set(
  [
    "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "da", "do", "das", "dos", "em", "na", "no", "nas", "nos",
    "para", "pra", "por", "pelo", "pela", "com", "sem", "sobre", "que", "e", "ou", "mas", "se", "ao", "aos", "isso",
    "isto", "esse", "essa", "este", "esta", "aquele", "aquela", "meu", "minha", "seu", "sua", "nosso", "nossa",
    "mais", "menos", "muito", "pouco", "bem", "como", "quando", "onde", "qual", "quais", "todo", "toda", "todos",
    "todas", "cada", "fazer", "faca", "faz", "quero", "preciso", "precisa", "favor", "pode", "poderia", "voce",
    "ser", "ter", "tem", "vai", "algo", "alguma", "algum", "novo", "nova", "the", "and", "for", "with",
  ].map(normalizeWord),
);

/** Peso de cada lugar onde a palavra pode aparecer (o nome do time diz mais que as instruções). */
export const TRIAGE_WEIGHTS = { teamName: 4, focus: 3, roomName: 2, agents: 1 } as const;

type Field = keyof typeof TRIAGE_WEIGHTS;

function normalizeWord(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Raiz da palavra para comparar: sem acento, sem o "s" do plural e cortada em 6 letras
 * ("pesquisar" e "pesquisas" -> "pesqui"; "vídeos" -> "video"; "APIs" -> "api").
 */
export function stem(word: string): string {
  const plain = normalizeWord(word);
  const singular = plain.length > 3 && plain.endsWith("s") ? plain.slice(0, -1) : plain;
  return singular.slice(0, 6);
}

/** Palavras do texto que contam (3+ letras, fora as genéricas), com a forma original de cada raiz. */
export function keywords(text: string): Map<string, string> {
  const clean = Object.values(MOCK_PROMPT_MARKERS).reduce((acc, marker) => acc.split(marker).join(" "), text);
  const out = new Map<string, string>();
  for (const word of clean.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOPWORDS.has(normalizeWord(word))) continue;
    const key = stem(word);
    if (!out.has(key)) out.set(key, word.toLowerCase());
  }
  return out;
}

export type TeamScore = {
  team: Team;
  room: Room;
  score: number;
  /** Palavras do pedido que bateram com o time, da mais forte para a mais fraca. */
  words: string[];
};

export type TriageResult =
  | { kind: "team"; team: Team; room: Room; reason: string; scores: TeamScore[] }
  | { kind: "none"; reason: string; scores: TeamScore[] };

type Structure = Pick<OfficeState, "rooms" | "teams" | "agents">;

function scoreTeam(team: Team, room: Room, agentsText: string, prompt: Map<string, string>): TeamScore {
  const fields: Record<Field, Set<string>> = {
    teamName: new Set(keywords(team.name).keys()),
    focus: new Set(keywords(team.focus).keys()),
    roomName: new Set(keywords(room.name).keys()),
    agents: new Set(keywords(agentsText).keys()),
  };
  const hits: { word: string; points: number }[] = [];
  for (const [key, word] of prompt) {
    let points = 0;
    for (const field of Object.keys(fields) as Field[]) if (fields[field].has(key)) points += TRIAGE_WEIGHTS[field];
    if (points > 0) hits.push({ word, points });
  }
  hits.sort((a, b) => b.points - a.points);
  return { team, room, score: hits.reduce((sum, hit) => sum + hit.points, 0), words: hits.map((hit) => hit.word) };
}

const quoted = (words: string[]) => words.slice(0, 3).map((word) => `'${word}'`).join(", ");
const target = (score: TeamScore) => `time ${score.team.name} do quarto ${score.room.name}`;

/**
 * Triagem do Maestro (função pura e determinística). Candidatos: os times com agentes dos
 * quartos de time (`kind: "team"`), na ordem da lista de times. Cada palavra do pedido que
 * aparece no nome do time, no foco, no nome do quarto ou no papel/instruções dos agentes soma
 * pontos (veja TRIAGE_WEIGHTS). Ganha a maior pontuação; empate ou nenhuma pista = o primeiro
 * (entre os empatados). Sem time nenhum: `kind: "none"` com a pergunta para o usuário.
 */
export function triage(office: Structure, prompt: string): TriageResult {
  const rooms = new Map(office.rooms.filter((room) => room.kind === "team").map((room) => [room.id, room]));
  const teams = office.teams.filter((team) => rooms.has(team.roomId));
  const words = keywords(prompt);
  const scores: TeamScore[] = [];
  for (const team of teams) {
    const agents = office.agents.filter((agent) => agent.teamId === team.id);
    if (agents.length === 0) continue;
    const agentsText = agents.map((agent) => `${agent.role} ${agent.instructions}`).join(" ");
    scores.push(scoreTeam(team, rooms.get(team.roomId)!, agentsText, words));
  }
  if (scores.length === 0) {
    return { kind: "none", reason: teams.length === 0 ? MAESTRO_TEXTS.noTeam : MAESTRO_TEXTS.noAgents, scores };
  }

  const top = Math.max(...scores.map((score) => score.score));
  const tied = scores.filter((score) => score.score === top);
  const best = tied[0]!;
  let reason: string;
  if (top === 0) reason = `nenhuma pista no pedido → primeiro ${target(best)}`;
  else if (tied.length > 1) {
    const names = tied.map((score) => score.team.name).join(" e ");
    reason = `pedido fala de ${quoted(best.words)}, empate entre ${names} → primeiro ${target(best)}`;
  } else reason = `pedido fala de ${quoted(best.words)} → ${target(best)}`;
  return { kind: "team", team: best.team, room: best.room, reason, scores };
}
