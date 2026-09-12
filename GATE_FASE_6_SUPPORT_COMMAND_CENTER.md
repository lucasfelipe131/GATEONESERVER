# GATE OS — FASE 6 — SUPPORT + EXCEPTION INBOX + COMMAND CENTER

Data: 2026-09-12 · desenvolvimento local somente.

## Decisão do gate

**PASSO 06 — BLOQUEADO**

A implementação local e os gates funcionais passaram. Na retomada VISUAL QA COMPLETION, o baseline foi reconfirmado em 255/255 no servidor, 45/45 no WhatsApp e 6/6 no E2E conjunto. O navegador autorizado bloqueou o acesso ao endereço local pela sua política de URLs (`net::ERR_BLOCKED_BY_CLIENT`). Os cinco viewports exigidos não puderam ser validados; o bloqueio detalhado e as evidências desta retomada estão na seção 29. Não é correto converter testes de DOM/CSS em aprovação visual.

Histórico da entrega anterior: o harness gerou cinco capturas desktop e terminou ao abrir o viewport seguinte com `browser.newPage: Target page, context or browser has been closed`. O log também contém `Could not create NETLINK socket: Operation not permitted`. Não se atribui causalidade definitiva apenas a esse log. Essas capturas intermediárias foram preservadas, não substituídas por evidência nova. Não foram produzidas capturas tablet/mobile.

Código entregue sem commit, push, PR, merge ou deploy. PASSO 07 não iniciado. Nenhum provider real utilizado.

## 1. Baseline

As duas working trees estavam limpas e na branch `main`. Baselines integrais executados antes da criação das branches locais.

| Repositório | Commit oficial confirmado | Tree oficial confirmada | Testes antes |
|---|---|---|---:|
| lucasfelipe131/GATEONESERVER | `836dfcf69ed8acc408224a72d927a662453e59f5` | `640f108caa8dabc8510cd3011a10d60e78a75c9e` | 205/205 |
| lucasfelipe131/gate-one-whatsapp | `a21d1a4bb588a2bcfd6dc1f8774d5ac4c9041284` | `f4b5e3b239c1d7ddb19f0819ad1b6aa9df45cd4e` | 39/39 |

Branch criada em ambos: `phase6/support-command-center`. HEAD permanece nos commits acima; as alterações estão apenas nas working trees, sem staging de arquivos. Esses hashes identificam o baseline, não um novo commit contendo o passo 06.

Runtime de validação: Node.js 24.19.0. CI oficial em Node 22 não foi disparado nesta etapa. Syntax anterior: PASS em ambos.

Evidências: [baseline servidor](sandbox:/workspace/scratch/574e50c7f2c3/phase6-server-before.tap), [baseline WhatsApp](sandbox:/workspace/scratch/574e50c7f2c3/phase6-whatsapp-before.tap).

## 2. Architecture

O pipeline permanece MESSAGE → IDENTITY → Customer360.v1 → CONTEXT → INTENT → GateConversationAgent → POLICY → TOOL → CORE → RESPONSE FACTS → VALIDATED RESPONSE.

SupportAgent é uma especialização injetada no GateConversationAgent existente, ao lado de RenewalAgent. Não há chatbot, Policy Engine, Customer 360, memória ou event bus paralelos.

Componentes novos: `src/core/support.js`; `src/services/support-agent.js`, `support-operations.js`, `support-repository.js`, `support-event-handlers.js`, `command-center.js`.

| Modelo | Persistência | Compatibilidade |
|---|---|---|
| SupportCase | `customer_issues.support_data` | Reutiliza ID/tabela existentes; mantém status legado open/monitoring/resolved |
| Exception | `support_exceptions` | FK composta caso/customer, dedup ativo por cliente/operação |
| Support Knowledge | `support_knowledge` | Estado governado; candidatos vinculados ao caso de origem |
| Probes sintéticos | `support_probes` | Estado de provider fake, sem transporte ou integração |
| Recibos idempotentes | `support_receipts` | Chave única por customer/operação |
| Incident Candidate | `support_incident_candidates` | Agrupamento temporal por problema, sem conteúdo de outros clientes |

Os modelos completos ficam em JSONB com índices operacionais. As transições e invariantes são aplicadas pelo serviço; não há uma coluna SQL obrigatória para cada campo conceitual.

## 3. SupportAgent

Consulta subscription, payment e renewal por tools existentes; usa Customer360 e suporte anterior. Prepara caso, seleciona conhecimento validado, executa ação allowlisted, verifica e registra resultado. Falhas na observação também geram handoff com o erro da tool, quando a persistência está disponível.

Não recebe banco, shell, filesystem, HTTP arbitrário, credenciais, adapter financeiro ou acesso administrativo. O único executor implementado é `REFRESH_SYNTHETIC_SESSION`, sobre probe explicitamente sintético.

Ativação falha fechada: exige `SUPPORT_AGENT_ENABLED=true`, `GATE_ENVIRONMENT=test` ou `local`, `PROVIDER_MODE=fake-only` e NODE_ENV diferente de production. Ausência dessas flags mantém o caminho anterior; staging-055 não ativa este agente.

## 4. Triage

Campos: category, severity, confidence, customer_impact, automation_eligibility, recommended_action; inclui problem_code e limite reduzido por insatisfação.

Catálogo enxuto: ACCOUNT_ACCESS, SUBSCRIPTION_STATUS, PAYMENT, RENEWAL, SERVICE_UNAVAILABLE, CONFIGURATION, DEVICE_HELP, HOW_TO, COMPLAINT, CANCELLATION, UNKNOWN. Nem todas as categorias possuem solução autônoma; ausência de solução leva a humano.

Severidades LOW/MEDIUM/HIGH/CRITICAL consideram indisponibilidade, tentativas, estado da assinatura, divergência financeira, segurança e incidente coletivo. Vencimento autoritativo passado bloqueia ação mesmo com rótulo ACTIVE desatualizado. Palavrão não torna um caso CRITICAL; reduz tentativas a uma.

## 5. Case model

`customer_issues.id` é o support_case_id. `support_data` mantém customer/conversation/category/severity/status/summary/diagnosis/resolution/confidence/automation_eligible/assigned_to/timestamps/correlation/context_snapshot/attempts/contadores/resultado de verificação.

Casos legados abertos podem ser incorporados no mesmo ID. Busca de caso ativo não depende apenas da janela dos últimos 100 casos. Histórico recente é limitado; um novo contato após resolução referencia `previous_case_id`.

Elegibilidade inicial é preservada para métricas. Contexto, confiança e permissão atual de execução são reavaliados a cada novo turno.

## 6. State machine

| Estado | Próximos estados permitidos |
|---|---|
| OPEN | TRIAGING, HUMAN_REQUIRED |
| TRIAGING | AUTOMATED_RESOLUTION, WAITING_CUSTOMER, WAITING_SYSTEM, HUMAN_REQUIRED |
| AUTOMATED_RESOLUTION | RESOLVED, WAITING_CUSTOMER, WAITING_SYSTEM, HUMAN_REQUIRED |
| WAITING_CUSTOMER / WAITING_SYSTEM | TRIAGING, HUMAN_REQUIRED, RESOLVED |
| HUMAN_REQUIRED | WAITING_CUSTOMER, RESOLVED por humano |
| RESOLVED | CLOSED |
| CLOSED | Nenhum |

RESOLVED exige verificação. HUMAN_REQUIRED exige também ator humano para resolver. O fluxo automático termina em RESOLVED verificado; não há tool genérica para forçar fechamento.

## 7. Knowledge

Registro inclui knowledge_id, category, problem_pattern, solution, validation_status, source, attempt/success/failure counts, success_rate, confidence e timestamps.

Estados: CANDIDATE, VALIDATED, DEPRECATED, REJECTED. Execução relevante só admite solução global VALIDATED, com confiança mínima 0,8, sem revisão pendente, padrão compatível e ação exata allowlisted.

Caso verificado cria CANDIDATE, nunca VALIDATED. Candidato contém código de problema/ação e referência do caso, não uma cópia de dados pessoais no catálogo global. A fixture local representa uma validação por curador de teste. Não foi criada interface completa de curadoria nem conhecimento real seedado.

Falhas reduzem confiança e podem sinalizar revisão. Attempt count, success count, failure count e taxa são atualizados idempotentemente na verificação do recibo.

## 8. Resolution loop

OBSERVE → UNDERSTAND → DIAGNOSE → SELECT ACTION → POLICY → EXECUTE → VERIFY → resolver, aguardar ou escalar.

Limites: 2 tentativas de resolução; 1 em caso de insatisfação; 12 chamadas por action turn no Registry; orçamento persistido de 16 chamadas do atendimento; 3 agent turns; no máximo uma repetição permitida pelo Registry para a mesma tool. Novas tools não fazem retry interno cego de escrita.

Um recibo EXECUTED não prova solução. VERIFY lê o estado do probe em outra transação. VERIFIED permite resolução; UNVERIFIABLE mantém WAITING_CUSTOMER. Falha/limite/política leva a HUMAN_REQUIRED. Replay de recibo não repete a ação. Contatos repetidos não zeram o orçamento do caso ativo.

Após 20 clientes distintos com problema semelhante em 15 minutos, surge INCIDENT CANDIDATE. O caso que detecta o agrupamento recebe referência de incidente, impacto coletivo e encaminhamento humano. Não há plataforma completa de incident management nem exposição de clientes entre si.

## 9. Exception Engine

Centralizado em SupportOperations, não apenas em tratamento de erros técnicos. Inclui política, baixa confiança, pedido humano, reclamação/cancelamento, divergência, segurança, falha repetida, observação indisponível e incidente.

Registro inclui IDs de cliente/conversa/caso/snapshot, domínio, motivo/tipo, severidade, prioridade, contexto, diagnóstico, tentativas, trilha de tools/policy/resultados, risco, recomendação, ação possível, status, ator e correlação.

Estados: OPEN, ACKNOWLEDGED, IN_PROGRESS, WAITING_CUSTOMER, RESOLVED, DISMISSED. Dedup ativo por customer + caso/problema. Prioridade considera severidade, dinheiro, segurança, repetição, churn e idade; não é FIFO simples. Claims concorrentes por humanos diferentes não sobrescrevem responsável.

## 10. Exception Inbox

Área de navegação e dashboard **PRECISA DE VOCÊ**. Por padrão exibe OPEN/ACKNOWLEDGED/IN_PROGRESS; itens aguardando cliente ou já encerrados não contam como ação humana pendente.

Lista mostra cliente, categoria, severidade, idade, resumo e recomendação. Detalhe mostra contexto de assinatura, payment/renewal, problema, diagnóstico, falha, tentativas, tools/policy, risco, correlação e ações possíveis.

Ações: assumir, aguardar cliente, resolver com evidência, dispensar com justificativa, abrir Customer 360 e conversa. Nenhum botão administrativo genérico. Resolver exige resultado VERIFIED e nota; dispensar não marca suporte como resolvido.

## 11. Command Center

Home evoluída funcionalmente: clientes, receita confirmada quando disponível, renovações, pagamentos pendentes, leads, conversas, atendimentos, resoluções automáticas, intervenções e falhas. Controles financeiros/catalogação anteriores foram preservados em área expansível.

**O QUE O GATE FEZ SOZINHO** apresenta ações operacionais auditáveis, ator, customer, resultado, timestamp e correlação curta. Não apresenta chain-of-thought.

Read models PostgreSQL agregam contagens/valores em SQL; dashboard não executa uma série de consultas por cliente. MRR permanece null quando não há fonte/modelo suficiente, sem valor fabricado. Fixture sem dados financeiros exibe “—”.

## 12. Autonomy metrics

| Métrica | Definição |
|---|---|
| Autonomous Resolution Rate | Casos elegíveis resolvidos com verificação, sem intervenção humana / todos os casos elegíveis |
| Human Handoff Rate | Casos encaminhados a humano / todos os casos |
| Exception Rate | Casos com exceção / todos os casos |
| Autonomous Renewal Rate | Decisões elegíveis de solicitação de renovação concluídas autonomamente / decisões elegíveis de solicitação de renovação |
| Tool Success Rate | Execuções de tools com sucesso / todas as execuções auditadas, incluindo falhas |
| First Response Time | Média de abertura até primeiro desfecho registrado pelo agente, em ms |
| Time to Resolution | Média de abertura até resolução verificada, em ms |
| Repeat Contact Rate | Casos vinculados a resolução anterior / todos os casos |

Elegível: solicitação identificada, sem pedido explícito de humano, cancelamento, reclamação, risco de segurança/divergência financeira ou assinatura vencida/bloqueada. Ausência de solução conhecida não remove o caso do denominador. Elegibilidade congela na abertura; falhas posteriores continuam contabilizadas. Denominador zero gera null, nunca 100%.

São métricas operacionais por caso/decisão, não alegações de receita real ou satisfação. Tempos usam registro do desfecho, não comprovante de entrega WhatsApp.

## 13. Customer 360 visual

Usa Customer360.v1 existente. Projeção SUPPORT ganhou recent_cases, diagnóstico, resolução, verificação e exceptions, com queries por customer e referências de origem. Memória continua no mecanismo existente.

Detalhe administrativo compõe projeções do serviço existente para finalidades CONVERSATION e PAYMENT; não cria outra base. Mostra identidade/lifecycle/plano/vencimento/payment/renewal/conversa/casos/exceptions/memória/atividade. Finalidade SUPPORT continua sem liberar indiscriminadamente scope financeiro: leituras operacionais passam pelas tools existentes.

Históricos são limitados, não ilimitados. Conversas de suporte usam a projeção mais recente por customer/conversation; a tela de conversas legada é preservada.

## 14. WhatsApp integration

Alteração pequena em `src/autonomous-operations.js`: valida case_status, verification_result e action_performed antes de aceitar afirmação de resolução/execução.

SupportAgent roda no Core existente, não no transporte. “Não está funcionando” não recebe menu comercial como primeira resposta. Pedido humano gera encaminhamento com contexto. “Paguei” continua sem confirmar pagamento e “quero renovar” continua dependente do Core; proteção financeira anterior permanece.

O E2E conjunto executou os módulos dos dois checkouts, com um cliente Core injetado em memória. Não abriu socket WhatsApp, sessão Baileys, HTTP de provider ou conversa com cliente real.

## 15. Policy Engine

ConversationPolicyEngine existente continua obrigatório. Allowlist por intent foi estendida apenas para suporte. SupportAgent não pode usar createPaymentRequest/requestRenewal como atalho de suporte nem ações HIGH.

Registry agora rejeita customer diferente no input e no output, incluindo Customer360 e coleções com customer_id. Operações reforçam novamente ownership do caso, exception, recibo e contexto; não dependem exclusivamente do prompt ou do Registry.

## 16. Tools e matriz de autonomia

| Operation | Automation Eligibility | Risk | Policy | Human Required | Verification |
|---|---|---|---|---|---|
| getSubscription/getPaymentStatus/getRenewalStatus | Cliente identificado, escopo correto | READ_ONLY | Allowlist existente | Se consulta falha e não há diagnóstico seguro | Estado oficial do Core |
| prepareSupportCase | Solicitação de suporte válida, sem injection | LOW_RISK_ACTION | Intent + customer + contexto | Não para registrar | Persistência transacional |
| getValidatedSolution | Caso do customer | READ_ONLY | Escopo do caso | Se não houver solução apta | VALIDATED, padrão, confiança, revisão |
| executeSupportAction | Caso elegível atual, confiança alta, orçamento e probe sintético | LOW_RISK_ACTION; Registry MEDIUM conservador | Policy + revalidação no Core | Se requisito falha | Recibo EXECUTED não resolve |
| verifySupportResult | Recibo e caso do mesmo customer | READ_ONLY do probe; registro interno auditado | Ownership + recibo | Se falha repetida | Leitura separada de estado sintético |
| recordResolutionResult | Recibo verificado ou não verificável | LOW_RISK_ACTION | Transição explícita | Se HUMAN_REQUIRED | VERIFIED ou WAITING_CUSTOMER |
| escalateSupportCase | Risco, incerteza, limite ou pedido humano | LOW_RISK_ACTION de registro | Allowlist + customer | Sim para desfecho | Exception persistida antes da resposta |
| Assumir / aguardar | Admin autorizado | MEDIUM_RISK_ACTION | exceptions.manage + origem confiável | Sim | Estado persistido e audit |
| Resolver / dispensar | Admin autorizado | HUMAN_REQUIRED | exceptions.manage + step-up | Sim | Nota; VERIFIED para resolver |
| Pagamento/renovação crítica | Fora do SupportAgent | HUMAN_REQUIRED | Mantém Core/Billing/Renewal | Conforme política já existente | Nenhuma execução real nesta fase |

Não foram adicionadas tools de SQL, shell, filesystem, HTTP arbitrário ou administração genérica.

## 17. RBAC e step-up

Capabilities no padrão real com ponto: command-center.read, support.read, support.manage, exceptions.read, exceptions.manage. Admin recebe capacidades; operator recebe novas leituras, não mutations de exceptions.

Rotas usam o `protect` existente. Leituras não exigem step-up. Resolver/dispensar exigem capability específica, origem confiável e step-up vinculado à capability. Corpo de mutation tem schema estrito, ação allowlisted e ator obtido da sessão, não do payload.

Testes HTTP utilizam identidade sintética apenas no harness; runtime usa requireAuth/requireCapability existentes. Nenhuma branch protection ou required check remoto foi alterado.

## 18. Migration 0006

[0006_support_exception_command_center.sql](sandbox:/workspace/scratch/574e50c7f2c3/baseline-server/database/migrations/0006_support_exception_command_center.sql)

EXPAND-ONLY: coluna nullable em customer_issues; cinco novas tabelas; índices e constraints compatíveis. Sem DROP, TRUNCATE, rename, DML/seed real ou transformação obrigatória de dados. Migrations 0000–0005 não foram editadas.

SHA-256: `ae7261ce6b7a3d093187091b6a338b083435e6c11d8278c270de18b33b606174`.

Aplicação validada somente em PostgreSQL embarcado PGlite descartável, sem DATABASE_URL. O migrator existente aplicou 0000–0006, verificou history/checksums e repetiu com zero pendências. Nenhuma execução remota, em produção ou staging.

## 19. Outbox e crash safety

Reutiliza gate_event_outbox, NotificationRequested e dispatcher existentes. Eventos support.case_opened, support.triaged, support.resolution_attempted, support.verification_recorded, support.waiting_customer, support.human_required, support.case_resolved, support.incident_candidate e exception.* estão no catálogo contratual.

Caso, recibo/efeito fake, audit e eventos relevantes compartilham transação. Consumers observacionais novos reutilizam os marcadores crash-safe e a identidade estável `gate-core.v1:<event_type>`; worker ID permanece identidade de lease, não de efeito.

NotificationRequested usa IN_APP/PENDING nesta fase. O teste simula entrega atualizando a tabela, sem transporte. Guards, default conservador e shutdown do dispatcher existente não foram removidos.

Teste PostgreSQL injeta falha depois do efeito de notificação e antes do ACK; outro worker faz replay sem repetir efeito. Isso é failpoint local, não um novo ensaio de SIGKILL em produção. A suíte legada de outbox/crash, incluindo subprocessos locais, permanece verde.

## 20. Audit

Usa audit_logs existente. Registra actor, action, resource, before/after quando aplicável, reason, timestamp e correlation. Resolução humana inclui action/result/note/actor/time/correlation e atualiza caso, exception e contexto futuro. A conversation persistida é atualizada somente com customer_id e conversation_id correspondentes.

Feed administrativo usa audit/read models, não raciocínio interno. Dismiss exige justificativa e não inventa resolução.

## 21. Observability

Metadados estruturados incluem support_case_id, exception_id, customer_id, conversation_id, agent, intent, category, severity, result e correlation_id. Registry registra tool/policy/status/result/error_code. Summary e notas têm limite e redaction de padrões sensíveis.

Logs emitidos dentro da transação são identificados como PENDING_COMMIT; a fonte auditável do feed é o registro transacional efetivamente persistido. Não se trata um log pré-commit como prova de conclusão.

## 22. E2E

| Cenário local | Evidência | Resultado |
|---|---|---|
| Falha simples elegível | Fake action → leitura independente → SupportCase RESOLVED → fatos validados | PASS |
| Problema desconhecido/baixa confiança | Case HUMAN_REQUIRED + exception completa | PASS |
| Resolução humana | Exception/case atualizados + audit + futuro Customer360 | PASS |
| Retorno após resolução | previous_case_id e resultado anterior disponíveis | PASS |
| Dois customers simultâneos | Casos/exceptions/recibos/contextos separados | PASS |
| Prompt injection | Sem criação ou fechamento indevido | PASS |
| Pedido humano | Sem insistência em ação autônoma | PASS |
| Ação não verificável | WAITING_CUSTOMER, sem claim de resolução | PASS |
| Recibo em replay | Ação não repetida; resolução/evento idempotentes | PASS |
| Falha de consulta da subscription | Exception com tool FAILED e motivo | PASS |
| 20 clientes em 15 minutos | Incident candidate correlacionado | PASS |
| Módulos dos dois repositórios | 6 cenários conjuntos, transporte fake injetado | PASS |

## 23. UI

Testes de DOM cobrem carga/renderização dos dados, denominadores, vazio, erro isolado, filtros, detalhe completo, ausência de botões para readonly, Customer360/conversas e escape de conteúdo.

Capturas intermediárias reais do harness sintético desktop:

- [Command Center](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/command-center-desktop.png)
- [Exception Inbox](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/exception-inbox-desktop.png)
- [Exception detail](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/exception-detail-desktop.png)
- [Customer 360](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/customer360-desktop.png)
- [Conversas](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/conversations-desktop.png)

As imagens não são de produção. Campos “—”/“Não disponível” representam ausência de dados na fixture, não consulta a clientes reais. A seção adicional de trilha de tools/policy no detalhe foi acrescentada depois dessas capturas e validada por DOM, sem nova captura final.

## 24. Mobile e bloqueio visual

CSS inclui layouts até 1100px e 600px, grid responsivo, modais com scroll, controles com altura adequada, wrap de IDs/textos e filtros adaptáveis. Isso não substitui teste em navegador.

Harness preparado para 1440×1000, 820×1180 e 390×844. O trecho desktop gerou as cinco telas; o processo terminou na abertura do viewport seguinte. Tablet/mobile e a revisão visual final pós-ajustes não foram comprovados. Não se declara iPhone/Safari aprovado.

Pendência bloqueante: executar `npm run test:ui` em runtime local autorizado com navegador funcional, revisar desktop/tablet/mobile e confirmar acesso às ações críticas dos modais. Não exige conectar staging, produção ou providers.

## 25. Tests e reprodução

| Gate | Resultado final | Evidência |
|---|---:|---|
| Servidor integral | 255/255, +50 | [TAP servidor](sandbox:/workspace/scratch/574e50c7f2c3/phase6-server-final.tap) |
| WhatsApp integral | 45/45, +6 | [TAP WhatsApp](sandbox:/workspace/scratch/574e50c7f2c3/phase6-whatsapp-final.tap) |
| Security legado | 22/22 | [TAP](sandbox:/workspace/scratch/574e50c7f2c3/phase6-security.tap) |
| Migration + PostgreSQL fase 6 | 14/14 | [TAP](sandbox:/workspace/scratch/574e50c7f2c3/phase6-migration.tap) |
| Agent / Fact Safety legado | 49/49 | [TAP](sandbox:/workspace/scratch/574e50c7f2c3/phase6-fact-safety.tap) |
| Grupo Customer / isolamento legado | 26/26 | [TAP](sandbox:/workspace/scratch/574e50c7f2c3/phase6-cross-customer.tap) |
| Outbox / crash legado | 28/28 | [TAP](sandbox:/workspace/scratch/574e50c7f2c3/phase6-outbox-crash.tap) |
| Novo conjunto fase 6 servidor | 50/50, contido no integral | support, PostgreSQL, endpoints e DOM |
| E2E conjunto dos repositórios | 6/6 | script support-cross-repo-e2e.js |
| Syntax | PASS ambos + 10 arquivos novos | npm run check; npm run check:phase6 |
| Diff | PASS | git diff --check; reverse --check dos patches, sem aplicar alterações |
| Visual tablet/mobile | PENDENTE | Harness não completou; gate bloqueado |

Zero falhas, skips e cancellations nas suítes TAP finais. Grupos se sobrepõem: não somar contagens. O grupo de 26 contém testes de Customer/contexto além de adversariais; não são 26 ataques exclusivos.

Dev dependencies novas: PGlite 0.5.8 e jsdom 30.0.1, com lockfile. Nenhuma infraestrutura produtiva adicionada. Uma tentativa de browser empacotado foi removida das dependências finais após a falha do harness; não foi deixado mecanismo de contorno de permissões.

Reprodução nos checkouts locais, com dependências instaladas:

```bash
env -i PATH="$PATH" NODE_ENV=test TZ=UTC npm test
env -i PATH="$PATH" NODE_ENV=test npm run check
env -i PATH="$PATH" NODE_ENV=test npm run check:phase6
env -i PATH="$PATH" NODE_ENV=test GATE_WHATSAPP_CHECKOUT=/workspace/scratch/574e50c7f2c3/baseline-whatsapp node scripts/support-cross-repo-e2e.js
```

Executar npm test/check também no checkout WhatsApp. O script de navegador serve HTML e APIs sintéticas apenas em 127.0.0.1 e fecha o servidor ao terminar. Ele não importa o servidor produtivo.

## 26. Risks

- QA visual tablet/mobile e captura final são bloqueantes para o aceite integral.
- PGlite verifica SQL PostgreSQL real embarcado; não substitui ensaio futuro autorizado em PostgreSQL servidor com carga/multi-processo. Staging não foi usado.
- Lock transacional global de suporte é conservador e serializa escritas; medir contenção antes de eventual ampliação de autonomia.
- Conhecimento validado e probes desta evidência são exclusivamente sintéticos; nenhum diagnóstico real de BitPanel/device/provider foi implementado ou validado.
- A home usa métricas por caso/decisão e valores disponíveis; MRR e métricas sem base suficiente permanecem null.
- O gate não testa entrega externa de NotificationRequested nem notificação WhatsApp real.
- Persistência indisponível pode impedir a criação de exception; não há fallback que afirme encaminhamento sem confirmação do registro.

## 27. Reservations, matriz de exceções e aceite

| Exception Type | Severity | Trigger | Suggested Action | Can Agent Resolve? | Human Required? |
|---|---|---|---|---|---|
| LOW_CONFIDENCE | LOW–HIGH conforme impacto | Diagnóstico insuficiente | Revisar contexto e investigar | Não neste estado | Sim |
| NO_VALIDATED_SOLUTION | Conforme impacto | Catálogo sem solução apta | Diagnosticar e propor candidato | Não | Sim |
| HUMAN_REQUEST | Conforme impacto | Cliente pede pessoa | Assumir preservando contexto | Não deve insistir | Sim |
| COMPLAINT | Geralmente LOW/MEDIUM; sobe por impacto | Reclamação sensível | Atendimento humano | Não automaticamente | Sim |
| CANCELLATION_REQUEST | Conforme risco | Cancelamento | Revisar decisão no Core | Não | Sim |
| FINANCIAL_DIVERGENCE | HIGH | Estados financeiros divergentes | Revisão financeira autorizada | Não | Sim |
| SECURITY_REVIEW | CRITICAL | Sinal de fraude/invasão | Revisão de segurança | Não | Sim |
| REPEATED_FAILURE / LOOP_LIMIT | MEDIUM/HIGH | Limites ou falhas | Rever tentativas e próxima ação | Não após limite | Sim |
| SUBSCRIPTION_NOT_FOUND / observação indisponível | Conforme contexto | Tool de leitura falha | Corrigir diagnóstico/identidade/estado | Não sem fonte segura | Sim |
| INCIDENT_REVIEW | HIGH ou superior | ≥20 clientes/15 min | Investigar problema comum | Não independentemente | Sim |
| UNVERIFIABLE | Conforme contexto | Ação sem resultado comprovável | Solicitar confirmação | Não marcar RESOLVED | Cliente primeiro; humano conforme evolução |

| Critério de aceite | Situação |
|---|---|
| SupportAgent, triage, state machine, verify e limites | PASS local |
| Knowledge governado/candidate, dedup e incidente | PASS local |
| Exception Engine, inbox e contexto de handoff | PASS local |
| Command Center, métricas, Customer360 e conversas | PASS funcional/DOM |
| Policy, RBAC, step-up, fact safety e isolamento | PASS local |
| Outbox crash-safe e E2Es automático/humano | PASS local |
| Nenhum provider real | Confirmado para esta execução |
| Desktop visual | Evidência parcial/intermediária |
| Tablet/mobile e revisão visual final | PENDENTE — bloqueante |

Produção, auto-deploy OFF e staging 055 são estado de entrada fornecido e preservado quanto às ações desta execução. Não houve acesso Railway nesta fase, portanto não se apresenta uma nova leitura do estado externo. Nenhum deploy, migration remota, provider, push, alteração de proteção ou exclusão de branch foi feito.

Não se iniciou Sales/Growth, campanhas ou próxima fase. A próxima decisão permanece humana.

## 28. Diff e entrega

| Repositório | Diff completo, incluindo arquivos novos | Escopo |
|---|---|---|
| GATEONESERVER | [phase6-server.patch](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/phase6-server.patch) | 33 arquivos; 4.573 inserções, 24 remoções |
| WhatsApp | [phase6-whatsapp.patch](sandbox:/workspace/scratch/574e50c7f2c3/phase6-evidence/phase6-whatsapp.patch) | 2 arquivos; 19 inserções |

Os patches contêm código, migration, testes, scripts e dependências; este relatório é entregue separadamente. Foram conferidos contra as working trees com `git apply --reverse --check`, sem aplicação/reversão real. Não aplicar novamente sobre as mesmas working trees já modificadas.

SHA-256 servidor: `463da1e178ab5014844a1ff496606afe7311c52b7bac62454557dab073275a90`.

SHA-256 WhatsApp: `aad8c1d1baa1452682183a0c5be7452b0830d8f98349764b1fd05057dc4f13bd`.

PARADA: implementação e evidências locais entregues. Aceite integral bloqueado por QA visual pendente. Sem publicação; aguardar revisão humana.

## 29. VISUAL QA COMPLETION

Retomada em 2026-09-12, exclusivamente local. **PASSO 06 — BLOQUEADO** por impedimento do ambiente de navegador, não por um novo defeito de interface demonstrado.

### Preservação antes de alterações

Ambos os repositórios continuam em `phase6/support-command-center`, nos HEADs e trees oficiais da seção 1, com as alterações locais da implementação intactas. As working trees estão intencionalmente modificadas; não foram limpas, descartadas, adicionadas ao staging ou commitadas.

| Registro inicial | Evidência |
|---|---|
| Branch, HEAD, tree, git status, diff tracked e hashes de todos os arquivos versionáveis do servidor | [server-before.json](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/server-before.json) |
| Mesmo registro do WhatsApp | [whatsapp-before.json](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/whatsapp-before.json) |
| Diff completo servidor, incluindo código novo | [server-before.patch](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/server-before.patch) |
| Diff completo WhatsApp, incluindo código novo | [whatsapp-before.patch](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/whatsapp-before.patch) |
| Migration 0006 preservada | [0006-before.sql](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/0006-before.sql) |
| Relatório anterior integral | [report-before.md](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/report-before.md) |

Os patches de código foram conferidos com `git apply --reverse --check`, sem aplicação real. Seus SHA-256 permanecem os da seção 28. O relatório, não incluído nos patches de código, foi preservado separadamente antes desta atualização. Migration 0006 mantém SHA-256 `ae7261ce6b7a3d093187091b6a338b083435e6c11d8278c270de18b33b606174`.

### Ambiente e bloqueio

Testes executados com ambiente limpo (`env -i`), Node.js 24.19.0, NODE_ENV=test, fixtures e clientes sintéticos. Sem credenciais, DATABASE_URL, Redis ou providers reais.

O navegador Chrome autorizado foi conectado conforme a skill `control-browser`. Um servidor de diagnóstico foi iniciado exclusivamente em `127.0.0.1:4316`, servindo apenas uma mensagem HTML sintética, antes de iniciar a aplicação. A navegação retornou `net::ERR_BLOCKED_BY_CLIENT`. A tentativa de inspecionar a página de erro e capturar a evidência também foi recusada, com confirmação explícita de bloqueio pela política de URLs do navegador. Não se confunde esse erro com falha do GATE, autenticação ou bot detection.

A skill `control-browser` e a política retornada proíbem contornar o bloqueio por outro navegador, comandos diretos, execução indireta ou mudança de caminho de rede. Não houve tentativa de contorno. O processo local de diagnóstico foi encerrado.

Evidência textual: [browser-block.txt](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/browser-block.txt).

### Viewports e telas

| Perfil obrigatório | Viewport | Resultado desta retomada |
|---|---|---|
| Desktop | 1440 × 900 | NÃO EXECUTADO — acesso local bloqueado |
| Tablet | 1024 × 768 | NÃO EXECUTADO — acesso local bloqueado |
| Tablet vertical | 768 × 1024 | NÃO EXECUTADO — acesso local bloqueado |
| Mobile | 390 × 844 | NÃO EXECUTADO — acesso local bloqueado |
| Mobile grande | 430 × 932 | NÃO EXECUTADO — acesso local bloqueado |

Nenhuma tela da aplicação foi aberta nesta retomada. Permanecem pendentes Command Center, Precisa de Você/Exception Inbox, Exception Detail, Support Cases, Customer 360, Conversations, Activity Feed, métricas, estados vazios e de erro nos viewports acima. Navegação, toque, overflow, badges, tabelas e modais não receberam nova aprovação visual.

### Problemas, correções e screenshots

- Problema encontrado: a política do navegador impede alcançar o ambiente local. Componente afetado: infraestrutura de QA, antes da interface. Impacto: impossibilidade de executar o gate visual em qualquer viewport obrigatório.
- Defeitos visuais novos: nenhum demonstrado, pois a aplicação não foi renderizada.
- Correções visuais: nenhuma aplicada. CSS, HTML, JavaScript, scripts, regras de negócio, contracts, autenticação, RBAC e migrations foram preservados.
- Screenshots finais novas: nenhuma. A própria captura da página de erro foi bloqueada; não há screenshot nova para anexar.
- As cinco capturas desktop intermediárias da seção 23 continuam disponíveis, mas não satisfazem o gate atual nem substituem as dez evidências finais exigidas.
- Correção necessária para prosseguir: disponibilizar um ambiente de QA cujo navegador autorizado possa alcançar a aplicação local/isolada e ofereça os cinco viewports, sem contornar a política atual nem expor o ambiente publicamente.

### Baseline automatizado e regressão

| Gate repetido nesta retomada | Resultado | Evidência |
|---|---:|---|
| GATEONESERVER integral | 255/255 PASS | [server-baseline.tap](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/server-baseline.tap) |
| WhatsApp integral | 45/45 PASS | [whatsapp-baseline.tap](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/whatsapp-baseline.tap) |
| E2E conjunto | 6/6 PASS | [joint-e2e-baseline.txt](sandbox:/workspace/scratch/574e50c7f2c3/visual-qa-evidence/joint-e2e-baseline.txt) |

Suítes integrais sem falhas, skips ou cancellations. Security, Migration, Fact Safety, Cross-Customer e Outbox/Crash continuam cobertos pelos testes integrais verdes; os subconjuntos da seção 25 não foram executados novamente de forma isolada nesta retomada. Nenhum código foi corrigido, portanto não há uma execução pós-correção distinta nem novos testes de regressão visual.

### Resultado e ressalvas

| Critério | Resultado |
|---|---|
| DESKTOP | NÃO VALIDADO |
| TABLET | NÃO VALIDADO |
| MOBILE | NÃO VALIDADO |
| AUTOMATED TESTS | PASS |
| VISUAL QA | BLOQUEADO |
| PASSO 06 | BLOQUEADO |
| PRODUCTION | UNCHANGED quanto às ações desta execução; nenhuma consulta externa realizada |

Diff desta retomada nos repositórios: somente este relatório atualizado. Evidências adicionais foram salvas localmente fora dos repositórios. Nenhuma implementação reconstruída e nenhum defeito de negócio novo identificado. Nenhum commit, push, PR, merge, deploy, migration remota, acesso Railway, provider real ou alteração de auto-deploy. Staging 055 e branches anteriores não foram alterados.

PARADA: aguardar direção humana para um ambiente de navegador compatível. Não publicar o PASSO 06, não iniciar o PASSO 07 e não declarar aprovação visual sem evidência.
