# Runbook — Staging seguro

Este runbook é somente um desenho local. Criar ou alterar Railway exige autorização posterior.

## Serviços isolados

- web staging;
- worker staging;
- PostgreSQL staging;
- Redis staging;
- WhatsApp QR desativado ou mockado.

## Modos obrigatórios

- `GLOBAL_PAUSE=true`;
- `SALES_MODE=approval`;
- `PAYMENT_MODE=simulation`;
- `WHATSAPP_MODE=simulation`;
- `BITPANEL_MODE=disabled`;
- `RENEWAL_REQUIRES_APPROVAL=true`;
- IA desativada no primeiro boot.

Não copiar secrets live, sessão Baileys ou dados de cliente para o staging comum.

## Ordem de entrada

1. criar banco/Redis isolados;
2. executar migrations controladas;
3. executar seed explícito;
4. validar `migrate:verify`;
5. iniciar web e worker;
6. confirmar health e modos seguros;
7. executar smokes somente com dados sintéticos.

## Critérios de abortar

- outbound real;
- Mercado Pago live;
- acesso ao BitPanel;
- dado de produção exposto;
- migration no ambiente incorreto;
- job duplicado após restart.
