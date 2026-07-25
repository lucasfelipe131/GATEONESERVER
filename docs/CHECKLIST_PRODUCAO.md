# Checklist de produção

## Railway

- [ ] Projeto criado com `web`, `worker`, `Postgres` e `Redis`.
- [ ] Domínio público gerado apenas para `web`.
- [ ] `worker` usando `npm run worker`.
- [ ] `DATABASE_URL` e `REDIS_URL` referenciando os serviços corretos.
- [ ] `/health` retornando banco e Redis disponíveis.
- [ ] Senha do administrador alterada.
- [ ] Backup do PostgreSQL definido.
- [ ] Volume opcional do worker montado em `/app/artifacts` para evidências duráveis.

## Piloto seguro

- [ ] `GLOBAL_PAUSE=true`.
- [ ] `PAYMENT_MODE=simulation`.
- [ ] `WHATSAPP_MODE=simulation`.
- [ ] `BITPANEL_MODE=disabled`.
- [ ] `RENEWAL_REQUIRES_APPROVAL=true`.
- [ ] Base importada e conferida.
- [ ] Sete dias de comparação sem envios.
- [ ] Grupo piloto de 5 a 10 clientes com consentimento.

## Mercado Pago

- [ ] Aplicação criada.
- [ ] Access token de produção salvo apenas na Railway.
- [ ] Secret do webhook salvo apenas na Railway.
- [ ] Callback `/webhooks/mercadopago` cadastrado.
- [ ] Pix de valor baixo testado.
- [ ] Duplicidade de webhook testada.
- [ ] Pagamento aprovado gerando uma única renovação.

## WhatsApp

- [ ] Número oficial dedicado.
- [ ] Conta Meta Business configurada.
- [ ] Verificação em duas etapas configurada.
- [ ] Callback `/webhooks/whatsapp` validado.
- [ ] Token permanente configurado.
- [ ] Assinatura `X-Hub-Signature-256` validada.
- [ ] Templates D−3, D0, D+2, D+5, pagamento e renovação aprovados.
- [ ] Opt-out com “SAIR” testado.
- [ ] Atendimento iniciado pelo cliente testado.

## BitPanel

- [ ] Captura da lista e botões recebida sem credenciais.
- [ ] Janela de renovação mapeada.
- [ ] Seletores reais configurados.
- [ ] Cadastro de nova lista testado com aprovação humana.
- [ ] Template `gate_one_acesso_criado` aprovado na Meta.
- [ ] Login sem CAPTCHA/2FA automatizável confirmado.
- [ ] Simulação testada com conta própria.
- [ ] Validade antes/depois conferida.
- [ ] Evidência salva.
- [ ] Falha enviada para revisão manual.
- [ ] Piloto com aprovação humana concluído.

## Liberação

- [ ] Pausa global removida somente após todos os testes necessários.
- [ ] Limites de envio e consentimento revisados.
- [ ] Procedimento de contingência documentado.
- [ ] Direitos e licenças do serviço e da publicidade confirmados.
