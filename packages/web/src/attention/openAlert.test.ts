import { beforeEach, describe, expect, it } from "vitest";
import { frameAgentOnMap } from "./openAlert";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";

const office = { rooms: [], teams: [{ id: "t1", roomId: "sala-1", name: "T", focus: "" }], agents: [{ id: "ana", teamId: "t1" }], tasks: [] };

describe("frameAgentOnMap", () => {
  beforeEach(() => {
    useOfficeStore.setState({ office: office as never });
    useViewStore.setState({ selection: null, showAgentRequest: null });
  });

  it("com o Escritório aberto seleciona o agente e pede o enquadramento na sala dele", () => {
    useNavStore.setState({ page: "office" });
    frameAgentOnMap("ana");
    expect(useViewStore.getState().selection).toEqual({ kind: "agent", id: "ana" });
    expect(useViewStore.getState().showAgentRequest).toMatchObject({ id: "ana", fallback: "sala-1" });
  });

  it("fora do Escritório não mexe no mapa", () => {
    useNavStore.setState({ page: "trabalho" });
    frameAgentOnMap("ana");
    expect(useViewStore.getState().selection).toBeNull();
    expect(useViewStore.getState().showAgentRequest).toBeNull();
  });
});
