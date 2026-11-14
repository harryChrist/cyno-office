/**
 * Tela virtual mínima de um terminal: o suficiente para LER o que a TUI do Freebuff mostra (a
 * caixa de pedido, o seletor do `/model`, o rodapé), sem biblioteca de emulação. Entende o movimento
 * do cursor, apagar, rolar e inserir/apagar linhas; cores e títulos são ignorados.
 * Também diz o que responder às perguntas que a TUI faz ao terminal (posição do cursor, tipo de terminal).
 */
export class ScreenBuffer {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private top = 0;
  private bottom: number;
  private carry = "";

  constructor(
    public cols = 120,
    public rows = 36,
  ) {
    this.bottom = rows - 1;
    this.grid = this.blank(rows, cols);
  }

  private blank(rows: number, cols: number): string[][] {
    return Array.from({ length: rows }, () => new Array<string>(cols).fill(" "));
  }

  resize(cols: number, rows: number): void {
    const next = this.blank(rows, cols);
    for (let r = 0; r < Math.min(rows, this.rows); r += 1) for (let c = 0; c < Math.min(cols, this.cols); c += 1) next[r]![c] = this.grid[r]![c]!;
    this.grid = next;
    this.cols = cols;
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }

  /** Escreve a saída do processo; devolve as respostas que o terminal deveria mandar de volta (se houver). */
  write(data: string): string[] {
    const replies: string[] = [];
    const text = this.carry + data;
    this.carry = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\x1b") {
        const next = text[i + 1];
        if (next === undefined) {
          this.carry = text.slice(i);
          break;
        }
        if (next === "[") {
          let j = i + 2;
          while (j < text.length && !/[@-~]/.test(text[j]!)) j += 1;
          if (j >= text.length) {
            this.carry = text.slice(i);
            break;
          }
          this.csi(text.slice(i + 2, j), text[j]!, replies);
          i = j + 1;
        } else if (next === "]" || next === "P" || next === "_" || next === "^") {
          let j = i + 2;
          let end = -1;
          while (j < text.length) {
            if (text[j] === "\x07") {
              end = j + 1;
              break;
            }
            if (text[j] === "\x1b" && text[j + 1] === "\\") {
              end = j + 2;
              break;
            }
            j += 1;
          }
          if (end === -1) {
            this.carry = text.slice(i);
            break;
          }
          i = end;
        } else {
          this.esc(next);
          i += next === "(" || next === ")" || next === "#" ? 3 : 2;
        }
        continue;
      }
      i += 1;
      if (ch === "\n" || ch === "\v" || ch === "\f") this.lineFeed();
      else if (ch === "\r") this.col = 0;
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch >= " " && ch !== "\x7f") {
        let glyph = ch;
        if (ch.codePointAt(0)! > 0xffff) {
          glyph = text.slice(i - 1, i + 1);
          i += 1;
        }
        this.put(glyph);
      }
    }
    return replies;
  }

  private put(glyph: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row]![this.col] = glyph;
    this.col += 1;
  }

  private lineFeed(): void {
    if (this.row === this.bottom) this.scrollUp(1);
    else if (this.row < this.rows - 1) this.row += 1;
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k += 1) {
      this.grid.splice(this.top, 1);
      this.grid.splice(this.bottom, 0, new Array<string>(this.cols).fill(" "));
    }
  }

  private scrollDown(n: number): void {
    for (let k = 0; k < n; k += 1) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, new Array<string>(this.cols).fill(" "));
    }
  }

  private esc(code: string): void {
    if (code === "7") [this.savedRow, this.savedCol] = [this.row, this.col];
    else if (code === "8") [this.row, this.col] = [this.savedRow, this.savedCol];
    else if (code === "D") this.lineFeed();
    else if (code === "E") {
      this.col = 0;
      this.lineFeed();
    } else if (code === "M") {
      if (this.row === this.top) this.scrollDown(1);
      else this.row = Math.max(0, this.row - 1);
    } else if (code === "c") {
      this.grid = this.blank(this.rows, this.cols);
      this.row = this.col = 0;
      this.top = 0;
      this.bottom = this.rows - 1;
    }
  }

  private csi(body: string, final: string, replies: string[]): void {
    const priv = /^[?>=<!]/.test(body) ? body[0]! : "";
    const params = body
      .replace(/^[?>=<!]/, "")
      .replace(/[ -/]+$/, "")
      .split(";")
      .map((part) => (part === "" ? 0 : Number.parseInt(part, 10) || 0));
    const p = (index: number, fallback: number) => (params[index] === undefined || params[index] === 0 ? fallback : params[index]!);
    if (priv) {
      if (final === "h" && priv === "?" && params.some((value) => value === 1049 || value === 47 || value === 1047)) {
        this.grid = this.blank(this.rows, this.cols);
        this.row = this.col = 0;
      }
      if (final === "c" && priv === "=") return;
      return;
    }
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - p(0, 1));
        break;
      case "B":
      case "e":
        this.row = Math.min(this.rows - 1, this.row + p(0, 1));
        break;
      case "C":
      case "a":
        this.col = Math.min(this.cols - 1, this.col + p(0, 1));
        break;
      case "D":
        this.col = Math.max(0, this.col - p(0, 1));
        break;
      case "E":
        this.row = Math.min(this.rows - 1, this.row + p(0, 1));
        this.col = 0;
        break;
      case "F":
        this.row = Math.max(0, this.row - p(0, 1));
        this.col = 0;
        break;
      case "G":
      case "`":
        this.col = Math.min(this.cols - 1, p(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.row = Math.min(this.rows - 1, p(0, 1) - 1);
        this.col = Math.min(this.cols - 1, p(1, 1) - 1);
        break;
      case "d":
        this.row = Math.min(this.rows - 1, p(0, 1) - 1);
        break;
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 0) {
          this.clearLine(this.col, this.cols);
          for (let r = this.row + 1; r < this.rows; r += 1) this.grid[r]!.fill(" ");
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r += 1) this.grid[r]!.fill(" ");
          this.clearLine(0, this.col + 1);
        } else {
          this.grid = this.blank(this.rows, this.cols);
        }
        break;
      }
      case "K": {
        const mode = params[0] ?? 0;
        if (mode === 0) this.clearLine(this.col, this.cols);
        else if (mode === 1) this.clearLine(0, this.col + 1);
        else this.clearLine(0, this.cols);
        break;
      }
      case "X":
        this.clearLine(this.col, this.col + p(0, 1));
        break;
      case "P": {
        const n = Math.min(p(0, 1), this.cols - this.col);
        const line = this.grid[this.row]!;
        line.splice(this.col, n);
        line.push(...new Array<string>(n).fill(" "));
        break;
      }
      case "@": {
        const n = Math.min(p(0, 1), this.cols - this.col);
        const line = this.grid[this.row]!;
        line.splice(this.col, 0, ...new Array<string>(n).fill(" "));
        line.length = this.cols;
        break;
      }
      case "L":
        if (this.row >= this.top && this.row <= this.bottom) {
          for (let k = 0; k < p(0, 1); k += 1) {
            this.grid.splice(this.bottom, 1);
            this.grid.splice(this.row, 0, new Array<string>(this.cols).fill(" "));
          }
        }
        break;
      case "M":
        if (this.row >= this.top && this.row <= this.bottom) {
          for (let k = 0; k < p(0, 1); k += 1) {
            this.grid.splice(this.row, 1);
            this.grid.splice(this.bottom, 0, new Array<string>(this.cols).fill(" "));
          }
        }
        break;
      case "S":
        this.scrollUp(p(0, 1));
        break;
      case "T":
        this.scrollDown(p(0, 1));
        break;
      case "r":
        this.top = Math.max(0, p(0, 1) - 1);
        this.bottom = Math.min(this.rows - 1, (params[1] ? params[1] : this.rows) - 1);
        this.row = this.col = 0;
        break;
      case "s":
        [this.savedRow, this.savedCol] = [this.row, this.col];
        break;
      case "u":
        [this.row, this.col] = [this.savedRow, this.savedCol];
        break;
      case "n":
        if (params[0] === 6) replies.push(`\x1b[${this.row + 1};${this.col + 1}R`);
        else if (params[0] === 5) replies.push("\x1b[0n");
        break;
      case "c":
        if ((params[0] ?? 0) === 0) replies.push("\x1b[?62;c");
        break;
      default:
        break;
    }
  }

  private clearLine(from: number, to: number): void {
    const line = this.grid[this.row]!;
    for (let c = Math.max(0, from); c < Math.min(this.cols, to); c += 1) line[c] = " ";
  }

  /** As linhas da tela, sem os espaços do fim. */
  lines(): string[] {
    return this.grid.map((line) => line.join("").replace(/\s+$/, ""));
  }

  /** A tela inteira como texto (sem linhas vazias no fim). */
  text(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}
