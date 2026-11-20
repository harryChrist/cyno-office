import { FILE_LIMITS, fileDirOf, fileNameOf, joinFilePath, type FileReadResponse, type FileRoot } from "@cyno/shared";
import { create } from "zustand";
import { api, ApiRequestError, describeError } from "../api/client";
import {
  ancestorDirs,
  clampTreeWidth,
  closeTab as closeTabIn,
  diskTextOf,
  discardMessage,
  dropNodeKeys,
  editorTextOf,
  editTooBig,
  focusAfterDelete,
  isInside,
  loadPersisted,
  nodeKey,
  openTab as openTabIn,
  pinTab as pinTabIn,
  readErrorText,
  remapActive,
  remapFocus,
  remapNodeKeys,
  remapTabs,
  savePersisted,
  soleDirChild,
  tabsInside,
  textStyleOf,
  TREE_WIDTH_DEFAULT,
  tabKey,
  type DirListing,
  type FileRef,
  type FileTab,
  type PersistedFiles,
  type TextStyle,
} from "../pages/files/filesView";
import { runUploadQueue, uploadSummaryText, type ReplaceChoice } from "../pages/files/uploadQueue";
import { setWorkspaceGuard, useNavStore } from "./navStore";

/** O que a tela sabe de um arquivo aberto numa aba. */
export type OpenedFile = Extract<FileReadResponse, { root: string }>;
export type FileState = {
  status: "loading" | "ready" | "error";
  data?: OpenedFile;
  error?: string;
  /** Quando o conteúdo foi trocado por uma leitura ao vivo (ms); a tela mostra "Atualizado agora" por uns segundos. */
  updatedAt?: number;
  /** Quando um salvamento terminou (ms); a tela mostra "Salvo" por uns segundos. */
  savedAt?: number;
};

/** Um arquivo em edição. O rascunho (o texto digitado) fica fora daqui, em `draftOf`: guardá-lo aqui recriaria o estado a cada tecla. */
export type EditSession = {
  /** O texto de quando o editor abriu (já no estilo do editor, `\n`). */
  text: string;
  /** A versão que veio com o texto: vai como `baseVersion` ao salvar. */
  version: string;
  /** A última versão do disco que a tela conferiu e o dono já viu (a releitura ao vivo compara com esta). */
  seen: string;
  /** Uma versão nova do disco apareceu e ainda não foi vista. */
  pendingSeen?: string;
  style: TextStyle;
  dirty: boolean;
  /** O arquivo mudou no disco enquanto se editava. */
  diskChanged: boolean;
  /** Muda ao recarregar: o editor recomeça do texto novo. */
  rev: number;
  saving: boolean;
};

/** Pergunta de descartar alterações, à espera do "sim" do dono. */
export type PendingDiscard = { message: string; action: { type: "close"; key: string } | { type: "close-all" } | { type: "cancel-edit"; key: string } };

/** O painel de envio no pé da árvore. */
export type UploadPanel = { status: "running" | "done"; index: number; total: number; name: string; fraction: number; text: string; notes: string[]; asking: string | null };

export type Notice = { text: string; tone: "info" | "warn" };

export type SaveResult = { ok: true } | { ok: false; conflict: boolean; message: string };
export type ChangeResult = { ok: true } | { ok: false; conflict: boolean; message: string };

/** Rascunhos dos editores abertos (chave da aba -> texto). Ficam só na memória: nunca vão para o localStorage nem para o estado global. */
const drafts = new Map<string, string>();
export const draftOf = (key: string): string | undefined => drafts.get(key);
export const setDraft = (key: string, text: string): void => void drafts.set(key, text);

type FilesStoreState = {
  /** O workspace a que o estado pertence (null = ainda não iniciado). */
  workspaceId: string | null;
  roots: FileRoot[] | null;
  rootsError: string | null;
  dirs: Record<string, DirListing | undefined>;
  open: Record<string, true | undefined>;
  /** Raízes abertas. Toda raiz nasce recolhida: só abre quando a pessoa clica (ou quando um arquivo é mostrado na árvore). */
  rootsOpen: Record<string, true | undefined>;
  focus: Record<string, string | undefined>;
  tabs: FileTab[];
  active: string | null;
  width: number;
  files: Record<string, FileState | undefined>;
  edits: Record<string, EditSession | undefined>;
  discard: PendingDiscard | null;
  upload: UploadPanel | null;
  notice: Notice | null;

  /** Entra num workspace: lembra o estado dele, carrega as raízes e as pastas que estavam abertas. */
  init: (workspaceId: string) => Promise<void>;
  loadRoots: () => Promise<void>;
  /** Lê (ou relê) uma pasta. `more` anexa a próxima página; `filter` troca o filtro (volta à primeira página). */
  loadDir: (root: string, path: string, options?: { more?: boolean; filter?: string; silent?: boolean; autoOpen?: boolean }) => Promise<void>;
  toggleDir: (root: string, path: string) => void;
  setDirOpen: (root: string, path: string, open: boolean) => void;
  toggleRoot: (root: string) => void;
  setFocus: (root: string, path: string | null) => void;
  /** Abre a árvore até uma pasta (e tira o foco se ela ficar fora dele). */
  reveal: (root: string, dir: string) => Promise<void>;
  /** Relê as pastas abertas, sem piscar. */
  refreshTree: () => Promise<void>;
  openFile: (ref: FileRef, pin: boolean) => void;
  activate: (key: string) => void;
  pinTab: (key: string) => void;
  closeTab: (key: string) => void;
  closeAll: () => void;
  /** Lê o arquivo de uma aba. `live` manda a versão conhecida e só troca o conteúdo se mudou. */
  loadFile: (ref: FileRef, live?: boolean) => Promise<void>;
  setWidth: (width: number) => void;
  reset: () => void;

  // ---- editar, criar, renomear, apagar e enviar (só em raiz com escrita)
  /** Abre o editor de um arquivo: lê o texto exato do disco. Devolve a mensagem do servidor se recusou (e a tela continua na leitura). */
  startEdit: (ref: FileRef) => Promise<string | null>;
  setDirty: (key: string, dirty: boolean) => void;
  saveEdit: (ref: FileRef, overwrite?: boolean) => Promise<SaveResult>;
  /** Descarta o rascunho e relê o arquivo do disco no editor (conflito e "mudou no disco"). */
  reloadEdit: (ref: FileRef) => Promise<string | null>;
  /** "Continuar editando": o dono viu que o arquivo mudou no disco e segue. */
  keepEditing: (key: string) => void;
  cancelEdit: (key: string) => void;
  requestCloseTab: (key: string) => void;
  requestCloseAll: () => void;
  requestCancelEdit: (key: string) => void;
  confirmDiscard: () => void;
  dismissDiscard: () => void;
  createItem: (root: string, path: string, kind: "file" | "dir") => Promise<ChangeResult>;
  renamePath: (root: string, from: string, to: string) => Promise<ChangeResult>;
  /** Apaga e fecha as abas do item. Lança com a mensagem do servidor se falhar. */
  deletePath: (root: string, path: string) => Promise<void>;
  uploadFiles: (root: string, dir: string, files: File[]) => Promise<void>;
  answerReplace: (choice: ReplaceChoice) => void;
  cancelUpload: () => void;
  setNotice: (notice: Notice | null) => void;
  /** Os nomes das abas com alteração não salva. */
  dirtyNames: () => string[];
};

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const flag = (keys: readonly string[]): Record<string, true> => Object.fromEntries(keys.map((key) => [key, true as const]));

const initial = {
  workspaceId: null,
  roots: null,
  rootsError: null,
  dirs: {},
  open: {},
  rootsOpen: {},
  focus: {},
  tabs: [] as FileTab[],
  active: null,
  width: TREE_WIDTH_DEFAULT,
  files: {},
  edits: {},
  discard: null as PendingDiscard | null,
  upload: null as UploadPanel | null,
  notice: null as Notice | null,
};

/** O envio em andamento (para cancelar) e a resposta pendente da pergunta "Substituir?". */
let uploadRun: AbortController | null = null;
let replaceAnswer: ((choice: ReplaceChoice) => void) | null = null;

/** Quantas pastas seguidas a abertura automática da cadeia compacta percorre, no máximo. */
const AUTO_OPEN_MAX = 24;

export const useFilesStore = create<FilesStoreState>()((set, get) => {
  /** Guarda o que deve ser lembrado deste workspace. */
  const persist = (): void => {
    const state = get();
    if (!state.workspaceId) return;
    const data: PersistedFiles = {
      tabs: state.tabs,
      active: state.active,
      open: Object.keys(state.open),
      rootsOpen: Object.keys(state.rootsOpen),
      focus: Object.fromEntries(Object.entries(state.focus).filter((pair): pair is [string, string] => Boolean(pair[1]))),
      width: state.width,
    };
    savePersisted(state.workspaceId, data, storage());
  };
  const stale = (workspaceId: string): boolean => get().workspaceId !== workspaceId || useNavStore.getState().workspaceId !== workspaceId;

  return {
    ...initial,

    async init(workspaceId) {
      if (get().workspaceId !== workspaceId) {
        const saved = loadPersisted(workspaceId, storage());
        set({
          ...initial,
          workspaceId,
          tabs: saved.tabs,
          active: saved.active,
          open: flag(saved.open),
          rootsOpen: flag(saved.rootsOpen),
          focus: saved.focus,
          width: saved.width,
        });
      }
      await get().loadRoots();
      if (stale(workspaceId)) return;
      // Pastas que estavam abertas (e a base de cada raiz) voltam sem alarde.
      const state = get();
      const jobs: Promise<void>[] = [];
      for (const root of state.roots ?? []) {
        if (root.error || !state.rootsOpen[root.id]) continue;
        jobs.push(get().loadDir(root.id, state.focus[root.id] ?? ""));
      }
      for (const key of Object.keys(state.open)) {
        const [root, path] = key.split("\t") as [string, string];
        if (path) jobs.push(get().loadDir(root, path));
      }
      for (const tab of state.tabs) if (tabKey(tab) === state.active && !get().files[tabKey(tab)]) void get().loadFile(tab);
      await Promise.all(jobs);
    },

    async loadRoots() {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      try {
        const response = await api.getFileRoots();
        if (stale(workspaceId)) return;
        set({ roots: response.roots, rootsError: null });
      } catch (error) {
        if (!stale(workspaceId)) set({ rootsError: describeError(error) });
      }
    },

    async loadDir(root, path, options = {}) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const key = nodeKey(root, path);
      const before = get().dirs[key];
      const filter = options.filter ?? before?.filter ?? "";
      const appending = options.more === true && before !== undefined;
      const offset = appending ? before.entries.length : 0;
      // Releitura silenciosa: pede de volta tudo o que já está na tela (até o máximo da rota).
      const limit = options.silent ? Math.min(FILE_LIMITS.maxPageSize, Math.max(FILE_LIMITS.pageSize, before?.entries.length ?? 0)) : FILE_LIMITS.pageSize;
      if (!options.silent) set((state) => ({ dirs: { ...state.dirs, [key]: { entries: before?.entries ?? [], total: before?.total ?? 0, more: before?.more ?? false, filter, loading: true } } }));
      try {
        const response = await api.listFiles(root, path, { offset, limit, ...(filter ? { filter } : {}) });
        if (stale(workspaceId)) return;
        const now = get().dirs[key];
        // O filtro mudou enquanto esta resposta vinha: a mais nova vale.
        if (now && now.filter !== filter) return;
        const entries = appending ? [...(now?.entries ?? []), ...response.entries] : response.entries;
        set((state) => ({ dirs: { ...state.dirs, [key]: { entries, total: response.total, more: response.more, filter, loading: false } } }));
        if (options.autoOpen && !filter) void autoOpenChain(root, path, 0);
      } catch (error) {
        if (stale(workspaceId)) return;
        if (options.silent) {
          // Releitura que falhou: fica o que já estava na tela.
          if (!before) set((state) => ({ dirs: { ...state.dirs, [key]: { entries: [], total: 0, more: false, filter, loading: false, error: describeError(error) } } }));
          return;
        }
        set((state) => ({
          dirs: {
            ...state.dirs,
            [key]: { entries: appending ? (before?.entries ?? []) : [], total: appending ? (before?.total ?? 0) : 0, more: appending ? (before?.more ?? false) : false, filter, loading: false, error: describeError(error) },
          },
        }));
      }
    },

    toggleDir(root, path) {
      get().setDirOpen(root, path, !get().open[nodeKey(root, path)]);
    },

    setDirOpen(root, path, open) {
      const key = nodeKey(root, path);
      if (Boolean(get().open[key]) === open) return;
      set((state) => {
        const next = { ...state.open };
        if (open) next[key] = true;
        else delete next[key];
        return { open: next };
      });
      persist();
      if (open && !get().dirs[key]) void get().loadDir(root, path, { autoOpen: true });
      else if (open) void autoOpenChain(root, path, 0);
    },

    toggleRoot(root) {
      set((state) => {
        const next = { ...state.rootsOpen };
        if (next[root]) delete next[root];
        else next[root] = true;
        return { rootsOpen: next };
      });
      persist();
      const base = get().focus[root] ?? "";
      if (get().rootsOpen[root] && !get().dirs[nodeKey(root, base)]) void get().loadDir(root, base);
    },

    setFocus(root, path) {
      set((state) => {
        const next = { ...state.focus };
        if (path) next[root] = path;
        else delete next[root];
        return { focus: next };
      });
      persist();
      const base = path ?? "";
      if (!get().dirs[nodeKey(root, base)]) void get().loadDir(root, base);
    },

    async reveal(root, dir) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const focus = get().focus[root];
      const nextFocus = { ...get().focus };
      if (focus && !isInside(focus, dir)) delete nextFocus[root];
      const rootsOpen: Record<string, true | undefined> = { ...get().rootsOpen, [root]: true };
      const open = { ...get().open };
      for (const path of ancestorDirs(dir)) open[nodeKey(root, path)] = true;
      set({ focus: nextFocus, rootsOpen, open });
      persist();
      // Do alto para baixo: cada pasta só aparece depois da lista da anterior.
      const paths = ["", ...ancestorDirs(dir).reverse()];
      for (const path of paths) {
        if (stale(workspaceId)) return;
        if (!get().dirs[nodeKey(root, path)]) await get().loadDir(root, path);
      }
    },

    async refreshTree() {
      const state = get();
      const jobs: Promise<void>[] = [];
      const done = new Set<string>();
      const run = (root: string, path: string) => {
        const key = nodeKey(root, path);
        if (done.has(key) || !get().dirs[key]) return;
        done.add(key);
        jobs.push(get().loadDir(root, path, { silent: true }));
      };
      for (const root of state.roots ?? []) if (!root.error && state.rootsOpen[root.id]) run(root.id, state.focus[root.id] ?? "");
      for (const key of Object.keys(state.open)) {
        const [root, path] = key.split("\t") as [string, string];
        run(root, path);
      }
      jobs.push(get().loadRoots());
      await Promise.all(jobs);
    },

    openFile(ref, pin) {
      const next = openTabIn({ tabs: get().tabs, active: get().active }, ref, pin);
      set({ tabs: next.tabs, active: next.active });
      persist();
      const key = tabKey(ref);
      if (!get().files[key] || get().files[key]!.status === "error") void get().loadFile(ref);
    },

    activate(key) {
      const tab = get().tabs.find((candidate) => tabKey(candidate) === key);
      if (!tab) return;
      set({ active: key });
      persist();
      if (!get().files[key] || get().files[key]!.status === "error") void get().loadFile(tab);
    },

    pinTab(key) {
      const next = pinTabIn({ tabs: get().tabs, active: get().active }, key);
      set({ tabs: next.tabs });
      persist();
    },

    closeTab(key) {
      const next = closeTabIn({ tabs: get().tabs, active: get().active }, key);
      const files = { ...get().files };
      delete files[key];
      const edits = { ...get().edits };
      delete edits[key];
      drafts.delete(key);
      set({ tabs: next.tabs, active: next.active, files, edits });
      persist();
      const tab = next.tabs.find((candidate) => tabKey(candidate) === next.active);
      if (tab && !get().files[tabKey(tab)]) void get().loadFile(tab);
    },

    closeAll() {
      drafts.clear();
      set({ tabs: [], active: null, files: {}, edits: {} });
      persist();
    },

    async loadFile(ref, live = false) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const key = tabKey(ref);
      // Arquivo em edição: a releitura ao vivo nunca troca o conteúdo, só confere se o disco mudou.
      if (live && get().edits[key]) return checkDiskChange(ref, workspaceId);
      const known = live ? get().files[key]?.data?.version : undefined;
      if (!live) set((state) => ({ files: { ...state.files, [key]: { status: "loading" } } }));
      try {
        const response = await api.readFile(ref.root, ref.path, known);
        if (stale(workspaceId) || !get().tabs.some((tab) => tabKey(tab) === key)) return;
        if ("unchanged" in response) return;
        const had = get().files[key]?.data !== undefined;
        set((state) => ({ files: { ...state.files, [key]: { status: "ready", data: response, ...(live && had ? { updatedAt: Date.now() } : {}) } } }));
      } catch (error) {
        if (stale(workspaceId) || !get().tabs.some((tab) => tabKey(tab) === key)) return;
        // Releitura ao vivo que falhou por rede: fica o que já estava. Arquivo que sumiu (404) vira a mensagem na aba.
        const status = error instanceof ApiRequestError ? error.status : undefined;
        if (live && get().files[key]?.data && status !== 404) return;
        set((state) => ({ files: { ...state.files, [key]: { status: "error", error: readErrorText(status, describeError(error)) } } }));
      }
    },

    setWidth(width) {
      set({ width: clampTreeWidth(width, Number.MAX_SAFE_INTEGER) });
      persist();
    },

    reset() {
      drafts.clear();
      uploadRun?.abort();
      uploadRun = null;
      set({ ...initial });
    },

    async startEdit(ref) {
      const workspaceId = get().workspaceId;
      const key = tabKey(ref);
      if (!workspaceId) return null;
      if (get().edits[key]) return null;
      try {
        const response = await api.readFile(ref.root, ref.path, undefined, true);
        if (stale(workspaceId)) return null;
        if ("unchanged" in response || response.text === undefined || (response.view !== "text" && response.view !== "markdown")) return "Este arquivo não abre no editor.";
        const style = textStyleOf(response.text);
        const session: EditSession = { text: editorTextOf(response.text, style), version: response.version, seen: response.version, style, dirty: false, diskChanged: false, rev: 0, saving: false };
        drafts.delete(key);
        set((state) => ({ edits: { ...state.edits, [key]: session } }));
        get().pinTab(key);
        return null;
      } catch (error) {
        return describeError(error);
      }
    },

    setDirty(key, dirty) {
      const session = get().edits[key];
      if (!session || session.dirty === dirty) return;
      set((state) => ({ edits: { ...state.edits, [key]: { ...session, dirty } } }));
    },

    async saveEdit(ref, overwrite = false) {
      const workspaceId = get().workspaceId;
      const key = tabKey(ref);
      const session = get().edits[key];
      if (!workspaceId || !session) return { ok: false, conflict: false, message: "Nada para salvar." };
      if (session.saving) return { ok: false, conflict: false, message: "Já estou salvando." };
      const text = diskTextOf(drafts.get(key) ?? session.text, session.style);
      if (editTooBig(text)) return { ok: false, conflict: false, message: "O texto passou de 512 KB, o limite do editor." };
      set((state) => ({ edits: { ...state.edits, [key]: { ...session, saving: true } } }));
      const unlock = () => {
        const now = get().edits[key];
        if (now) set((state) => ({ edits: { ...state.edits, [key]: { ...now, saving: false } } }));
      };
      try {
        await api.writeFile({ root: ref.root, path: ref.path, text, ...(overwrite ? {} : { baseVersion: session.version }) });
      } catch (error) {
        unlock();
        if (error instanceof ApiRequestError && error.status === 409) return { ok: false, conflict: true, message: error.message };
        return { ok: false, conflict: false, message: describeError(error) };
      }
      drafts.delete(key);
      set((state) => {
        const edits = { ...state.edits };
        delete edits[key];
        return { edits };
      });
      // Volta para a leitura já com o conteúdo novo (e a pasta relida: tamanho e data mudaram).
      try {
        const response = await api.readFile(ref.root, ref.path);
        if (!stale(workspaceId) && !("unchanged" in response) && get().tabs.some((tab) => tabKey(tab) === key)) {
          set((state) => ({ files: { ...state.files, [key]: { status: "ready", data: response, savedAt: Date.now() } } }));
        }
      } catch {
        // a leitura de volta falhou: a releitura ao vivo traz o conteúdo
      }
      void get().loadDir(ref.root, fileDirOf(ref.path), { silent: true });
      return { ok: true };
    },

    async reloadEdit(ref) {
      const workspaceId = get().workspaceId;
      const key = tabKey(ref);
      const session = get().edits[key];
      if (!workspaceId || !session) return null;
      try {
        const response = await api.readFile(ref.root, ref.path, undefined, true);
        if (stale(workspaceId)) return null;
        if ("unchanged" in response || response.text === undefined) return "Não deu para recarregar o arquivo.";
        const style = textStyleOf(response.text);
        drafts.delete(key);
        set((state) => ({ edits: { ...state.edits, [key]: { text: editorTextOf(response.text!, style), version: response.version, seen: response.version, style, dirty: false, diskChanged: false, rev: session.rev + 1, saving: false } } }));
        return null;
      } catch (error) {
        return readErrorText(error instanceof ApiRequestError ? error.status : undefined, describeError(error));
      }
    },

    keepEditing(key) {
      const session = get().edits[key];
      if (!session) return;
      set((state) => ({ edits: { ...state.edits, [key]: { ...session, diskChanged: false, seen: session.pendingSeen ?? session.seen, pendingSeen: undefined } } }));
    },

    cancelEdit(key) {
      drafts.delete(key);
      set((state) => {
        const edits = { ...state.edits };
        delete edits[key];
        return { edits };
      });
    },

    requestCloseTab(key) {
      if (!get().edits[key]?.dirty) return get().closeTab(key);
      set({ discard: { message: discardMessage([nameOfKey(key)]), action: { type: "close", key } } });
    },

    requestCloseAll() {
      const names = get().dirtyNames();
      if (names.length === 0) return get().closeAll();
      set({ discard: { message: discardMessage(names), action: { type: "close-all" } } });
    },

    requestCancelEdit(key) {
      if (!get().edits[key]?.dirty) return get().cancelEdit(key);
      set({ discard: { message: discardMessage([nameOfKey(key)]), action: { type: "cancel-edit", key } } });
    },

    confirmDiscard() {
      const pending = get().discard;
      set({ discard: null });
      if (!pending) return;
      if (pending.action.type === "close") get().closeTab(pending.action.key);
      else if (pending.action.type === "close-all") get().closeAll();
      else get().cancelEdit(pending.action.key);
    },

    dismissDiscard() {
      set({ discard: null });
    },

    async createItem(root, path, kind) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return { ok: false, conflict: false, message: "Sem workspace." };
      try {
        await api.createFile({ root, path, kind });
      } catch (error) {
        return { ok: false, conflict: error instanceof ApiRequestError && error.status === 409, message: describeError(error) };
      }
      const parent = fileDirOf(path);
      await get().loadDir(root, parent, { silent: true });
      if (stale(workspaceId)) return { ok: true };
      if (kind === "dir") {
        await get().reveal(root, path);
        get().setDirOpen(root, path, true);
      } else {
        await get().reveal(root, parent);
        get().openFile({ root, path }, true);
        const message = await get().startEdit({ root, path });
        if (message) get().setNotice({ text: message, tone: "warn" });
      }
      return { ok: true };
    },

    async renamePath(root, from, to) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return { ok: false, conflict: false, message: "Sem workspace." };
      const state = get();
      if (tabsInside(state.tabs, root, from).some((tab) => state.edits[tabKey(tab)]?.dirty)) {
        return { ok: false, conflict: false, message: "Salve ou descarte as alterações antes de renomear." };
      }
      try {
        await api.renameFile({ root, from, to });
      } catch (error) {
        return { ok: false, conflict: error instanceof ApiRequestError && error.status === 409, message: describeError(error) };
      }
      if (stale(workspaceId)) return { ok: true };
      const now = get();
      for (const tab of tabsInside(now.tabs, root, from)) drafts.delete(tabKey(tab));
      set({
        tabs: remapTabs(now.tabs, root, from, to),
        active: remapActive(now.active, root, from, to),
        files: remapNodeKeys(now.files, root, from, to, (value, newPath) => (value.data ? { ...value, data: { ...value.data, path: newPath, name: fileNameOf(newPath) } } : value)),
        edits: remapNodeKeys(now.edits, root, from, to),
        open: remapNodeKeys(now.open, root, from, to),
        dirs: remapNodeKeys(now.dirs, root, from, to),
        focus: remapFocus(now.focus, root, from, to),
      });
      persist();
      const parents = new Set([fileDirOf(from), fileDirOf(to)]);
      await Promise.all([...parents].map((dir) => get().loadDir(root, dir, { silent: true })));
      return { ok: true };
    },

    async deletePath(root, path) {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      await api.deleteFile({ root, path });
      if (stale(workspaceId)) return;
      // Fecha as abas do item (ou de dentro da pasta) sem perguntar de rascunho: a pergunta já foi a de apagar.
      let tabsState = { tabs: get().tabs, active: get().active };
      for (const tab of tabsInside(tabsState.tabs, root, path)) {
        drafts.delete(tabKey(tab));
        tabsState = closeTabIn(tabsState, tabKey(tab));
      }
      const now = get();
      set({
        tabs: tabsState.tabs,
        active: tabsState.active,
        files: dropNodeKeys(now.files, root, path),
        edits: dropNodeKeys(now.edits, root, path),
        open: dropNodeKeys(now.open, root, path),
        dirs: dropNodeKeys(now.dirs, root, path),
        focus: focusAfterDelete(now.focus, root, path),
      });
      persist();
      const next = get().tabs.find((tab) => tabKey(tab) === get().active);
      if (next && !get().files[tabKey(next)]) void get().loadFile(next);
      await get().loadDir(root, fileDirOf(path), { silent: true });
    },

    async uploadFiles(root, dir, files) {
      const workspaceId = get().workspaceId;
      if (!workspaceId || files.length === 0 || get().upload?.status === "running") return;
      const controller = new AbortController();
      uploadRun = controller;
      const cleanup = (text: string, notes: string[]) => {
        set({ upload: { status: "done", index: 0, total: 0, name: "", fraction: 1, text, notes, asking: null } });
        const marker = get().upload;
        setTimeout(() => {
          if (get().upload === marker) set({ upload: null });
        }, notes.length > 0 ? 10_000 : 5_000);
      };
      set({ upload: { status: "running", index: 0, total: files.length, name: "", fraction: 0, text: "", notes: [], asking: null } });
      const summary = await runUploadQueue(
        files,
        {
          send: async (file, overwrite, onProgress, signal) => {
            await api.uploadFile(root, dir, file, { overwrite, onProgress, signal });
          },
          askReplace: (name) =>
            new Promise<ReplaceChoice>((resolve) => {
              replaceAnswer = resolve;
              set((state) => (state.upload ? { upload: { ...state.upload, asking: name } } : {}));
            }),
          onProgress: (progress) => set((state) => (state.upload ? { upload: { ...state.upload, ...progress, asking: null } } : {})),
          describe: describeError,
        },
        controller.signal,
      );
      if (uploadRun === controller) uploadRun = null;
      if (stale(workspaceId)) return;
      const notes = [...summary.skipped.map((item) => `${item.name}: ${item.reason}`), ...summary.failed.map((item) => `${item.name}: ${item.message}`)];
      cleanup(uploadSummaryText(summary), notes);
      // A pasta de destino é relida e aberta.
      await get().loadDir(root, dir, { silent: true });
      if (dir) {
        await get().reveal(root, dir);
        get().setDirOpen(root, dir, true);
      }
    },

    answerReplace(choice) {
      const resolve = replaceAnswer;
      replaceAnswer = null;
      set((state) => (state.upload ? { upload: { ...state.upload, asking: null } } : {}));
      resolve?.(choice);
    },

    cancelUpload() {
      uploadRun?.abort();
      // Se havia pergunta de "substituir" aberta, ela vira "pular" para a fila poder terminar.
      get().answerReplace({ action: "skip", all: true });
    },

    setNotice(notice) {
      set({ notice });
    },

    dirtyNames() {
      const state = get();
      return state.tabs.filter((tab) => state.edits[tabKey(tab)]?.dirty).map((tab) => fileNameOf(tab.path));
    },
  };

  /** Confere (sem trocar nada) se o arquivo em edição mudou no disco desde a versão que o dono já viu. */
  async function checkDiskChange(ref: FileRef, workspaceId: string): Promise<void> {
    const key = tabKey(ref);
    const session = get().edits[key];
    if (!session || session.diskChanged) return;
    const mark = (pendingSeen: string) => {
      const now = get().edits[key];
      if (now && !stale(workspaceId)) set((state) => ({ edits: { ...state.edits, [key]: { ...now, diskChanged: true, pendingSeen } } }));
    };
    try {
      const response = await api.readFile(ref.root, ref.path, session.seen);
      if (!("unchanged" in response)) mark(response.version);
    } catch (error) {
      // Sumiu do disco: também é "mudou". Falha de rede: fica como está.
      if (error instanceof ApiRequestError && error.status === 404 && session.seen !== "gone") mark("gone");
    }
  }

  function nameOfKey(key: string): string {
    return fileNameOf(key.slice(key.indexOf("\t") + 1));
  }

  /** Abre sozinho a pasta que é o único item de outra aberta, seguindo a cadeia (o caminho compacto "a/b/c"). */
  async function autoOpenChain(root: string, path: string, depth: number): Promise<void> {
    if (depth >= AUTO_OPEN_MAX) return;
    const child = soleDirChild(get().dirs[nodeKey(root, path)]);
    if (!child) return;
    const childPath = joinFilePath(path, child.name);
    const key = nodeKey(root, childPath);
    if (!get().open[key]) {
      set((state) => ({ open: { ...state.open, [key]: true } }));
      persist();
    }
    if (!get().dirs[key]) await get().loadDir(root, childPath);
    await autoOpenChain(root, childPath, depth + 1);
  }
});

// Trocar de workspace com alteração não salva pede confirmação.
setWorkspaceGuard(() => {
  const names = useFilesStore.getState().dirtyNames();
  if (names.length === 0) return true;
  return typeof window === "undefined" || typeof window.confirm !== "function" || window.confirm(`${discardMessage(names)} Ao trocar de workspace elas se perdem.`);
});
