/** Notas iniciais dos Cérebros: { idDoCérebro: { arquivo.md: conteúdo } }. */
export const SEED_BRAIN_NOTES: Record<string, Record<string, string>> = {
  global: {
    "preferencias.md": `# Preferências do usuário

- Escreve em português do Brasil e espera respostas em português do Brasil.
- Prefere respostas diretas: primeiro a resposta, depois os detalhes, sem rodeios.
- Usa TypeScript no dia a dia; exemplos de código devem ser em TypeScript.
- Gosta de listas curtas e de saber os próximos passos no final.
`,
    "aprendizados.md": `# Aprendizados

Registro do que funcionou (ou não) nas tarefas dos agentes.

- Tarefas com objetivo claro e critério de pronto saem melhores.
- Quando faltar contexto, é melhor perguntar do que supor.
`,
  },
  projetox: {
    "visao-geral.md": `# ProjetoX — visão geral

App web para uma rede de cafeterias acompanhar pedidos em tempo real.

- Público: atendentes no balcão e gerentes das lojas.
- Objetivo do trimestre: reduzir o tempo médio de preparo exibindo a fila de pedidos por estação.
- Prioridade: funcionar bem em tablets.
`,
    "decisoes-tecnicas.md": `# ProjetoX — decisões técnicas

- Front-end em React com TypeScript; componentes pequenos e testados.
- API REST em Node.js; toda entrada validada com schemas.
- Banco de dados relacional; pedidos guardam o histórico de status.
- Atualizações em tempo real via WebSocket.
`,
  },
  projetoy: {
    "briefing.md": `# ProjetoY — briefing

Série de artigos sobre hábitos de leitura no Brasil.

- Formato: cinco artigos de até 1.200 palavras.
- Tom: acessível, com dados e histórias reais.
- Entregas quinzenais, com revisão antes de cada publicação.
`,
    "confidencial.md": `# Confidencial — não compartilhar fora do ProjetoY

- Cliente (codinome): **Aurora Editorial**.
- Orçamento aprovado: R$ 48.000 para a série completa.
- Palavra-chave interna da campanha: **GIRASSOL-AZUL-42**.
- O lançamento só pode ser comentado depois do anúncio oficial do cliente.
`,
  },
};
