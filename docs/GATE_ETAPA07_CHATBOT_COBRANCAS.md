# Etapa 07: chatbot e cobranças no staging

O chatbot existente usa a cobrança persistida pelo mesmo serviço dos lembretes. Pedidos repetidos, reinícios e lembretes em D-3, D0, D+2 e D+5 reutilizam um único pagamento. O registro da notificação e o evento da fila são gravados na mesma transação. A assinatura é bloqueada durante a operação para coordenar os dois workers.

O Mercado Pago continua sendo o adapter existente. Nesta etapa, seu modo de simulação cria o checkout identificado como SIM-PREF. Nenhum token precisa ser copiado ou colocado em logs. O fluxo real e os providers de produção não são ativados por esta mudança.

`BILLING_AUTOMATION_ENABLED=true` habilita o novo fluxo somente em ambiente isolado, com providers fake, pagamento e WhatsApp em simulação e BitPanel desativado. Os modos também são conferidos no banco antes das operações. A pausa global continua bloqueando as automações reais; o dispatcher simulado pode processar os testes no staging.

O histórico recente identifica perguntas como “e o link?” e recibos sem legenda enquanto o pagamento estiver pendente. Pedidos humanos têm prioridade e um handoff aberto interrompe novas ações do bot. Três mensagens consecutivas sem compreensão registram um único encaminhamento. Fatos financeiros antigos não são recuperados da memória: o estado é consultado novamente.

Um comprovante ou “paguei” não confirma o pagamento. O PaymentWatcher exige origem verificada e valor correspondente; um evento pendente atrasado não regride um pagamento confirmado. A cobrança é marcada como paga apenas após a confirmação. A renovação e sua validade só são anunciadas após a verificação operacional.

## Validação

`test/chatbot-billing-postgres.test.js` executa o fluxo completo com PostgreSQL local: cobrança, retomada, quatro lembretes, concorrência, isolamento, comprovante, confirmação, outbox, renovação verificada, opt-out e handoff. O teste não acessa bancos ou providers externos.

`scripts/staging07-verify.js` verifica os cadastros originais do Gate OS Staging e os indicadores de configuração das integrações. Registra decisões de consulta e snapshots, preservando as contagens de clientes, assinaturas, cobranças, pagamentos e renovações. Não cria clientes ou confirma pagamentos. Executa somente no serviço de verificação autorizado do staging.

## Publicação e retorno

Não há migration nova. Web e workers usam a mesma versão. Defina a URL pública do staging para que os links simulados apontem ao ambiente correto. O serviço de verificação usa `railway.staging07-verify.json` e finaliza após os checks.

Para retornar, desative BILLING_AUTOMATION_ENABLED e republique a versão 90fa6fdeb7dfc271877eb93893a9efdac9773d9e. Preserve os registros adicionados; não é necessário apagar ou restaurar o banco. A ativação real depende da configuração válida do Mercado Pago, do webhook correto deste ambiente e de um canal WhatsApp operacional.
