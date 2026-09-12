# Runbook — Rollback da Fundação

## Aplicação

1. pausar automações;
2. voltar ao artefato/commit aprovado anterior;
3. verificar health do web e worker;
4. confirmar que não houve duplicação de job;
5. executar smokes de login, leitura e filas.

## Banco

As migrations desta fase são aditivas. O rollback preferencial é voltar o código e manter estruturas novas inertes.

- não executar `DROP` automático;
- usar migration corretiva forward;
- restaurar backup apenas diante de perda/corrupção e autorização específica;
- o commit anterior deve tolerar a coluna aditiva `sessions.step_up_until`.

## Lockout administrativo

Não desabilitar RBAC de forma permanente. Usar break-glass temporário, auditado e revogado depois da correção.
