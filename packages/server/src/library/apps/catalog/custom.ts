import { readFile } from "node:fs/promises";
import path from "node:path";
import { catalogAppSchema, type CatalogApp } from "@cyno/shared";

/**
 * Apps que o dono acrescentou ao catálogo (`data/platform/library/custom-catalog.json`, um array de
 * entradas no mesmo formato do catálogo curado; o gancho para "adicionar por URL do GitHub", que
 * chega com o Cyno). Cada entrada passa pelo mesmo `catalogAppSchema`: a inválida é ignorada (e
 * avisada), a que repete o id de uma do catálogo curado também. A receita continua sem shell.
 */
export async function loadCustomCatalog(libraryDir: string, curated: readonly CatalogApp[], warn: (message: string) => void = () => undefined): Promise<CatalogApp[]> {
  const file = path.join(libraryDir, "custom-catalog.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    warn("custom-catalog.json: JSON malformado; ignorado");
    return [];
  }
  if (!Array.isArray(data)) {
    warn("custom-catalog.json: esperava uma lista de apps; ignorado");
    return [];
  }
  const taken = new Set(curated.map((app) => app.id));
  const out: CatalogApp[] = [];
  for (const [index, item] of data.entries()) {
    const parsed = catalogAppSchema.safeParse(item);
    if (!parsed.success) {
      warn(`custom-catalog.json[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}; ignorada`);
      continue;
    }
    if (taken.has(parsed.data.id)) {
      warn(`custom-catalog.json[${index}]: o id "${parsed.data.id}" já existe no catálogo; ignorada`);
      continue;
    }
    taken.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}
