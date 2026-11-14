import { readFile } from "node:fs/promises";
import { workspaceListSchema, type Workspace } from "@cyno/shared";
import { writeJsonAtomic } from "./atomic-write";
import { DataFileError } from "./files";
import { WriteQueue } from "./write-queue";

/** Lê data/workspaces.json; `null` se o arquivo ainda não existe. */
export async function readWorkspaceList(file: string): Promise<Workspace[] | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DataFileError(file, ["JSON malformado"]);
  }
  const result = workspaceListSchema.safeParse(data);
  if (!result.success) {
    throw new DataFileError(
      file,
      result.error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`),
    );
  }
  const ids = result.data.map((ws) => ws.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0) throw new DataFileError(file, repeated.map((id) => `workspace com id repetido: "${id}"`));
  return result.data;
}

export function writeWorkspaceList(file: string, workspaces: Workspace[]): Promise<void> {
  return writeJsonAtomic(file, workspaces);
}

/** A lista de workspaces em memória, gravada em workspaces.json (escrita atômica e em fila). */
export class WorkspaceRegistry {
  private readonly queue = new WriteQueue();

  constructor(
    private readonly file: string,
    private items: Workspace[],
  ) {}

  list(): Workspace[] {
    return structuredClone(this.items);
  }

  has(id: string): boolean {
    return this.items.some((ws) => ws.id === id);
  }

  commit(next: Workspace[]): Promise<void> {
    this.items = structuredClone(next);
    const data = this.items;
    return this.queue.enqueue(() => writeWorkspaceList(this.file, data));
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
