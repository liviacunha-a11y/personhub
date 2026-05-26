# PersonHub

Ferramenta interna Seazone para validar, criar e mesclar pessoas no Pipedrive, substituindo o formulário n8n quando ele está fora do ar.

**🌐 Produção:** https://personhub.seazone.dev

## O que faz

- **Login por email Seazone** — qualquer pessoa com conta no Pipedrive Seazone (`@seazone.com.br`) acessa
- **Busca individual** — encontra pessoa por nome / telefone / email (consulta Nekt, economiza token Pipedrive)
- **Criação** — cria pessoa nova com seu user_id como owner automaticamente
- **Validação em lote** — sobe planilha XLSX/CSV (até 100 linhas), valida todas em 1 SQL combinada (~3-5s)
- **Mesclagem de duplicatas** — escolhe qual manter e quais mesclar nela, com confirmação irreversível
- **Detecção de etiqueta Sapron** — sinaliza visualmente pessoas com a tag

## Stack

- **Backend:** Node.js 18+ (sem dependências npm — só built-ins `node:http` + `fetch`)
- **Frontend:** HTML estático single-page (SheetJS via CDN para XLSX)
- **Dados:** Lookup via Nekt (data lake) · Write via Pipedrive API
- **Auth:** Gate server-side em CADA chamada (header `X-User-Email` validado contra cache de Pipedrive users, TTL 5min)

## Como rodar local

### 1. Clonar
```bash
git clone https://github.com/seazone-tech/personhub.git
cd personhub
```

### 2. Configurar variáveis
Copie `.env.example` pra `.env` e preencha:
```bash
cp .env.example .env
```

Edite o `.env`:
```env
PIPEDRIVE_API_TOKEN=seu_token_pipedrive_aqui
NEKT_API_KEY=sua_chave_nekt_aqui

# Opcionais
PORT=3001
PIPEDRIVE_DOMAIN=https://seazone-fd92b9.pipedrive.com
SAPRON_LABEL_ID=4062
```

**Onde achar os tokens:**
- `PIPEDRIVE_API_TOKEN`: Pipedrive → Avatar → Configurações pessoais → API
- `NEKT_API_KEY`: vault do Supabase saleszone (`vault_read_secret('NEKT_API_KEY')`)

### 3. Rodar
```bash
node server.mjs
# ou: npm start
```

Abre em `http://localhost:3001`.

## Deploy (Coolify Seazone)

Hospedado em **Coolify Seazone** (`deploy.seazone.dev`), app `personhub` no projeto Seazone, server `localhost`.

- **Domínio:** `personhub.seazone.dev` (Cloudflare proxied)
- **Build:** Dockerfile (`node:20-slim`, sem npm install — código usa só built-ins)
- **Branch:** `main` (push pra esse branch dispara deploy)
- **Env vars:** mesmas do `.env`, configuradas no Coolify
- **Porta interna:** 3001 (Traefik roteia)

### Disparar deploy manualmente
```bash
curl -X POST "https://deploy.seazone.dev/api/v1/deploy?uuid=ce8g5lqlr1te6e8k4ksd8i5t" \
  -H "Authorization: Bearer SEU_TOKEN_COOLIFY"
```

## Arquitetura

```
Browser (login → email Seazone)
    │
    ▼ X-User-Email header em toda call
Node.js server (server.mjs)
    │
    ├── requireUser() → cache Pipedrive users (5min TTL)
    │
    ├── /api/me           → resolve email Seazone → user_id Pipedrive
    ├── /api/lookup       → SQL Nekt: any_match em emails/phones
    ├── /api/lookup-batch → 1 SQL combinada com todas as condições (lote ≤100)
    ├── /api/create       → POST Pipedrive /persons (owner = autenticado)
    └── /api/merge        → PUT Pipedrive /persons/{id}/merge (irreversível)
```

### Trade-offs intencionais

- **JS inline no HTML** — single-page de ~1700 linhas. Sem build pipeline = deploy trivial.
- **Lookup via Nekt, write via Pipedrive** — Nekt economiza token, mas tem delay (~horas). UI avisa visualmente o lag (`_nekt_sync_at`).
- **Cache em memória de Pipedrive users** — TTL 5min. Se alguém entrar no PD, libera em ≤5min sem precisar reiniciar.
- **Sem framework no frontend** — vanilla JS suficiente; trocar pra React custaria mais do que ganha.

## Endpoints da API

Todos exceto `/api/me` exigem header `X-User-Email`. Retornam 401 se ausente, inválido, ou não cadastrado no Pipedrive.

| Endpoint | Método | Body | Retorna |
|---|---|---|---|
| `/api/me?email=X` | GET | — | `{user_id, name, email}` |
| `/api/lookup` | POST | `{name?, phone?, email?}` | `{matches: [...]}` |
| `/api/lookup-batch` | POST | `{rows: [{phone?, email?}]}` | `{results: [{matches}]}` |
| `/api/create` | POST | `{name, phone?, email?, owner_id}` | `{person_id, name}` |
| `/api/merge` | POST | `{keep_id, merge_ids: [...]}` | `{keep_id, results}` |

## Limitações conhecidas

- Lote máximo: **100 linhas**
- Match de email: exato (não fuzzy)
- Match de telefone: últimos 9 dígitos do número (cobre BR mobile/landline mas pode dar falso-positivo entre números parecidos)
- Sem testes automatizados — smoke test manual em cada deploy
- Sem suporte mobile completo (UI funciona em ≥520px)

## Como contribuir

1. Branch a partir de `main`
2. Commit + push
3. PR pro `main`
4. Após merge, disparar deploy via API ou aguardar auto-deploy (se webhook configurado)
