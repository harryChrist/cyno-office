import { createHash } from "node:crypto";
import {
  dayKeyOf,
  DAY_MS,
  expandAvulsas,
  forYouKind,
  RETRO_IMPACT_DAYS,
  RETRO_LOOKBACK_DAYS,
  RETRO_MIN_DAYS,
  RETRO_MIN_ITEMS,
  RETRO_MIN_TOTAL,
  type ForYouItem,
  type Project,
  type RetroGroup,
  type RetroGroupKind,
  type RetroNotice,
  type RetroTrait,
  type Task,
} from "@cyno/shared";
import { median } from "./stats";

/**
 * Retrospectiva por código (plano da Gestão, seção 3c): acha padrões nas recusas, nas edições e nas falhas dos últimos 14 dias, sem
 * IA e sem relógio escondido (o `now` vem de fora). Um padrão vira CANDIDATO com pelo menos 3 itens em 2 dias diferentes (ou 5 no
 * total). Os traços conhecidos (emoji, hashtag, "!", tamanho, palavra repetida) já saem com o texto da regra por molde; o resto
 * (motivo de recusa em texto livre, palavras trocadas, falhas do agente) só vira texto com o Maestro, quando o dono pede.
 */

/** O que a retrospectiva lê (o runtime tira dos serviços; os testes usam o fixture em memória). */
export type RetroSnapshot = {
  agents: readonly { id: string; name: string }[];
  tasks: readonly Task[];
  projects: readonly Project[];
  forYou: readonly ForYouItem[];
  /** Nome do tipo de aprovação ("comentario" -> "Comentário"); sem ele, o próprio id. */
  typeName?: (type: string) => string;
};

export type RetroFound = {
  from: number;
  to: number;
  groups: RetroGroup[];
  notices: RetroNotice[];
  considered: { decided: number; edited: number; rejected: number; failed: number };
};

// ---------- Texto: normalização, palavras, plural ----------

/** Palavras vazias (artigos, preposições, pronomes e verbos de ligação) que não dizem nada sobre o motivo. */
const STOP_WORDS = new Set(
  (
    "a o as os um uma uns umas de da do das dos em na no nas nos por para pra pelo pela pelos pelas com sem sob sobre e ou mas que se ao aos " +
    "ser foi era sao esta estao estava tem ter tinha ficou ficar fica muito muita mais menos bem mal ainda ja so tambem nao sim como quando " +
    "isso isto esse essa este aquele aquela seu sua seus suas meu minha nosso nossa ele ela eles elas eu voce voces nos entre ate cada todo toda " +
    "tudo nada algo demais the and for with"
  ).split(" "),
);

/** Minúsculas, sem acento. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Radical simples: tira plural e algumas terminações ("formais" e "formal" ficam iguais). Sem lematizador: só o suficiente para unir motivos parecidos. */
export function stem(word: string): string {
  let out = word;
  if (out.length > 4) out = out.replace(/(oes|aes|ais|eis)$/, (end) => ({ oes: "ao", aes: "ao", ais: "al", eis: "el" })[end]!);
  if (out.length > 4) out = out.replace(/mente$/, "");
  if (out.length > 3) out = out.replace(/ns$/, "m").replace(/s$/, "");
  return out;
}

/** Palavras do texto com o radical (para comparar) e a forma que o dono escreveu (para mostrar): sem palavras vazias. */
export function wordTokens(text: string): { stem: string; surface: string }[] {
  const out: { stem: string; surface: string }[] = [];
  for (const surface of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const plain = fold(surface);
    if (plain.length >= 2 && !STOP_WORDS.has(plain)) out.push({ stem: stem(plain), surface });
  }
  return out;
}

/** Palavras do motivo, normalizadas: minúsculas, sem acento, sem palavras vazias, com radical simples. */
export function reasonWords(text: string): string[] {
  return wordTokens(text).map((token) => token.stem);
}

/** Jaccard de dois conjuntos de palavras (0 a 1); dois vazios não se parecem. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / (a.size + b.size - common);
}

/** Os `limit` radicais mais frequentes (desempate pela ordem alfabética: a conta é estável). */
export function topWords(lists: readonly (readonly string[])[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const word of new Set(list)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([word]) => word);
}

/** "Comentário" -> "comentários", "Mensagem" -> "mensagens", "Post" -> "posts" (o nome do tipo, no plural, para as frases). */
export function pluralPt(name: string): string {
  const word = name.trim().toLowerCase();
  if (word.endsWith("ão")) return `${word.slice(0, -2)}ões`;
  if (word.endsWith("m")) return `${word.slice(0, -1)}ns`;
  if (word.endsWith("l")) return `${word.slice(0, -1)}is`;
  if (word.endsWith("s") || word.endsWith("-")) return word;
  return `${word}s`;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const HASHTAG = /(?:^|\s)#[\p{L}\p{N}_]+/gu;
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const cut = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Palavra (4+ letras, fora as vazias) que aparece 3 vezes ou mais no texto: a mais repetida e quantas vezes. */
function repeated(text: string): { word: string; times: number } | undefined {
  const counts = new Map<string, number>();
  for (const word of fold(text).match(/[\p{L}\p{N}]{4,}/gu) ?? []) if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  let best: { word: string; times: number } | undefined;
  for (const [word, times] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) if (times >= 3 && (!best || times > best.times)) best = { word, times };
  return best;
}

/** O id estável do padrão: o mesmo padrão (tipo, chave, agentes) tem sempre o mesmo id (é o que a recusa guarda por 8 semanas). */
export function groupHash(input: { kind: RetroGroupKind; type: string; key: string; agentIds: readonly string[] }): string {
  const text = [input.kind, input.type, input.key, [...input.agentIds].sort().join(",")].join("|");
  return `g-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

// ---------- Janela e limites ----------

const ms = (text: string | undefined): number => (text ? Date.parse(text) : Number.NaN);
const decidedAt = (item: ForYouItem): number => ms(item.decidedAt);

/** O padrão passa do limite: 3 itens em 2 dias diferentes, ou 5 no total. */
export function passesThreshold(items: number, days: number): boolean {
  return (items >= RETRO_MIN_ITEMS && days >= RETRO_MIN_DAYS) || items >= RETRO_MIN_TOTAL;
}

/** Item de aprovação que o dono decidiu (aprovou ou recusou, não o Modo Automático) dentro da janela. */
function ownerDecided(item: ForYouItem, from: number, to: number): boolean {
  if (forYouKind(item) !== "aprovacao" || item.decidedBy === "automatico") return false;
  if (item.status !== "aprovado" && item.status !== "rejeitado") return false;
  const at = decidedAt(item);
  return at >= from && at <= to;
}

type Draft = {
  kind: RetroGroupKind;
  agentId: string;
  roomId: string;
  type: string;
  key: string;
  mergeKey: string;
  trait?: RetroTrait;
  words: string[];
  itemIds: string[];
  dayKeys: Set<string>;
  total: number;
  excerpts: { itemId: string; before: string; after?: string }[];
  samples: string[];
  /** Mediana da razão de tamanho (só em `shorter`/`longer`). */
  ratio?: number;
};

const dayOf = (at: number): string => dayKeyOf(at);

// ---------- Traços das edições ----------

type TraitSpec = {
  trait: RetroTrait;
  /** O item entra na conta (o rascunho tinha o traço, ou foi editado)? */
  considered: (item: ForYouItem) => boolean;
  /** O dono mexeu no traço? */
  hit: (item: ForYouItem) => boolean;
};

const edited = (item: ForYouItem): boolean => item.status === "aprovado" && item.editedByUser && item.text !== item.originalText;
const ratioOf = (item: ForYouItem): number => (item.originalText.length > 0 ? item.text.length / item.originalText.length : 1);

const TRAIT_SPECS: readonly TraitSpec[] = [
  { trait: "emoji", considered: (item) => item.status === "aprovado" && count(item.originalText, EMOJI) > 0, hit: (item) => edited(item) && count(item.text, EMOJI) < count(item.originalText, EMOJI) },
  { trait: "hashtag", considered: (item) => item.status === "aprovado" && count(item.originalText, HASHTAG) > 0, hit: (item) => edited(item) && count(item.text, HASHTAG) < count(item.originalText, HASHTAG) },
  { trait: "exclamation", considered: (item) => item.status === "aprovado" && item.originalText.includes("!"), hit: (item) => edited(item) && count(item.text, /!/g) < count(item.originalText, /!/g) },
  { trait: "shorter", considered: edited, hit: (item) => edited(item) && ratioOf(item) <= 0.75 },
  { trait: "longer", considered: edited, hit: (item) => edited(item) && ratioOf(item) >= 1.35 },
  {
    trait: "repeat",
    considered: (item) => item.status === "aprovado" && repeated(item.originalText) !== undefined,
    hit: (item) => {
      const before = repeated(item.originalText);
      return edited(item) && before !== undefined && (repeated(item.text)?.times ?? 0) < before.times;
    },
  },
];

/** Verbo do traço para a frase de evidência: "cortou emojis em 6 de 7 comentários". */
function traitLine(trait: RetroTrait, hits: number, total: number, plural: string, ratio: number | undefined): string {
  const of = `${hits} de ${total} ${plural}`;
  switch (trait) {
    case "emoji":
      return `cortou emojis em ${of}`;
    case "hashtag":
      return `tirou hashtags em ${of}`;
    case "exclamation":
      return `tirou pontos de exclamação em ${of}`;
    case "shorter":
      return `encurtou ${of}${ratio !== undefined ? ` (mediana: ${Math.round((1 - ratio) * 100)}% menor)` : ""}`;
    case "longer":
      return `alongou ${of}${ratio !== undefined ? ` (mediana: ${Math.round((ratio - 1) * 100)}% maior)` : ""}`;
    case "repeat":
      return `reduziu palavras repetidas em ${of}`;
  }
}

/** O texto da regra por molde (nenhuma IA): o que o dono quer, no plural do tipo. */
export function traitTemplate(trait: RetroTrait, plural: string, ratio: number | undefined): string {
  switch (trait) {
    case "emoji":
      return `Não usar emojis em ${plural}.`;
    case "hashtag":
      return `Não usar hashtags em ${plural}.`;
    case "exclamation":
      return `Evitar pontos de exclamação em ${plural}.`;
    case "shorter":
      return `Encurtar o texto de ${plural}${ratio !== undefined ? ` (o dono costuma cortar cerca de ${Math.round((1 - ratio) * 100)}%)` : ""}.`;
    case "longer":
      return `Alongar o texto de ${plural}${ratio !== undefined ? ` (o dono costuma acrescentar cerca de ${Math.round((ratio - 1) * 100)}%)` : ""}.`;
    case "repeat":
      return `Não repetir a mesma palavra várias vezes em ${plural}.`;
  }
}

// ---------- A conta ----------

const FAILURE_QUOTA = new Set(["cota", "acesso"]);

/** O "começo" do erro que agrupa as falhas: as 3 primeiras palavras que dizem algo. */
const FAILURE_START_WORDS = 3;

/** Procura os padrões. `now` fixo = resultado fixo (nenhuma conta lê o relógio nem o fuso da máquina). */
export function findRetro(snapshot: RetroSnapshot, now: number): RetroFound {
  const from = now - RETRO_LOOKBACK_DAYS * DAY_MS;
  const typeName = snapshot.typeName ?? ((type: string) => type);
  const agentName = (id: string): string => snapshot.agents.find((agent) => agent.id === id)?.name ?? id;
  const items = snapshot.forYou.filter((item) => ownerDecided(item, from, now));
  const drafts: Draft[] = [];
  // O radical serve para comparar; na tela entra a forma que o dono escreveu ("queremos", não "queremo").
  const surfaces = new Map<string, string>();
  const remember = (text: string | undefined): void => {
    for (const token of wordTokens(text ?? "")) if (!surfaces.has(token.stem)) surfaces.set(token.stem, token.surface);
  };
  const shown = (words: readonly string[]): string[] => words.map((word) => surfaces.get(word) ?? word);
  for (const item of items) {
    remember(item.rejection?.reason);
    if (edited(item)) {
      remember(item.originalText);
      remember(item.text);
    }
  }

  const byAgentType = new Map<string, ForYouItem[]>();
  for (const item of items) {
    const key = `${item.agentId}\u0000${item.type}`;
    byAgentType.set(key, [...(byAgentType.get(key) ?? []), item]);
  }
  const ordered = [...byAgentType].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [, list] of ordered) {
    const sample = list[0]!;
    const base = { agentId: sample.agentId, roomId: sample.roomId, type: sample.type };
    list.sort((a, b) => decidedAt(a) - decidedAt(b) || a.id.localeCompare(b.id));

    // (a) Recusas: por categoria (quando há) ou pelas palavras do motivo, unindo motivos com Jaccard >= 0,4.
    const refused = list.filter((item) => item.status === "rejeitado" && ((item.rejection?.reason ?? "").trim() !== "" || (item.rejection?.category ?? "") !== ""));
    const byCategory = new Map<string, ForYouItem[]>();
    const free: ForYouItem[] = [];
    for (const item of refused) {
      const category = item.rejection?.category;
      if (category && category !== "outro") byCategory.set(category, [...(byCategory.get(category) ?? []), item]);
      else free.push(item);
    }
    const clusters: { items: ForYouItem[]; words: Set<string>[] }[] = [];
    for (const item of free) {
      const words = new Set(reasonWords(item.rejection?.reason ?? ""));
      const home = clusters.find((cluster) => cluster.words.some((other) => jaccard(words, other) >= 0.4));
      if (home) {
        home.items.push(item);
        home.words.push(words);
      } else clusters.push({ items: [item], words: [words] });
    }
    const rejectionGroups: { key: string; items: ForYouItem[] }[] = [...byCategory].map(([category, group]) => ({ key: `c:${category}`, items: group }));
    for (const cluster of clusters) {
      const words = topWords(cluster.words.map((set) => [...set]));
      rejectionGroups.push({ key: `w:${[...words].sort().join("+")}`, items: cluster.items });
    }
    for (const group of rejectionGroups) {
      const days = new Set(group.items.map((item) => dayOf(decidedAt(item))));
      if (!passesThreshold(group.items.length, days.size)) continue;
      const wordLists = group.items.map((item) => reasonWords(item.rejection?.reason ?? ""));
      drafts.push({
        ...base,
        kind: "rejection",
        key: group.key,
        mergeKey: group.key,
        words: topWords(wordLists),
        itemIds: group.items.map((item) => item.id),
        dayKeys: days,
        total: list.length,
        excerpts: group.items.slice(0, 5).map((item) => ({ itemId: item.id, before: cut(item.text), after: cut(`Motivo: ${item.rejection?.reason || item.rejection?.category || "—"}`) })),
        samples: [...new Set(group.items.map((item) => cut(item.rejection?.reason ?? item.rejection?.category ?? "", 160)).filter(Boolean))].slice(0, 6),
      });
    }

    // (b) Edições, parte 1: os traços conhecidos (molde por código).
    for (const spec of TRAIT_SPECS) {
      const considered = list.filter(spec.considered);
      const hits = considered.filter(spec.hit);
      const days = new Set(hits.map((item) => dayOf(decidedAt(item))));
      if (!passesThreshold(hits.length, days.size)) continue;
      const ratios = hits.map(ratioOf);
      const ratio = spec.trait === "shorter" || spec.trait === "longer" ? (median(ratios) ?? undefined) : undefined;
      drafts.push({
        ...base,
        kind: "edit_trait",
        key: spec.trait,
        mergeKey: spec.trait,
        trait: spec.trait,
        words: [],
        itemIds: hits.map((item) => item.id),
        dayKeys: days,
        total: considered.length,
        excerpts: hits.slice(0, 5).map((item) => ({ itemId: item.id, before: cut(item.originalText), after: cut(item.text) })),
        samples: [],
        ...(ratio !== undefined ? { ratio } : {}),
      });
    }

    // (b) Edições, parte 2: palavras tiradas ou acrescentadas em muitos itens (sem traço conhecido: o Maestro escreve a regra).
    const editedItems = list.filter(edited);
    if (editedItems.length >= RETRO_MIN_ITEMS) {
      for (const direction of ["removed", "added"] as const) {
        const perItem = editedItems.map((item) => {
          const before = new Set(reasonWords(item.originalText));
          const after = new Set(reasonWords(item.text));
          const changed = direction === "removed" ? [...before].filter((word) => !after.has(word)) : [...after].filter((word) => !before.has(word));
          return { item, changed };
        });
        const tally = new Map<string, number>();
        for (const entry of perItem) for (const word of entry.changed) tally.set(word, (tally.get(word) ?? 0) + 1);
        const common = [...tally].filter(([, times]) => times >= RETRO_MIN_ITEMS && times / editedItems.length >= 0.4).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([word]) => word);
        if (common.length === 0) continue;
        const hits = perItem.filter((entry) => entry.changed.some((word) => common.includes(word)));
        const days = new Set(hits.map((entry) => dayOf(decidedAt(entry.item))));
        if (!passesThreshold(hits.length, days.size)) continue;
        drafts.push({
          ...base,
          kind: "edit_words",
          key: `${direction}:${[...common].sort().join("+")}`,
          mergeKey: `${direction}:${[...common].sort().join("+")}`,
          words: common,
          itemIds: hits.map((entry) => entry.item.id),
          dayKeys: days,
          total: editedItems.length,
          excerpts: hits.slice(0, 5).map((entry) => ({ itemId: entry.item.id, before: cut(entry.item.originalText), after: cut(entry.item.text) })),
          samples: [`${direction === "removed" ? "removidas" : "acrescentadas"}: ${shown(common).join(", ")}`],
        });
      }
    }
  }

  // (c) Falhas: por origem (`failureKind`) e pelo começo do texto do erro (`ProjectTask.failure`).
  const leaves = new Map<string, string>();
  for (const project of expandAvulsas([...snapshot.projects])) for (const task of project.tasks) if (task.failure) leaves.set(`${project.id}/${task.ref}`, task.failure);
  const failed = snapshot.tasks.filter((task) => task.status === "failed" && task.outcome !== "cancelled" && task.failureKind !== "cancelada" && task.role !== "request" && task.agentId !== undefined && ms(task.updatedAt) >= from && ms(task.updatedAt) <= now);
  const noticeCounts = new Map<string, { kind: "cota" | "acesso"; agentId: string; count: number }>();
  const failureGroups = new Map<string, Task[]>();
  for (const task of failed) {
    const kind = task.failureKind;
    if (kind && FAILURE_QUOTA.has(kind)) {
      const key = `${kind}\u0000${task.agentId}`;
      const entry = noticeCounts.get(key) ?? { kind: kind as "cota" | "acesso", agentId: task.agentId!, count: 0 };
      entry.count += 1;
      noticeCounts.set(key, entry);
      continue;
    }
    const text = (task.work ? leaves.get(`${task.work.projectId}/${task.work.ref}`) : undefined) ?? "";
    // Sem o texto do erro não há o que o Maestro escrever como regra: fica de fora (continua na taxa de falha).
    if (text.trim() === "") continue;
    remember(text);
    const start = reasonWords(text).slice(0, FAILURE_START_WORDS).join(" ");
    const key = `${task.agentId}\u0000${start}`;
    failureGroups.set(key, [...(failureGroups.get(key) ?? []), task]);
  }
  for (const [key, tasks] of [...failureGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const days = new Set(tasks.map((task) => dayOf(ms(task.updatedAt))));
    if (!passesThreshold(tasks.length, days.size)) continue;
    const [agentId, start] = key.split("\u0000") as [string, string];
    const text = (tasks[0]!.work ? leaves.get(`${tasks[0]!.work.projectId}/${tasks[0]!.work.ref}`) : undefined) ?? "";
    drafts.push({
      kind: "failure",
      agentId,
      roomId: tasks[0]!.roomId,
      type: "tarefa",
      key: `f:${start}`,
      mergeKey: `f:${start}`,
      words: reasonWords(text).slice(0, 3),
      itemIds: tasks.map((task) => task.id),
      dayKeys: days,
      total: failed.filter((task) => task.agentId === agentId).length,
      excerpts: tasks.slice(0, 5).map((task) => ({ itemId: task.id, before: cut(task.prompt.split("\n")[0] ?? ""), after: cut(text) })),
      samples: [cut(text, 160)],
    });
  }
  const notices: RetroNotice[] = [...noticeCounts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId))
    .map((entry) => ({ kind: entry.kind, agentId: entry.agentId, agentName: agentName(entry.agentId), count: entry.count, text: `${entry.kind === "cota" ? "Faltou cota" : "Faltou acesso"} em ${entry.count} tarefas de ${agentName(entry.agentId)} nos últimos ${RETRO_LOOKBACK_DAYS} dias: isso é aviso, não vira regra.` }));

  // Junta o mesmo padrão de 2 ou mais agentes numa regra só (global).
  const merged = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const key = `${draft.kind}|${draft.type}|${draft.mergeKey}`;
    merged.set(key, [...(merged.get(key) ?? []), draft]);
  }
  const groups: RetroGroup[] = [];
  for (const [, parts] of merged) {
    const first = parts[0]!;
    const agentIds = [...new Set(parts.map((part) => part.agentId))].sort();
    const itemIds = parts.flatMap((part) => part.itemIds);
    const dayKeys = new Set(parts.flatMap((part) => [...part.dayKeys]));
    const total = parts.reduce((sum, part) => sum + part.total, 0);
    const name = typeName(first.type);
    const plural = pluralPt(name);
    const ratio = first.ratio !== undefined ? (median(parts.flatMap((part) => (part.ratio !== undefined ? [part.ratio] : []))) ?? first.ratio) : undefined;
    const words = shown(first.kind === "rejection" && parts.length > 1 ? topWords(parts.map((part) => part.words)) : first.words);
    const who = agentIds.length === 1 ? ` de ${agentName(agentIds[0]!)}` : ` (${agentIds.map(agentName).join(", ")})`;
    let line: string;
    if (first.kind === "edit_trait") line = `${first.trait ? traitLine(first.trait, itemIds.length, total, plural, ratio) : ""}${agentIds.length === 1 ? ` (${agentName(agentIds[0]!)})` : who}`;
    else if (first.kind === "rejection") line = `recusou ${itemIds.length} de ${total} ${plural}${who}${first.key.startsWith("c:") ? ` (${first.key.slice(2).replace(/_/g, " ")})` : words.length > 0 ? ` (“${words.join(" ")}”)` : ""}`;
    else if (first.kind === "edit_words") line = `${first.key.startsWith("removed") ? "tirou" : "acrescentou"} ${words.map((word) => `“${word}”`).join(", ")} em ${itemIds.length} de ${total} ${plural} editados${who}`;
    else line = `${itemIds.length} falhas${who}: “${words.join(" ")}”`;
    groups.push({
      id: groupHash({ kind: first.kind, type: first.type, key: first.key, agentIds }),
      kind: first.kind,
      agentIds,
      agentNames: agentIds.map(agentName),
      roomIds: [...new Set(parts.map((part) => part.roomId))],
      type: first.type,
      typeName: name,
      key: first.key,
      ...(first.trait ? { trait: first.trait } : {}),
      words,
      count: itemIds.length,
      total,
      days: dayKeys.size,
      itemIds,
      excerpts: parts.flatMap((part) => part.excerpts).slice(0, 5),
      line,
      ...(first.kind === "edit_trait" && first.trait ? { template: traitTemplate(first.trait, plural, ratio) } : {}),
      samples: [...new Set(parts.flatMap((part) => part.samples))].slice(0, 6),
    });
  }
  groups.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return {
    from,
    to: now,
    groups,
    notices,
    considered: { decided: items.length, edited: items.filter(edited).length, rejected: items.filter((item) => item.status === "rejeitado").length, failed: failed.length },
  };
}

// ---------- Antes e depois de uma regra aprovada ----------

/** O que identifica o padrão de uma regra (o que o antes/depois conta). */
export type RuleTarget = Pick<RetroGroup, "kind" | "type" | "key" | "trait" | "words" | "agentIds">;

/**
 * Quantas vezes o padrão aconteceu na janela [from, to): recusas do tipo (e da mesma categoria, se o grupo era uma), edições com o
 * traço, edições com as palavras, ou falhas do agente com o mesmo começo de erro. É a MESMA fórmula antes e depois da aprovação.
 */
export function patternCount(snapshot: RetroSnapshot, target: RuleTarget, from: number, to: number): number {
  const agents = new Set(target.agentIds);
  if (target.kind === "failure") {
    const leaves = new Map<string, string>();
    for (const project of expandAvulsas([...snapshot.projects])) for (const task of project.tasks) if (task.failure) leaves.set(`${project.id}/${task.ref}`, task.failure);
    return snapshot.tasks.filter((task) => {
      const at = ms(task.updatedAt);
      if (task.status !== "failed" || task.outcome === "cancelled" || task.failureKind === "cancelada" || !task.agentId || !agents.has(task.agentId) || !(at >= from && at < to)) return false;
      const text = (task.work ? leaves.get(`${task.work.projectId}/${task.work.ref}`) : undefined) ?? "";
      return text.trim() !== "" && `f:${reasonWords(text).slice(0, FAILURE_START_WORDS).join(" ")}` === target.key;
    }).length;
  }
  const items = snapshot.forYou.filter((item) => agents.has(item.agentId) && item.type === target.type && ownerDecided(item, from, to - 1));
  if (target.kind === "rejection") {
    const category = target.key.startsWith("c:") ? target.key.slice(2) : undefined;
    return items.filter((item) => item.status === "rejeitado" && (category === undefined || item.rejection?.category === category)).length;
  }
  if (target.kind === "edit_trait") {
    const spec = TRAIT_SPECS.find((candidate) => candidate.trait === target.trait);
    return spec ? items.filter(spec.hit).length : 0;
  }
  const direction = target.key.startsWith("removed") ? "removed" : "added";
  return items.filter((item) => {
    if (!edited(item)) return false;
    const before = new Set(reasonWords(item.originalText));
    const after = new Set(reasonWords(item.text));
    const wanted = target.words.map((word) => stem(fold(word)));
    return wanted.some((word) => (direction === "removed" ? before.has(word) && !after.has(word) : after.has(word) && !before.has(word)));
  }).length;
}

/** O que a regra contava ("recusas desse tipo"), para a frase do relatório. */
export function impactLabel(target: Pick<RuleTarget, "kind" | "trait">): string {
  if (target.kind === "rejection") return "recusas desse tipo";
  if (target.kind === "failure") return "falhas desse tipo";
  if (target.kind === "edit_words") return "edições com essas palavras";
  const labels: Record<RetroTrait, string> = { emoji: "emojis cortados por você", hashtag: "hashtags cortadas por você", exclamation: "exclamações cortadas por você", shorter: "textos encurtados por você", longer: "textos alongados por você", repeat: "repetições cortadas por você" };
  return labels[target.trait ?? "emoji"];
}

/**
 * Duas semanas depois de aprovada, a regra ganha a medida: o mesmo número nos 14 dias antes e nos 14 dias depois da aprovação.
 * Antes das duas semanas, `undefined` (nada a dizer ainda).
 */
export function ruleImpact(snapshot: RetroSnapshot, target: RuleTarget, approvedAt: number, now: number): { before: number; after: number } | undefined {
  const span = RETRO_IMPACT_DAYS * DAY_MS;
  if (now < approvedAt + span) return undefined;
  return { before: patternCount(snapshot, target, approvedAt - span, approvedAt), after: patternCount(snapshot, target, approvedAt, approvedAt + span) };
}

/** "regra X: recusas desse tipo caíram de 5 para 1" (ou subiram, ou ficaram em N). */
export function impactLine(text: string, what: string, before: number, after: number): string {
  const short = cut(text, 70);
  if (after < before) return `Regra “${short}”: ${what} caíram de ${before} para ${after}.`;
  if (after > before) return `Regra “${short}”: ${what} subiram de ${before} para ${after}.`;
  return `Regra “${short}”: ${what} ficaram em ${after}.`;
}
