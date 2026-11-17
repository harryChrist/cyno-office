import type { MediaItem, ServerEvent, UpdateMediaBody } from "@cyno/shared";
import { create } from "zustand";
import { api, ApiRequestError, describeError, uploadMedia } from "../api/client";
import { uploadErrorMessage, uploadProblem } from "../pages/media/mediaView";
import { dropRemoteMedia } from "../pages/media/useMediaScope";
import { useNavStore } from "./navStore";
import { openMedia } from "./navTargets";

/** Eventos da biblioteca de mídia (ficam fora do escritório; esta store os aplica). */
export const isMediaEvent = (event: ServerEvent): boolean => event.type === "media:upserted" || event.type === "media:deleted";

/** Mais novas primeiro (o servidor devolve assim; um item novo entra no topo). */
const byNewest = (a: MediaItem, b: MediaItem) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Aplica um evento na lista (função pura: a store e os testes usam a mesma). */
export function applyMediaEvent(items: readonly MediaItem[], event: ServerEvent): MediaItem[] {
  if (event.type === "media:upserted") {
    const rest = items.filter((item) => item.id !== event.media.id);
    return [...rest, event.media].sort(byNewest);
  }
  if (event.type === "media:deleted") return items.filter((item) => item.id !== event.id);
  return [...items];
}

/** Um envio em andamento (ou que falhou: fica na lista até o usuário dispensar). */
export type UploadState = { key: string; name: string; progress: number; error?: string };

type MediaState = {
  /** Workspace dos dados abaixo (trocar de workspace descarta tudo). */
  workspaceId: string | null;
  /** null = ainda não carregou. */
  items: MediaItem[] | null;
  /** Pastas da biblioteca (caminhos); null = ainda não carregou. */
  folders: string[] | null;
  error: string | null;
  uploads: UploadState[];
  /** Mídia que a página deve abrir no detalhe ao entrar (vem de "Ver na Mídia"). */
  focusId: string | null;
  /** Busca a lista do workspace atual; se já carregou, só atualiza. */
  load: () => Promise<void>;
  /** Carrega uma vez por workspace (para quem só precisa das miniaturas). */
  ensureLoaded: () => void;
  apply: (event: ServerEvent) => void;
  /** Envia vários arquivos, um por vez, para a pasta (raiz se vazia); devolve os itens criados. */
  upload: (files: readonly File[], folder?: string) => Promise<MediaItem[]>;
  loadFolders: () => Promise<void>;
  createFolder: (name: string, parent?: string) => Promise<string>;
  renameFolder: (path: string, name: string) => Promise<string>;
  /** Os itens e as subpastas sobem; devolve a pasta que os recebeu. */
  deleteFolder: (path: string) => Promise<string>;
  moveItems: (ids: readonly string[], folder: string) => Promise<void>;
  dismissUpload: (key: string) => void;
  patch: (id: string, body: UpdateMediaBody) => Promise<MediaItem>;
  remove: (id: string) => Promise<void>;
  /** Copia uma mídia de outro workspace para este; devolve a cópia (já na lista). */
  bring: (fromWorkspace: string, mediaId: string) => Promise<MediaItem>;
  /** "Ver na Mídia": vai para a página e abre o item. */
  open: (id: string) => void;
  clearFocus: () => void;
  reset: () => void;
};

let uploadSeq = 0;
let foldersTimer: ReturnType<typeof setTimeout> | undefined;
/** Junta vários eventos seguidos (um upload em lote, um mover vários) numa só busca das pastas. */
function scheduleFolders(): void {
  if (foldersTimer) clearTimeout(foldersTimer);
  foldersTimer = setTimeout(() => {
    foldersTimer = undefined;
    void useMediaStore.getState().loadFolders();
  }, 300);
}

export const useMediaStore = create<MediaState>()((set, get) => ({
  workspaceId: null,
  items: null,
  folders: null,
  error: null,
  uploads: [],
  focusId: null,

  async load() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    if (get().workspaceId !== workspaceId) set({ workspaceId, items: null, folders: null, error: null, uploads: [] });
    void get().loadFolders();
    try {
      const items = await api.listMedia();
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      set({ items, error: null });
    } catch (error) {
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      set({ error: describeError(error) });
    }
  },

  ensureLoaded() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    const { workspaceId: loaded, items, error } = get();
    if (loaded === workspaceId && (items !== null || error !== null)) return;
    void get().load();
  },

  apply(event) {
    if (!isMediaEvent(event)) return;
    // O que outra página guardou deste workspace (ele visto como "outro") ficou velho.
    const current = useNavStore.getState().workspaceId;
    if (current) dropRemoteMedia(current);
    // Pasta criada, renomeada ou apagada (aqui ou em outra aba) muda o índice sem evento próprio: busca de novo, sem pressa.
    scheduleFolders();
    const items = get().items;
    // Ainda não carregou: o primeiro load já traz o estado mais novo.
    if (!items) return;
    set({ items: applyMediaEvent(items, event) });
  },

  async loadFolders() {
    const workspaceId = useNavStore.getState().workspaceId;
    if (!workspaceId) return;
    try {
      const folders = await api.listMediaFolders();
      if (useNavStore.getState().workspaceId !== workspaceId) return;
      set({ folders });
    } catch {
      // As pastas são um extra: sem elas a página segue com a lista plana.
      if (get().folders === null) set({ folders: [] });
    }
  },

  async createFolder(name, parent) {
    const result = await api.createMediaFolder({ name, ...(parent ? { parent } : {}) });
    set({ folders: result.folders });
    return result.folder;
  },

  async renameFolder(path, name) {
    const result = await api.renameMediaFolder({ path, name });
    set({ folders: result.folders });
    return result.folder;
  },

  async deleteFolder(path) {
    const result = await api.deleteMediaFolder(path);
    set({ folders: result.folders });
    return result.folder;
  },

  async moveItems(ids, folder) {
    const result = await api.moveMedia({ ids: [...ids], folder: folder || null });
    const items = get().items;
    const moved = new Map(result.items.map((item) => [item.id, item]));
    set({ folders: result.folders, ...(items ? { items: items.map((item) => moved.get(item.id) ?? item) } : {}) });
  },

  async upload(files, folder = "") {
    const workspaceId = useNavStore.getState().workspaceId;
    const created: MediaItem[] = [];
    for (const file of files) {
      const key = `u${(uploadSeq += 1)}`;
      const problem = uploadProblem(file);
      if (problem) {
        set({ uploads: [...get().uploads, { key, name: file.name, progress: 0, error: problem }] });
        continue;
      }
      set({ uploads: [...get().uploads, { key, name: file.name, progress: 0 }] });
      const setProgress = (patch: Partial<UploadState>) => set({ uploads: get().uploads.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)) });
      try {
        const item = await uploadMedia(file, { ...(folder ? { folder } : {}), onProgress: (progress) => setProgress({ progress }) });
        created.push(item);
        // O evento do websocket costuma chegar antes da resposta; só entra se ainda não estiver na lista.
        if (useNavStore.getState().workspaceId === workspaceId) {
          const items = get().items;
          if (items && !items.some((existing) => existing.id === item.id)) set({ items: [...items, item].sort(byNewest) });
        }
        set({ uploads: get().uploads.filter((entry) => entry.key !== key) });
      } catch (error) {
        const status = error instanceof ApiRequestError ? error.status : undefined;
        setProgress({ error: uploadErrorMessage(status, file.name, describeError(error)) });
      }
    }
    return created;
  },

  dismissUpload(key) {
    set({ uploads: get().uploads.filter((entry) => entry.key !== key) });
  },

  async patch(id, body) {
    const item = await api.updateMedia(id, body);
    // Mostra já (o evento chega em seguida com o mesmo conteúdo).
    const items = get().items;
    if (items) set({ items: items.map((existing) => (existing.id === id ? item : existing)) });
    return item;
  },

  async remove(id) {
    await api.deleteMedia(id);
    const items = get().items;
    if (items) set({ items: items.filter((existing) => existing.id !== id) });
  },

  async bring(fromWorkspace, mediaId) {
    const workspaceId = useNavStore.getState().workspaceId;
    const item = await api.bringMedia({ workspace: fromWorkspace, mediaId });
    const items = get().items;
    if (items && useNavStore.getState().workspaceId === workspaceId && !items.some((existing) => existing.id === item.id)) set({ items: [...items, item].sort(byNewest) });
    return item;
  },

  open(id) {
    set({ focusId: id });
    openMedia();
  },

  clearFocus: () => set({ focusId: null }),

  reset() {
    set({ workspaceId: null, items: null, folders: null, error: null, uploads: [], focusId: null });
  },
}));
