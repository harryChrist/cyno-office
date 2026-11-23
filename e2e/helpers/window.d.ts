import type { OfficeState, Project, ServerEvent } from "@cyno/shared";

type Selection = { kind: "agent" | "room"; id: string } | null;
type Focus = { kind: "map" } | { kind: "room"; id: string };

declare global {
  interface Window {
    /** Exposto pelo web só em dev/test (packages/web/src/ui/devHooks.ts). */
    __agentOffice?: {
      office: { getState: () => { office: OfficeState | null } };
      view: { getState: () => { selection: Selection; focus: Focus; select: (s: Selection) => void; setFocus: (f: Focus) => void } };
      work: { getState: () => { rawProjects: Project[]; apply: (event: ServerEvent) => void } };
    };
  }
}

export {};
