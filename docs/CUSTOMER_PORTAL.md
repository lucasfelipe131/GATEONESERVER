# Área do cliente conectada ao WhatsApp

Enviar `PORTAL`, `CADASTRO`, `MINHA CONTA`, `MEUS PAGAMENTOS`, `6` ou `8` ao chatbot entrega um link pessoal para `/cliente`. O link também acompanha a resposta da cobrança, na mesma mensagem. Durante o encaminhamento humano, o chatbot permanece em silêncio; `MENU` permite retomar as opções automáticas mantendo o encaminhamento registrado.

O cliente consulta seu login do serviço, assinatura, validade e pagamentos. O cadastro solicita nome e WhatsApp já verificado na conversa; o e-mail e o login informado para conferência são opcionais. CPF, senha e dados de cartão não são campos do cadastro. Informar um login de outra conta abre conferência humana e não libera seus dados.

Antes de liberar o cadastro em produção, o proprietário deve preencher **Responsável pelos dados dos clientes** e **Contato para pedidos de privacidade**, em Configurações. Os valores ficam nas configurações `privacy_controller_name` e `privacy_contact`. Sem ambos, a página explica a pendência e recusa salvar o cadastro. Não usar dados de demonstração em produção.

A ciência do aviso é registrada com versão, data e canal. A autorização para avisos opcionais é separada e pode ser retirada pelo cliente. Recusar avisos não impede usar a conta nem consultar pagamentos. A retirada desliga lembretes opcionais; confirmações de operações solicitadas seguem o fluxo transacional existente, respeitando a saída global de mensagens registrada no chat. Pedidos de cópia, correção e eliminação ficam na fila da equipe com protocolo. Eliminação exige avaliação dos registros que precisam ser conservados. Esses controles não substituem a avaliação jurídica e as rotinas do responsável pelos dados.

As formas de pagamento são consultadas na conta Mercado Pago já configurada. A seleção de um plano apenas mostra o valor; o botão de confirmação solicita o Checkout Pro pelo motor de cobrança existente. Uma cobrança pendente é reutilizada e a troca de plano pendente exige conferência. Clientes novos completam o cadastro; a equipe prepara e verifica a primeira assinatura antes de liberar a cobrança. O Mercado Pago pode solicitar informações próprias no checkout.

O pagamento só aparece confirmado após a conciliação oficial existente. O retorno do navegador e comprovantes não confirmam o pagamento. A renovação operacional é uma etapa separada.

## Publicação e validação

Aplicar a migration aditiva `0008_customer_portal_privacy.sql` antes de iniciar o servidor e worker desta versão. Os links legados recebem um prazo de transição de 24 horas a partir da aplicação; links novos expiram em 15 minutos e são de uso único. A sessão dura 24 horas e é vinculada ao cliente e ao número verificado, com cookie HttpOnly, Secure em produção e proteção contra requisições externas. Não compartilhar links pessoais.

`node scripts/customer-portal-verify.js` só roda no projeto GATE ECOSSISTEM, ambiente staging, `GATE_TEST_MODE=true`, `PROVIDER_MODE=fake-only`, pagamento/WhatsApp em simulação e BitPanel desabilitado. As verificações usam clientes e provedores sintéticos e revertem os registros da transação. A migration aplicada à estrutura não é revertida pelo verificador. Nenhuma cobrança real ou mensagem a cliente é necessária para esses testes.

`node scripts/customer-portal-preview.js` cria uma demonstração local em memória, sem integrações de cobrança ou mensagens. Não usar esse comando como servidor de produção.
