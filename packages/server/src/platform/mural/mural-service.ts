import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MEDIA_USER_CREATOR, MURAL_LIMITS, muralEntrySchema, type MuralEntry } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";
import { shorten } from "../../util/text";
import type { MediaService } from "../../workspace/media/media-service";
import { activity } from "../../workspace/activity/log";
import { HttpError } from "../http/errors";

/** Quanto tempo uma entrada ativa ainda aparece como novidade para quem nunca a viu. */
const NEWS_WINDOW_MS = 60 * 24 * 3_600_000;
/** Teto do aviso que entra na próxima mensagem do Maestro. */
const NEWS_LINES = 5;
const NEWS_CHARS = 600;
const DAY_MS = 24 * 3_600_000;

/** O que o mural precisa saber dos workspaces (ligado depois que o gerenciador abre). */
export type MuralHost = {
  workspaceName(id: string): string | undefined;
  media(id: string): Pick<MediaService, "find" | "fileOf" | "copyFrom" | "setShared"> | undefined;
};

export type MuralShareInput = {
  /** O workspace que publica (um workspace só publica como ele mesmo; só o Cyno e o dono escolhem). */
  workspace: string;
  /** Quem publica: endereço do agente, "cyno" ou "dono". */
  by: string;
  mediaId?: string;
  projectId?: string;
  text?: string;
  title?: string;
  note?: string;
};

/** O que o `mural_use` fez: a mídia copiada ou o texto do item. */
export type MuralUse = { entry: MuralEntry; mediaId?: string; text?: string };

/**
 * O mural da plataforma: o que um workspace compartilha (mídia, entrega, nota) para os outros
 * aproveitarem. Tudo por código, sem IA. Nenhum workspace lê arquivo de outro: `use` copia o arquivo
 * para a biblioteca de quem pede, com a origem registrada. O Maestro de cada workspace fica sabendo das
 * novidades na próxima mensagem que ele de fato recebe (`takeNews`, por um cursor), nunca por uma chamada
 * só para avisar.
 */
export class MuralService {
  private host: MuralHost | undefined;
  private readonly listeners = new Set<() => void>();
  /** Linhas para o contexto do Cyno (o que foi compartilhado desde a última mensagem dele). */
  private notices: string[] = [];

  private constructor(
    private entries: MuralEntry[],
    private cursors: Record<string, string>,
    private readonly files: { entries: string; seen: string },
    private readonly queue: WriteQueue,
    private readonly now: () => Date,
    private readonly onError: (error: unknown) => void,
  ) {}

  static async openAt(dataDir: string, now: () => Date, onError: (error: unknown) => void = () => undefined): Promise<MuralService> {
    const dir = path.join(dataDir, "platform", "mural");
    const files = { entries: path.join(dir, "mural.json"), seen: path.join(dir, "seen.json") };
    let entries: MuralEntry[] = [];
    let cursors: Record<string, string> = {};
    try {
      const raw = JSON.parse(await readFile(files.entries, "utf8")) as { items?: unknown };
      if (Array.isArray(raw.items)) entries = raw.items.flatMap((item) => {
        const parsed = muralEntrySchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    } catch {
      // Sem arquivo (ou quebrado): mural vazio.
    }
    try {
      const raw = JSON.parse(await readFile(files.seen, "utf8")) as Record<string, unknown>;
      cursors = Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
    } catch {
      // Sem cursores: ninguém viu nada ainda.
    }
    return new MuralService(entries, cursors, files, new WriteQueue(), now, onError);
  }

  /** Liga os workspaces (depois que o gerenciador abre). */
  bind(host: MuralHost): void {
    this.host = host;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  // ---------- Leitura ----------

  private nameOf(workspace: string): string {
    return this.host?.workspaceName(workspace) ?? workspace;
  }

  /** Mídia que o dono apagou no workspace de origem: a entrada sai do mural (confere na hora de ler). */
  private prune(): void {
    if (!this.host) return;
    let changed = false;
    for (const entry of this.entries) {
      if (entry.status !== "ativo" || !entry.mediaRef) continue;
      const library = this.host.media(entry.mediaRef.workspace);
      // Workspace que sumiu ou mídia apagada.
      if (library && library.find(entry.mediaRef.mediaId)) continue;
      entry.status = "retirado";
      changed = true;
    }
    if (changed) this.save();
  }

  /** As entradas ativas, as mais novas primeiro; `query` procura no título, na nota e no texto. */
  list(filter: { query?: string; since?: string; status?: "ativo" | "retirado"; limit?: number } = {}): MuralEntry[] {
    this.prune();
    const q = filter.query?.trim().toLowerCase();
    const status = filter.status ?? "ativo";
    const since = filter.since ? Date.parse(filter.since) : undefined;
    const found = this.entries
      .filter((entry) => entry.status === status)
      .filter((entry) => since === undefined || Number.isNaN(since) || Date.parse(entry.createdAt) >= since)
      .filter((entry) => !q || [entry.id, entry.title, entry.note, entry.text, entry.workspace, ...entry.tags].some((field) => field?.toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return structuredClone(filter.limit ? found.slice(0, filter.limit) : found);
  }

  find(id: string): MuralEntry | undefined {
    const found = this.entries.find((entry) => entry.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** O que o workspace ainda não viu: ativas, de OUTROS workspaces, mais novas que o cursor dele. */
  pendingFor(workspace: string): MuralEntry[] {
    this.prune();
    const cursor = this.cursors[workspace] ?? "";
    const floor = new Date(this.now().getTime() - NEWS_WINDOW_MS).toISOString();
    return this.entries
      .filter((entry) => entry.status === "ativo" && entry.workspace !== workspace && entry.createdAt > cursor && entry.createdAt >= floor)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((entry) => structuredClone(entry));
  }

  /** Quantas novidades cada workspace ainda não viu (o selo "N novos no mural" da ficha). */
  newsCounts(workspaces: readonly string[]): Record<string, number> {
    return Object.fromEntries(workspaces.map((workspace) => [workspace, this.pendingFor(workspace).length]));
  }

  /**
   * O texto que vai no fim da PRÓXIMA mensagem ao Maestro do workspace ("Novo no mural: ..."), ou "" se
   * não há novidade. Chamado só quando a mensagem de fato sai: avança o cursor, então o aviso entra uma
   * única vez. Curto: no máximo 5 linhas e 600 caracteres.
   */
  takeNews(workspace: string): string {
    const pending = this.pendingFor(workspace);
    if (pending.length === 0) return "";
    const newest = pending.at(-1)!;
    this.cursors[workspace] = newest.createdAt;
    const stamp = this.now().toISOString();
    for (const entry of pending) {
      const stored = this.entries.find((candidate) => candidate.id === entry.id);
      if (stored) stored.seenBy[workspace] = stamp;
    }
    this.save();
    this.emit();
    // As mais novas primeiro: se não couber tudo, as velhas viram "e mais N".
    const lines: string[] = [];
    let chars = 0;
    for (const entry of [...pending].reverse()) {
      const line = `${entry.id} “${shorten(entry.title, 70)}” (${this.nameOf(entry.workspace)})${entry.kind === "media" ? "" : entry.kind === "deliverable" ? ", entrega" : ", nota"}`;
      if (lines.length >= NEWS_LINES || chars + line.length > NEWS_CHARS) break;
      lines.push(line);
      chars += line.length;
    }
    const more = pending.length - lines.length;
    return `Novo no mural da plataforma: ${lines.join("; ")}${more > 0 ? `; e mais ${more} (veja mural_list)` : ""}. Use mural_use(item_id) para trazer um item para a biblioteca de mídia deste workspace.`;
  }

  /** As linhas do que foi compartilhado desde a última mensagem ao Cyno (esvazia a lista). */
  takeNotices(): string[] {
    return this.notices.splice(0);
  }

  // ---------- Compartilhar e retirar ----------

  private nextId(): string {
    const max = this.entries.reduce((top, entry) => Math.max(top, Number(entry.id.slice(2)) || 0), 0);
    return `N-${String(max + 1).padStart(4, "0")}`;
  }

  /**
   * Compartilha uma mídia (copia nada: o mural aponta para o arquivo de origem) ou um texto (entrega/nota).
   * Compartilhar de novo a mesma mídia só atualiza o título e a nota da entrada. Lança `HttpError` (400/404/429).
   */
  share(input: MuralShareInput): MuralEntry {
    const host = this.host;
    if (!host) throw new HttpError(503, "O mural ainda não está pronto");
    if (!host.workspaceName(input.workspace)) throw new HttpError(404, `Workspace "${input.workspace}" não encontrado`);
    const note = (input.note ?? "").trim().slice(0, MURAL_LIMITS.note);
    const nowIso = this.now().toISOString();
    const media = input.mediaId ? host.media(input.workspace) : undefined;
    const item = input.mediaId ? media?.find(input.mediaId) : undefined;
    if (input.mediaId && !item) throw new HttpError(404, `Mídia "${input.mediaId}" não existe neste workspace (veja media_list)`);
    if (!item && !input.text?.trim()) throw new HttpError(400, "Informe uma mídia ou um texto para compartilhar");
    const title = (input.title?.trim() || item?.title || shorten((input.text ?? "").trim().split("\n")[0] ?? "", MURAL_LIMITS.title)).slice(0, MURAL_LIMITS.title);
    if (!title) throw new HttpError(400, "Dê um título ao item");

    // A mesma mídia já compartilhada: atualiza em vez de duplicar.
    const existing = item ? this.entries.find((entry) => entry.status === "ativo" && entry.mediaRef?.workspace === input.workspace && entry.mediaRef.mediaId === item.id) : undefined;
    if (existing) {
      existing.title = title;
      existing.note = note;
      media?.setShared(item!.id, note);
      this.save();
      this.emit();
      return structuredClone(existing);
    }
    const since = Date.parse(nowIso) - DAY_MS;
    const today = this.entries.filter((entry) => entry.workspace === input.workspace && Date.parse(entry.createdAt) > since).length;
    if (today >= MURAL_LIMITS.perDayPerWorkspace) throw new HttpError(429, `Limite: ${MURAL_LIMITS.perDayPerWorkspace} itens por dia por workspace no mural`);

    const entry: MuralEntry = muralEntrySchema.parse({
      id: this.nextId(),
      kind: item ? "media" : input.projectId ? "deliverable" : "note",
      workspace: input.workspace,
      by: input.by,
      title,
      note,
      ...(item ? { mediaRef: { workspace: input.workspace, mediaId: item.id }, mediaKind: item.kind } : {}),
      ...(input.projectId ? { projectRef: { workspace: input.workspace, projectId: input.projectId } } : {}),
      ...(input.text?.trim() ? { text: input.text.trim().slice(0, MURAL_LIMITS.text) } : {}),
      createdAt: nowIso,
    });
    this.entries.push(entry);
    media?.setShared(item!.id, note);
    // Passa de 200 ativas: as mais velhas viram "retirado" (o arquivo continua no workspace de origem).
    const active = this.entries.filter((candidate) => candidate.status === "ativo").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const old of active.slice(0, Math.max(0, active.length - MURAL_LIMITS.active))) this.release(old);
    this.notices.push(`mural ${entry.id} "${shorten(entry.title, 80)}" shared by ${input.workspace}`);
    this.save();
    this.emit();
    activity({ workspaceId: input.workspace, category: "midia", action: "mural_compartilhado", actor: input.by, summary: `Compartilhou com a plataforma: ${shorten(entry.title, 80)}`, refs: item ? { mediaId: item.id } : {} });
    return structuredClone(entry);
  }

  /** Tira a marca de compartilhada da mídia de origem (quando a entrada sai do mural). */
  private release(entry: MuralEntry): void {
    entry.status = "retirado";
    if (entry.mediaRef) this.host?.media(entry.mediaRef.workspace)?.setShared(entry.mediaRef.mediaId, null);
  }

  /** Retira do mural. `workspace` presente = um agente (só retira o que o próprio workspace compartilhou). */
  retire(id: string, by: string, workspace?: string): MuralEntry {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new HttpError(404, `Item "${id}" não existe no mural`);
    if (workspace && entry.workspace !== workspace) throw new HttpError(403, "Só quem compartilhou retira o item do mural");
    if (entry.status === "retirado") return structuredClone(entry);
    this.release(entry);
    this.save();
    this.emit();
    activity({ workspaceId: entry.workspace, category: "midia", action: "mural_retirado", actor: by, summary: `Retirou do mural: ${shorten(entry.title, 80)}`, refs: entry.mediaRef ? { mediaId: entry.mediaRef.mediaId } : {} });
    return structuredClone(entry);
  }

  /** A mídia (ou o workspace) sumiu: a entrada some do mural junto. */
  dropMedia(workspace: string, mediaId: string): void {
    const entry = this.entries.find((candidate) => candidate.status === "ativo" && candidate.mediaRef?.workspace === workspace && candidate.mediaRef.mediaId === mediaId);
    if (!entry) return;
    entry.status = "retirado";
    this.save();
    this.emit();
  }

  // ---------- Usar ----------

  /**
   * `mural_use`: o workspace traz o item. Mídia: o arquivo é copiado para a biblioteca dele (rascunho, origem
   * "mural", a nota diz de onde veio) e marca quem usou. Entrega ou nota em texto: devolve o texto.
   */
  async use(id: string, workspace: string, by: string, createdBy: string = MEDIA_USER_CREATOR): Promise<MuralUse> {
    const host = this.host;
    if (!host) throw new HttpError(503, "O mural ainda não está pronto");
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.status !== "ativo") throw new HttpError(404, `Item "${id}" não está no mural (veja mural_list)`);
    const target = host.media(workspace);
    if (!target) throw new HttpError(404, `Workspace "${workspace}" não encontrado`);
    let mediaId: string | undefined;
    if (entry.mediaRef) {
      if (entry.workspace === workspace) throw new HttpError(409, "Este item é do seu próprio workspace: a mídia já está na sua biblioteca");
      const source = host.media(entry.mediaRef.workspace)?.find(entry.mediaRef.mediaId);
      if (!source) {
        this.dropMedia(entry.mediaRef.workspace, entry.mediaRef.mediaId);
        throw new HttpError(404, "A mídia de origem não existe mais; o item saiu do mural");
      }
      const origin = this.nameOf(entry.workspace);
      const copy = await target.copyFrom(host.media(entry.mediaRef.workspace)!.fileOf(source), source.mime, {
        title: source.title,
        createdBy,
        origin: "mural",
        fileName: source.fileName,
        note: `Do mural: ${origin} · ${entry.id}${entry.note ? ` — ${entry.note}` : ""}`.slice(0, 500),
      });
      mediaId = copy.id;
    }
    if (!entry.usedBy.includes(workspace)) entry.usedBy.push(workspace);
    this.save();
    this.emit();
    activity({ workspaceId: workspace, category: "midia", action: "mural_usado", actor: by, summary: `Trouxe do mural: ${shorten(entry.title, 80)}`, ...(mediaId ? { refs: { mediaId } } : {}) });
    return { entry: structuredClone(entry), ...(mediaId ? { mediaId } : {}), ...(entry.text ? { text: entry.text } : {}) };
  }

  // ---------- Internos ----------

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private save(): void {
    const entries = structuredClone({ items: this.entries });
    const seen = structuredClone(this.cursors);
    void this.queue
      .enqueue(async () => {
        await mkdir(path.dirname(this.files.entries), { recursive: true });
        await writeJsonAtomic(this.files.entries, entries);
        await writeJsonAtomic(this.files.seen, seen);
      })
      .catch(this.onError);
  }
}
