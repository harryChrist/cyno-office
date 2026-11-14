import { useAgentLogStore } from "../store/agentLogStore";
import { useOfficeStore } from "../store/officeStore";
import { useTerminalsStore } from "../store/terminalsStore";
import { useViewStore } from "../store/viewStore";
import { useWorkStore } from "../store/workStore";

declare global {
  interface Window {
    /** Só em dev/test: acesso aos stores para testes e2e e depuração no console. */
    __agentOffice?: { office: typeof useOfficeStore; view: typeof useViewStore; terminals: typeof useTerminalsStore; work: typeof useWorkStore; log: typeof useAgentLogStore };
  }
}

/** Expõe os stores em `window.__agentOffice` (o build de produção não chama isto). */
export function exposeStoresForDev(): void {
  window.__agentOffice = { office: useOfficeStore, view: useViewStore, terminals: useTerminalsStore, work: useWorkStore, log: useAgentLogStore };
}
