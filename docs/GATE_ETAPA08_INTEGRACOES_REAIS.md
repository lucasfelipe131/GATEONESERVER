# Etapa 08 — cobranças e chatbot no projeto único

A linha moderna usa o mesmo projeto GATE ECOSSISTEM. Staging mantém seus provedores simulados e rejeita a configuração real. Produção admite a nova cobrança apenas com `GATE_LIVE_BILLING_ENABLED=true`, `NODE_ENV=production`, `GATE_TEST_MODE=false`, `PROVIDER_MODE=live` e os IDs exatos do projeto e ambiente principal. `BILLING_AUTOMATION_ENABLED` permanece reservado à simulação.

Uma assinatura e um ciclo compartilham uma cobrança, um pagamento pendente e um link entre conversa e lembretes D-3, D0, D+2 e D+5. A reserva é confirmada no banco antes de solicitar Checkout Pro. Preferência não representa pagamento: o identificador financeiro fica vazio até a leitura oficial do pagamento. Resposta perdida é recuperada pela referência e validada por valor, moeda e recebedor; nenhum novo pedido cego é enviado ao Mercado Pago. Cobrança em andamento ou recuperação ambígua fica para nova consulta ou revisão.

O webhook confere a assinatura e consulta o pagamento no provedor. Confirmação exige ID correspondente, modo real, valor exato em centavos, BRL, referência da cobrança e recebedor correspondente à conta autenticada. Uma falha conserva o recibo pendente e responde para o provedor tentar novamente. A confirmação atualiza o pagamento já reservado, a cobrança e a renovação com eventos na mesma transação.

As notificações saem da outbox para uma fila persistente com ID fixo. No envio são novamente verificados opt-out, consentimento para lembretes, elegibilidade e pagamento/validade. O chatbot registra a reserva de entrega no seu volume antes de enviar. Repetição após sucesso devolve o mesmo identificador; resultado incerto exige revisão. Não há troca de canal após um envio incerto.

A renovação requer confirmação financeira, aprovação quando configurada, reserva exclusiva de execução e validade esperada conferida no BitPanel. Pedidos concorrentes e falhas depois da tentativa externa não renovam novamente. Recuperação automática não reapresenta operações em revisão.

Validação: testes com PostgreSQL embarcado e provedores sintéticos, testes de persistência do WhatsApp e restauração privada do banco principal. A restauração isolada passou nas oito migrações preservando os registros originais. Nenhuma validação dispara mensagens ou pagamentos reais para clientes.

Antes de liberar renovação real, verificar a autenticação dos provedores e atualizar a sessão do BitPanel quando necessário. A aprovação e os modos operacionais do painel continuam sendo respeitados.

Rollback: conservar o código de produção anterior `c9c97d5e9bc30249cd190357c9f4dd4004e0e097` e a cópia privada anterior à etapa. As migrações só expandem o schema; o código anterior continua compatível. Pausar novas automações antes de reverter aplicações. Nunca reapresentar uma operação financeira ou entrega incerta.
