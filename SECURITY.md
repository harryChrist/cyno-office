# Política de segurança

## Como relatar uma vulnerabilidade

**Não abra uma issue pública com detalhes.** Use o relato privado do GitHub:

1. Abra a aba **Security** do repositório.
2. Clique em **Report a vulnerability** (Security > Advisories).
3. Descreva o problema, os passos para reproduzir e o impacto.

Respondemos assim que possível, e combinamos a correção e a divulgação com você. Se a opção não aparecer, abra uma issue pública pedindo um contato privado, sem nenhum detalhe técnico.

## O que está no escopo

O Cyno roda agentes de IA como terminais na máquina de quem o instala e os expõe por um app web, então o que importa é quem consegue chegar a eles:

- Autenticação: senha (scrypt), sessão por cookie, bloqueio por IP com escalada, primeiro acesso por código e verificação em duas etapas (TOTP).
- Acesso indevido aos terminais dos agentes, aos arquivos dos workspaces ou ao navegador dos agentes; fuga do isolamento entre workspaces.
- O servidor MCP, que deve escutar **somente em loopback**: qualquer forma de alcançá-lo de fora da máquina é uma falha.
- Vazamento de segredos (senha, tokens de MCP, sessões) em logs, respostas ou arquivos.
- Execução de código ou leitura de arquivos pelo servidor via entrada não confiável.

Fora do escopo: ataques que exigem acesso prévio à máquina ou à conta já autenticada de quem instalou, e rodar com `CYNO_AUTH=off` (opção só para desenvolvimento e testes).

Versões suportadas: a mais recente do `main`.
