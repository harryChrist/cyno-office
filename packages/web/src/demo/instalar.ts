// Instala o modo demonstração no navegador: um `fetch` e um `WebSocket` de mentira, antes de o app subir. As rotas de
// leitura saem do simulador (`DemoOffice`); qualquer escrita é recusada ("Demonstração: nada é gravado"); o socket do
// escritório recebe o retrato e, a cada 2 segundos, os mesmos eventos que o servidor mandaria. Os arquivos
// estáticos (JS, imagens da cena) passam direto: é só deles que o app precisa do servidor.
import { DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME, DemoOffice, type ServerEvent } from "@cyno/shared";
import { parametrosDaDemo, responderDaDemo } from "./modoDemo";

/** De quanto em quanto tempo o escritório de mentira anda (o mesmo passo do simulador). */
export const BATIMENTO_DA_DEMO_MS = 2_000;
export const MENSAGEM_DE_ESCRITA = "Demonstração: nada é gravado.";

declare global {
  interface Window {
    /** Só na demonstração: o simulador à mão (testes de tela). */
    __demo?: { sim: DemoOffice; agora(): number };
  }
}

const resposta = (status: number, corpo: unknown, texto?: string): Response =>
  new Response(texto ?? JSON.stringify(corpo), { status, headers: { "content-type": texto !== undefined ? "application/x-ndjson" : "application/json" } });

class SocketDeMentira {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((evento: Event) => void) | null = null;
  onmessage: ((evento: MessageEvent<string>) => void) | null = null;
  onerror: ((evento: Event) => void) | null = null;
  onclose: ((evento: CloseEvent) => void) | null = null;
  private relogio: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly url: string,
    private readonly sim: DemoOffice,
    private readonly agora: () => number,
  ) {
    setTimeout(() => this.abrir(), 0);
  }

  private enviar(evento: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(evento) } as MessageEvent<string>);
  }

  private abrir(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({ type: "open" } as Event);
    const caminho = new URL(this.url, "http://demo.local");
    if (caminho.pathname === "/ws") {
      this.enviar({ type: "workspaces:list", workspaces: [{ id: DEMO_WORKSPACE_ID, name: DEMO_WORKSPACE_NAME, createdAt: new Date(this.sim.start).toISOString() }] });
      if (caminho.searchParams.get("workspace") === DEMO_WORKSPACE_ID) {
        this.enviar(this.sim.snapshot());
        this.relogio = setInterval(() => {
          for (const evento of this.sim.tick(this.agora())) this.enviar(evento satisfies ServerEvent);
        }, BATIMENTO_DA_DEMO_MS);
      }
    } else if (caminho.pathname === "/api/cyno/ws") {
      this.enviar({ type: "cyno:snapshot", state: { status: "idle", choice: { engine: "gemini" }, everStarted: false, newConversation: false, idleMinutes: 10, updatedAt: new Date(this.sim.now).toISOString() }, entries: [] });
    }
  }

  send(): void {
    // Nada vai a lugar nenhum.
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.relogio) clearInterval(this.relogio);
    this.onclose?.({ type: "close" } as CloseEvent);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Um `Storage` só em memória: a demonstração lê e grava aqui, nunca no `localStorage` de verdade. */
export function armazenamentoEmMemoria(): Storage {
  const dados = new Map<string, string>();
  return {
    get length() {
      return dados.size;
    },
    clear: () => dados.clear(),
    getItem: (chave) => dados.get(String(chave)) ?? null,
    key: (indice) => [...dados.keys()][indice] ?? null,
    removeItem: (chave) => void dados.delete(String(chave)),
    setItem: (chave, valor) => void dados.set(String(chave), String(valor)),
  };
}

/** Troca `localStorage` e `sessionStorage` da janela por memória (nenhuma chave do navegador é criada ou alterada). */
function isolarArmazenamento(janela: Window): void {
  for (const nome of ["localStorage", "sessionStorage"] as const) {
    try {
      Object.defineProperty(janela, nome, { value: armazenamentoEmMemoria(), configurable: true, writable: true });
    } catch {
      // navegador que não deixa trocar: o app já guarda cada preferência dentro de try/catch
    }
  }
}

/** Liga a demonstração: cria o escritório de mentira e troca `fetch`, `WebSocket` e o armazenamento do navegador. Devolve o simulador. */
export function instalarDemo(search: string, janela: Window = window): DemoOffice {
  const inicio = Date.now();
  const parametros = parametrosDaDemo(search, inicio);
  const sim = new DemoOffice({ seed: parametros.seed, now: parametros.now });
  const agora = () => parametros.now + (Date.now() - inicio);
  const fetchDeVerdade = janela.fetch.bind(janela);
  isolarArmazenamento(janela);

  janela.fetch = async (entrada: RequestInfo | URL, opcoes?: RequestInit): Promise<Response> => {
    const url = new URL(typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url, janela.location.href);
    const daApi = url.origin === janela.location.origin && (url.pathname.startsWith("/api/") || url.pathname === "/__backend-health");
    if (!daApi) return fetchDeVerdade(entrada, opcoes);
    const metodo = (opcoes?.method ?? (entrada instanceof Request ? entrada.method : "GET")).toUpperCase();
    if (metodo !== "GET" && metodo !== "HEAD") return resposta(403, { error: MENSAGEM_DE_ESCRITA });
    const achado = responderDaDemo(sim, url.pathname, url.searchParams);
    if (!achado) return resposta(404, { error: "Isto não existe na demonstração." });
    return achado.texto !== undefined ? resposta(achado.status, null, achado.texto) : resposta(achado.status, achado.body);
  };

  const SocketFalso = class extends SocketDeMentira {
    constructor(url: string | URL) {
      super(String(url), sim, agora);
    }
  };
  (janela as unknown as { WebSocket: unknown }).WebSocket = SocketFalso;
  janela.__demo = { sim, agora };
  return sim;
}
