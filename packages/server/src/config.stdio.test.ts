import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("conectores stdio desligados por padrão", () => {
  it("a config só libera com CONNECTORS_STDIO=1", () => {
    expect(loadConfig({}).connectorsStdio).toBe(false);
    expect(loadConfig({ CONNECTORS_STDIO: "0" }).connectorsStdio).toBe(false);
    expect(loadConfig({ CONNECTORS_STDIO: "1" }).connectorsStdio).toBe(true);
  });
});
