import { deflateRawSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../platform/http/errors";
import { safeRelativePath, stripCommonRoot, validateSkillFiles, type SkillFile } from "./validate";
import { readZip } from "./zip";

const md = (name = "Minha skill", description = "Use quando precisar de um exemplo de skill.", body = "Corpo da skill.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const file = (path: string, text: string | Buffer): SkillFile => ({ path, data: Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8") });
const fails = (action: () => unknown, status: number, message: RegExp) => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(status);
    expect((error as HttpError).message).toMatch(message);
    return;
  }
  throw new Error("era para falhar");
};

/** .zip mínimo para os testes (deflate ou stored). */
function makeZip(entries: { name: string; data: Buffer; stored?: boolean; symlink?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.stored ? entry.data : deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.symlink ? 0o120777 : 0o100644) * 65536, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

describe("validação de skills", () => {
  it("aceita um SKILL.md com frontmatter e arquivos de apoio; conta bytes e ordena", () => {
    const result = validateSkillFiles([file("modelo.html", "<p>oi</p>"), file("SKILL.md", md()), file("refs/regras.md", "regras")]);
    expect(result.frontmatter).toMatchObject({ name: "Minha skill" });
    expect(result.files.map((f) => f.path)).toEqual(["SKILL.md", "modelo.html", "refs/regras.md"]);
    expect(result.bytes).toBe(Buffer.byteLength(md()) + 9 + 6);
  });

  it("lê descrição em bloco dobrado e entre aspas", () => {
    const folded = validateSkillFiles([file("SKILL.md", "---\nname: x\ndescription: >\n  Use quando a tarefa pedir um carrossel\n  de post em HTML.\n---\ncorpo")]);
    expect(folded.frontmatter.description).toBe("Use quando a tarefa pedir um carrossel de post em HTML.");
    const quoted = validateSkillFiles([file("SKILL.md", '---\nname: "Com: dois pontos"\ndescription: \'Use quando o dono disser "oi".\'\n---\ncorpo')]);
    expect(quoted.frontmatter).toMatchObject({ name: "Com: dois pontos", description: 'Use quando o dono disser "oi".' });
  });

  it("recusa sem SKILL.md, sem frontmatter, sem name ou description", () => {
    fails(() => validateSkillFiles([file("outro.md", "x")]), 400, /SKILL\.md/);
    fails(() => validateSkillFiles([file("SKILL.md", "só texto")]), 400, /frontmatter/);
    fails(() => validateSkillFiles([file("SKILL.md", "---\ndescription: Use quando algo.\n---\nx")]), 400, /name/);
    fails(() => validateSkillFiles([file("SKILL.md", "---\nname: x\n---\nx")]), 400, /description/);
  });

  it("recusa nomes de arquivo inseguros (.., absoluto, espaço, barra invertida)", () => {
    for (const bad of ["../fora.md", "/etc/passwd", "a b.md", "a\\b.md", "x/../../y.md", "a//b.md/.."]) {
      expect(safeRelativePath(bad), bad).toBeNull();
    }
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("../fora.md", "x")]), 400, /não permitido/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("meu arquivo.md", "x")]), 400, /não permitido/);
  });

  it("recusa executáveis nativos (extensão ou bytes) e avisa de scripts, sem dar permissão de execução", () => {
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("run.exe", "x")]), 400, /executável/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("ferramenta", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))]), 400, /executável/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("tool", Buffer.from([0x4d, 0x5a, 0x90, 0x00]))]), 400, /executável/);
    const script = validateSkillFiles([file("SKILL.md", md()), file("render.py", "print('oi')")]);
    expect(script.warnings.join(" ")).toMatch(/render\.py.*terminal/);
  });

  it("ignora arquivos escondidos (.DS_Store, .git) e tira a pasta única do navegador/zip", () => {
    const result = validateSkillFiles([file("minha-skill/SKILL.md", md()), file("minha-skill/.DS_Store", "x"), file("minha-skill/refs/a.md", "a")]);
    expect(result.files.map((f) => f.path)).toEqual(["SKILL.md", "refs/a.md"]);
    expect(stripCommonRoot([{ path: "a/x.md" }, { path: "b/y.md" }])).toEqual([{ path: "a/x.md" }, { path: "b/y.md" }]);
  });

  it("não barra por tamanho no uso normal; só o teto técnico contra acidente recusa, com a mensagem certa", () => {
    // 450 KB em 29 arquivos (como a skill ui-ux-pro-max): importa.
    const normal = [file("SKILL.md", md()), ...Array.from({ length: 28 }, (_, i) => file(`data/f${i}.csv`, "x".repeat(16 * 1024)))];
    expect(validateSkillFiles(normal).files).toHaveLength(29);
    const ceiling = { maxBytes: 100 * 1024, maxFiles: 10, maxPathLength: 40, maxDepth: 3 };
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("grande.txt", "x".repeat(101 * 1024))], ceiling), 413, /teto técnico.*KB/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), ...Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`, "x"))], ceiling), 413, /teto técnico.*10/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), file("a/b/c/d.txt", "x")], ceiling), 400, /3 níveis/);
    fails(() => validateSkillFiles([file("SKILL.md", md()), file(`${"a".repeat(41)}.txt`, "x")], ceiling), 400, /40 caracteres/);
    expect(safeRelativePath("a/b/c/d/e/f/g/h/i/j/k/l.txt")).not.toBeNull();
    expect(safeRelativePath(`${"a/".repeat(12)}x.txt`)).toBeNull();
  });

  it("SKILL.md grande importa com aviso (não recusa)", () => {
    const big = validateSkillFiles([file("SKILL.md", md("x", "Use quando algo acontecer.", "y".repeat(34_000)))]);
    expect(big.warnings.join(" ")).toMatch(/SKILL\.md é grande: ~\d+ tokens entram no contexto/);
    expect(validateSkillFiles([file("SKILL.md", md())]).warnings.join(" ")).not.toMatch(/grande/);
  });

  it("o .zip também só tem o teto técnico (anti zip bomb)", () => {
    const zip = makeZip([{ name: "SKILL.md", data: Buffer.from(md()) }, ...Array.from({ length: 28 }, (_, i) => ({ name: `data/f${i}.csv`, data: Buffer.from("x".repeat(16 * 1024)) }))]);
    expect(validateSkillFiles(readZip(zip)).files).toHaveLength(29);
    const small = { maxBytes: 100 * 1024, maxFiles: 10, maxPathLength: 240, maxDepth: 12 };
    fails(() => readZip(zip, small), 413, /arquivos demais|teto técnico/);
    fails(() => readZip(makeZip([{ name: "SKILL.md", data: Buffer.from(md() + "x".repeat(200 * 1024)) }]), small), 413, /teto técnico/);
  });

  it("lê um .zip (deflate e stored), tira a pasta raiz e recusa link simbólico e zip inválido", () => {
    const zip = makeZip([
      { name: "pasta/", data: Buffer.alloc(0), stored: true },
      { name: "pasta/SKILL.md", data: Buffer.from(md()) },
      { name: "pasta/apoio.txt", data: Buffer.from("apoio"), stored: true },
      { name: "__MACOSX/pasta/._SKILL.md", data: Buffer.from("lixo") },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.path)).toEqual(["pasta/SKILL.md", "pasta/apoio.txt"]);
    expect(validateSkillFiles(files).files.map((f) => f.path)).toEqual(["SKILL.md", "apoio.txt"]);
    fails(() => readZip(makeZip([{ name: "SKILL.md", data: Buffer.from("../../etc/passwd"), symlink: true }])), 400, /link simbólico/);
    fails(() => readZip(Buffer.from("isto não é um zip")), 400, /zip/);
  });
});
