# Aba Vencimentos — Gate One Pro Server

Arquivos prontos:
- `expirations.js` → enviar para `public/expirations.js`
- `expirations.css` → enviar para `public/expirations.css`

No arquivo `public/index.html`, faça duas alterações:

1. Depois desta linha:
```html
<link rel="stylesheet" href="/styles.css" />
```

adicione:
```html
<link rel="stylesheet" href="/expirations.css" />
```

2. No fim do arquivo, substitua:
```html
<script src="/app.js" type="module"></script>
```

por:
```html
<script src="/expirations.js" type="module"></script>
```

A nova aba terá:
- ordem pelo vencimento mais urgente ou mais distante;
- filtros: vencidos, hoje, 7 dias e 30 dias;
- filtros por plano e status;
- busca por cliente, WhatsApp, login e ID da lista;
- contadores;
- layout responsivo para celular;
- botão para localizar o cliente na aba Clientes.
