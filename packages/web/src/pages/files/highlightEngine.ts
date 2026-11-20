import hljs from "highlight.js/lib/common";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";

// Este arquivo só é carregado sob demanda (por `highlight.ts`): o realçador e as linguagens ficam num pedaço à parte.
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("nginx", nginx);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("protobuf", protobuf);

export const engine = {
  /** O texto com as marcas de cor do realçador (já com `<`, `>` e `&` escapados), ou `null` se a linguagem não existe. */
  highlight(text: string, language: string): string | null {
    if (!hljs.getLanguage(language)) return null;
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  },
};
