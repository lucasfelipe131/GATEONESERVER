# Gate One Pro Server — Railway

Projeto de produção para centralizar na Railway:

- painel administrativo responsivo;
- clientes e assinaturas;
- planos Mensal (R$ 30), Trimestral (R$ 85), Semestral (R$ 150) e Anual (R$ 270);
- configuração protegida de Mercado Pago, WhatsApp Cloud API e BitPanel diretamente no administrador;
- sincronização de clientes do BitPanel por ID, login, proprietário, status e vencimento;
- renovação automática restrita aos clientes do proprietário Gate One Pro Server;
- detecção de vencimentos D−3, D0, D+2 e D+5;
- fila de aprovação de cobranças;
- Pix pelo Mercado Pago;
- atendimento e mensagens pela WhatsApp Cloud API;
- captação de leads;
- área do cliente e pontos Gate Club;
- fila de renovação no BitPanel por Playwright;
- auditoria, idempotência e pausa global.

O sistema nasce travado em modo seguro:

```text
GLOBAL_PAUSE=true
PAYMENT_MODE=simulation
WHATSAPP_MODE=simulation
BITPANEL_MODE=disabled
RENEWAL_REQUIRES_APPROVAL=true
```

Nenhuma cobrança, mensagem ou renovação real deve ser liberada antes do piloto.

## Arquitetura na Railway

Use um único projeto Railway com quatro serviços:

| Serviço | Origem | Comando | Função |
|---|---|---|---|
| `web` | Este repositório | `npm start` | Painel, API, página de vendas e webhooks |
| `worker` | Este mesmo repositório | `npm run worker` | Filas, rotina diária, WhatsApp e Playwright |
| `Postgres` | Railway Database | Automático | Dados, estados e auditoria |
| `Redis` | Railway Database | Automático | Filas de mensagens e renovações |

O `Dockerfile` usa a imagem oficial do Playwright com Chromium, permitindo que o
worker rode no ambiente Railway. A Railway permite usar o mesmo monorepo em mais
de um serviço, cada um com seu próprio comando de início:
[monorepos](https://docs.railway.com/deployments/monorepo) e
[Playwright na Railway](https://docs.railway.com/guides/playwright).

## Implantação rápida

### 1. Enviar o código para um repositório privado

Crie um repositório privado, por exemplo `gate-one-pro-railway`, e envie todo o
conteúdo desta pasta. Não envie um arquivo `.env`.

### 2. Criar o projeto e os bancos

Na Railway:

1. Crie um projeto vazio.
2. Adicione um banco PostgreSQL.
3. Adicione um banco Redis.
4. Adicione um serviço a partir do repositório e chame-o `web`.
5. Adicione o mesmo repositório novamente e chame o segundo serviço de `worker`.
6. Em `worker`, defina o Start Command como `npm run worker`.
7. Gere um domínio público apenas para `web`.

Consulte também a documentação oficial da Railway para
[PostgreSQL](https://docs.railway.com/databases/postgresql) e
[Redis](https://docs.railway.com/databases/redis).

### 3. Configurar as variáveis

Copie as chaves de `.env.example` para os serviços `web` e `worker`.

As referências aos bancos devem apontar para o nome real dos serviços:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=false
REDIS_URL=${{Redis.REDIS_URL}}
```

Configure primeiro:

```text
PUBLIC_BASE_URL=https://dominio-gerado.up.railway.app
PUBLIC_WHATSAPP_NUMBER=55DDDNÚMERO
COOKIE_SECRET=uma-chave-aleatoria-longa
ADMIN_NAME=Lucas
ADMIN_EMAIL=seu-email
ADMIN_PASSWORD=uma-senha-forte
GLOBAL_PAUSE=true
```

As variáveis do Mercado Pago, Meta e BitPanel podem ficar vazias na primeira
implantação. Os segredos devem existir somente nas Variables da Railway.

### 4. Conferir a primeira implantação

Abra:

```text
https://seu-dominio/health
```

O resultado esperado é:

```json
{
  "ok": true,
  "database": "ok",
  "redis": "PONG",
  "service": "web"
}
```

Depois acesse o domínio principal, entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD` e
mantenha a pausa global ativada.

## Primeiro piloto

1. Importe `clientes.json` pelo menu **Clientes**.
2. Verifique nomes, WhatsApps, planos, vencimentos e IDs do BitPanel.
3. Clique em **Verificar vencimentos**.
4. Compare durante sete dias as cobranças preparadas com sua operação real.
5. Teste com 5 a 10 clientes autorizados.
6. Ative o Mercado Pago.
7. Ative o WhatsApp.
8. Mapeie e simule o BitPanel.
9. Só então avalie retirar a pausa global.

O formato aceito na importação é:

```json
[
  {
    "name": "Nome do cliente",
    "whatsapp": "5555999999999",
    "plan": "monthly",
    "expiresOn": "2026-08-25",
    "bitpanelListId": "3353378",
    "bitpanelReference": "usuario-no-painel",
    "status": "active",
    "consentContact": true
  }
]
```

`plan` aceita `monthly`, `quarterly`, `mensal` ou `trimestral`.

## Mercado Pago

Crie uma aplicação no Mercado Pago e configure:

```text
PAYMENT_MODE=live
MERCADOPAGO_ACCESS_TOKEN=...
MERCADOPAGO_WEBHOOK_SECRET=...
MERCADOPAGO_NOTIFICATION_URL=https://seu-dominio/webhooks/mercadopago
MERCADOPAGO_PAYER_EMAIL=seu-email-de-cobrancas
```

O sistema:

1. cria o Pix com chave de idempotência;
2. valida a assinatura do webhook;
3. consulta o pagamento diretamente no Mercado Pago;
4. marca a cobrança como paga uma única vez;
5. abre a renovação para aprovação.

## WhatsApp Cloud API

Configure uma conta oficial da WhatsApp Business Platform e os webhooks:

```text
Callback URL: https://seu-dominio/webhooks/whatsapp
Verify token: o mesmo valor de WHATSAPP_VERIFY_TOKEN
```

Depois preencha:

```text
WHATSAPP_MODE=live
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_VERIFY_TOKEN=...
META_APP_SECRET=...
```

Cadastre e aprove na Meta os sete templates indicados em `.env.example`. O
WhatsApp Cloud API usa Graph API para envio e webhooks para eventos:
[plataforma](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform),
[webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)
e [templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).

Mensagens em massa para pessoas sem consentimento não fazem parte deste projeto.
O fluxo automático atende quem iniciou conversa, pediu atendimento ou aceitou
receber lembretes.

## BitPanel

O BitPanel não possui API, portanto a integração usa Playwright. O fluxo foi
mapeado diretamente no painel e agora cobre:

- busca de uma lista por usuário;
- leitura do ID e da validade;
- renovação de 1 a 12 meses;
- criação de uma nova lista;
- seleção do pacote de TV, plano e conexões;
- captura do usuário e da senha gerada automaticamente;
- verificação da validade depois da operação;
- evidência em imagem e revisão manual quando houver falha.

Configure somente no serviço `worker`:

```text
BITPANEL_USERNAME=seu-email
BITPANEL_PASSWORD=salve-apenas-na-railway
BITPANEL_PLAN_LABEL=30, R$ 30,00
BITPANEL_TV_PACKAGE=Full HD + H265 + HD + SD + VOD + Adulto
BITPANEL_DEFAULT_CONNECTIONS=1
BITPANEL_HEADLESS=true
```

Mantenha `BITPANEL_MODE=simulation` e
`RENEWAL_REQUIRES_APPROVAL=true` no primeiro piloto. Clientes novos são
identificados pelo estágio `new_sale` ou pela ausência de ID de lista. O robô
gera um usuário estável, verifica se ele já existe para impedir duplicidade,
cria a lista e grava o ID no Gate One Pro. A senha gerada não é incluída na
auditoria nem no conteúdo dos logs.

## Scripts

```bash
npm start          # serviço web
npm run worker     # worker de filas e agendamentos
npm run migrate    # aplica o schema
npm run seed       # cria planos, configurações e administrador
npm test           # testes de regras e segurança
npm run check      # valida sintaxe
```

## Segurança operacional

- Nunca grave tokens ou senhas no GitHub.
- Use um número oficial exclusivo para o Gate One Pro.
- Mantenha `RENEWAL_REQUIRES_APPROVAL=true` no piloto.
- Use a pausa global em qualquer comportamento inesperado.
- Cada estágio de cobrança possui chave idempotente.
- Cada pagamento cria no máximo uma renovação.
- Telefones aparecem mascarados no painel.
- Falhas do BitPanel vão para revisão manual.
- O serviço ofertado e anunciado deve respeitar os direitos e licenças aplicáveis.
