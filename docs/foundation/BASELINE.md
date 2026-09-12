# Fundação Segura — Baseline Local

Data: 22/08/2026
Branch: `phase1/foundation-security`
Base: `c9c97d5e9bc30249cd190357c9f4dd4004e0e097`

## Baseline canônico

- instalação: `npm ci` pelo `package-lock.json`;
- runtime: Node.js 22 ou superior compatível com o projeto;
- sintaxe: aprovada;
- testes antes das mudanças: 44/44 aprovados;
- worktree original: limpa;
- produção, Railway e banco remoto: não acessados.

## Escopo da fase

- CI de leitura;
- RBAC por capability;
- step-up para ações críticas;
- proteção de origem em mutações administrativas;
- migrations versionadas;
- startup read-only para schema;
- runbooks de staging, backup/restore e rollback.

O chatbot, os preços, o player e as regras de cobrança/renovação não fazem parte desta fase.
