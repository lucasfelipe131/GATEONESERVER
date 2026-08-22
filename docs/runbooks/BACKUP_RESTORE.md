# Runbook — Backup e restauração

Executar somente após autorização de staging/recuperação.

## Antes da mudança

1. registrar commit dos serviços;
2. criar backup/snapshot PostgreSQL;
3. registrar identificador e horário sem expor credenciais;
4. registrar estado agregado de filas e renewal jobs;
5. confirmar que integrações externas estão pausadas no destino.

## Restore isolado

1. restaurar em banco privado e sem domínio público;
2. bloquear Meta, Mercado Pago, BitPanel e WhatsApp;
3. comparar tabelas, constraints e contagens agregadas;
4. executar `npm run migrate:verify`;
5. iniciar aplicação somente em simulação;
6. medir duração e registrar resultado.

## Metas iniciais

- RPO: até 24 horas;
- RTO: até 4 horas.

Nenhum registro pessoal deve aparecer nas evidências do teste.
