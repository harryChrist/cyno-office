import { describe, expect, it } from "vitest";
import { splitLinks } from "./linkifyParts";

const links = (text: string) => splitLinks(text).filter((part) => part.kind === "link").map((part) => part.text);

describe("splitLinks", () => {
  it("acha a URL no meio do texto e mantém o resto", () => {
    expect(splitLinks("Post de Hugo (09/11) – https://www.linkedin.com/in/hgsouza/recent-activity/all/ fim")).toEqual([
      { kind: "text", text: "Post de Hugo (09/11) – " },
      { kind: "link", text: "https://www.linkedin.com/in/hgsouza/recent-activity/all/", href: "https://www.linkedin.com/in/hgsouza/recent-activity/all/" },
      { kind: "text", text: " fim" },
    ]);
  });

  it("tira a pontuação da frase e o parêntese sem par do fim", () => {
    expect(links("veja https://x.com/a.")).toEqual(["https://x.com/a"]);
    expect(links("(link: https://x.com/feed/update/urn:li:activity:1/)")).toEqual(["https://x.com/feed/update/urn:li:activity:1/"]);
    expect(links("https://pt.wikipedia.org/wiki/Duna_(livro), legal")).toEqual(["https://pt.wikipedia.org/wiki/Duna_(livro)"]);
  });

  it("várias URLs, e texto sem URL fica inteiro", () => {
    expect(links("a https://a.com b http://b.com.br/x?y=1")).toEqual(["https://a.com", "http://b.com.br/x?y=1"]);
    expect(splitLinks("sem link aqui")).toEqual([{ kind: "text", text: "sem link aqui" }]);
    expect(splitLinks("")).toEqual([{ kind: "text", text: "" }]);
  });

  it("ignora o que não é endereço web (javascript:, sem domínio)", () => {
    expect(links("javascript:alert(1) e https:// e http://x")).toEqual([]);
  });
});
