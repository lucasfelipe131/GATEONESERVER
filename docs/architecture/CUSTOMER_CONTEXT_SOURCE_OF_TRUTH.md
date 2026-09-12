# GATE OS — Customer Context Source of Truth

Este mapa governa o `Customer360.v1`. Customer 360 é uma visão operacional
composta no momento da leitura; não é uma cópia indiscriminada dos domínios.

## Fontes de verdade

| Informação | Fonte atual | Fonte futura | Autoritativa? | Pode ser sobrescrita pela IA? |
|---|---|---|---|---|
| Identidade do cliente | `customers`, `customer_identities`, `customer_identity_links` | `customer_identities` com fallback legado explícito | Sim, após resolução determinística | Não |
| Telefone/WhatsApp | `customers.whatsapp_e164` | identidade `WHATSAPP`/`PHONE` verificada | Sim | Não |
| Nome | `customers.name` e `name_confirmed_at` | `customers` com provenance no contexto | Sim quando confirmado; caso contrário parcial | Não |
| Plano e valor | `subscriptions.plan_id` → `plans` | mesmos domínios | Sim | Não |
| Vencimento | `subscriptions.expires_on` | `subscriptions` | Sim | Não |
| Status do cliente | `customers.lifecycle_status`, fallback `customers.status` | lifecycle do GATE Core | Sim | Não |
| Status da assinatura | `subscriptions.status` | `subscriptions` | Sim | Não |
| Login operacional | `customers.bitpanel_reference` | identidade `LOGIN`/provider reference | Sim, mas não é exposto ao WhatsApp por padrão | Não |
| Cobrança | `charges` | `charges` | Sim | Não |
| Pagamento | `payments`, com `charges` como compatibilidade legada | `payments` | Sim | Não |
| Renovação | `renewal_jobs` | `renewal_jobs.core_status` | Sim | Não |
| Conversa atual | `conversation_sessions` | mesma tabela expandida com identidade de conversa | Sim para estado operacional | Não |
| Mensagens | `message_logs` e `ai_messages` | `message_logs` expandida; `ai_messages` continua histórico de IA | Sim como histórico bruto | Não |
| Atendimento | `customer_issues` | mesmo domínio | Sim | Não |
| Memória durável | implícita em mensagens/issues | `customer_memories` | Depende da origem e confiança | Somente pode propor fato LOW; nunca substituir HIGH silenciosamente |
| Snapshot de contexto | não existe | `customer_context_snapshots` | Registro imutável da decisão, não nova fonte operacional | Não |

## Regras

1. Dados financeiros, vencimento, status, renovação e provisioning sempre vêm
   dos domínios estruturados. Resumo, mensagem ou modelo de IA não prevalecem.
2. O Context Engine registra provenance por valor material, incluindo fonte,
   referência e instante observado.
3. O canal recebe apenas os scopes permitidos pela finalidade. Credenciais,
   secrets, senhas e payloads financeiros não entram no `Customer360.v1`.
4. Informação ausente permanece ausente e é registrada em `missing_fields`;
   nunca é inferida para completar o contrato.
5. A memória separa fato durável de histórico bruto. Conflitos mantêm as duas
   versões e aplicam confidence/supersession de forma auditável.
6. `ContextSnapshot` congela a seleção usada em uma decisão. Eventos futuros
   tornam snapshots anteriores históricos; não os reescrevem.

## Compatibilidade

- `customer_identities` é preferida; `customers.whatsapp_e164`, `email` e
  `bitpanel_reference` continuam como fallback legado durante a transição.
- `payments` é preferida; `charges` continua visível como cobrança legada.
- `conversation_sessions`, `message_logs` e `customer_issues` são evoluídas,
  evitando tabelas paralelas para conceitos já existentes.
- Rotas legadas do WhatsApp permanecem atrás do
  `COMPATIBILITY ADAPTER / TRANSITIONAL DEPENDENCY`.

## Compactação de conversa

```text
message_logs (histórico bruto)
  → janela recente limitada
  + conversation_sessions.summary
  → ContextSnapshot.v1
```

O `summary` é uma camada contextual compacta e poderá ser produzido por um job
futuro. Ele nunca substitui `subscriptions`, `payments`, `renewal_jobs`,
`customer_issues` ou fatos HIGH. O Context Engine limita a janela recente e o
número de memórias para impedir crescimento ilimitado do prompt.
