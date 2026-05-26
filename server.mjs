import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega .env local se existir (Node 20+ tem --env-file, mas suportamos manual também)
const dotenvPath = join(__dirname, ".env");
if (existsSync(dotenvPath)) {
  const text = readFileSync(dotenvPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const k = trimmed.slice(0, i).trim();
    const v = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const PORT = parseInt(process.env.PORT || "3001", 10);
const PD_DOMAIN = process.env.PIPEDRIVE_DOMAIN || "https://seazone-fd92b9.pipedrive.com";
const SAPRON_LABEL_ID = parseInt(process.env.SAPRON_LABEL_ID || "4062", 10);

if (!process.env.PIPEDRIVE_API_TOKEN) {
  throw new Error("Faltando PIPEDRIVE_API_TOKEN — defina no .env local ou env var do deploy");
}
if (!process.env.NEKT_API_KEY) {
  throw new Error("Faltando NEKT_API_KEY — defina no .env local ou env var do deploy");
}
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN.trim();
const NEKT_API_KEY = process.env.NEKT_API_KEY.trim();

async function getNektKey() {
  return NEKT_API_KEY;
}

async function queryNekt(sql) {
  const apiKey = await getNektKey();
  const res = await fetch("https://api.nekt.ai/api/v1/sql-query/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ sql, mode: "csv" }),
  });
  if (!res.ok) throw new Error(`Nekt ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.state !== "SUCCEEDED") throw new Error(json.state_change_reason || `Nekt state ${json.state}`);
  const url = (json.presigned_urls && json.presigned_urls[0]) || json.presigned_url;
  if (!url) throw new Error("Sem presigned URL na resposta Nekt");
  return await (await fetch(url)).text();
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length === 0) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = false; }
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
}

const normalizePhone = (p) => (p || "").replace(/\D/g, "");
const escapeSql = (s) => String(s).replace(/'/g, "''");

let usersCache = null;
let usersCachedAt = 0;
const USERS_CACHE_TTL = 5 * 60 * 1000;
async function getPdUsers() {
  if (usersCache && Date.now() - usersCachedAt < USERS_CACHE_TTL) return usersCache;
  const r = await fetch(`${PD_DOMAIN}/api/v1/users?api_token=${PD_TOKEN}`);
  const j = await r.json();
  if (!j.success) throw new Error("Falha ao listar users Pipedrive");
  usersCache = j.data;
  usersCachedAt = Date.now();
  return usersCache;
}

async function requireUser(req) {
  const email = (req.headers["x-user-email"] || "").toLowerCase().trim();
  if (!email) return { error: "Sessão ausente", status: 401 };
  if (!email.endsWith("@seazone.com.br")) return { error: "Email inválido", status: 401 };
  const users = await getPdUsers();
  const u = users.find((x) => (x.email || "").toLowerCase() === email);
  if (!u) return { error: "Email não cadastrado no Pipedrive", status: 401 };
  return { user: u };
}

async function createPdPerson({ name, phone, email, owner_id }) {
  const body = { name, owner_id };
  if (email) body.email = [{ value: email, primary: true, label: "work" }];
  if (phone) body.phone = [{ value: phone, primary: true, label: "work" }];
  const r = await fetch(`${PD_DOMAIN}/api/v1/persons?api_token=${PD_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.success) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error || j));
  return j.data;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const email = (url.searchParams.get("email") || "").toLowerCase().trim();
      if (!email.endsWith("@seazone.com.br")) return send(400, { error: "Use email @seazone.com.br" });
      const users = await getPdUsers();
      const u = users.find((x) => (x.email || "").toLowerCase() === email);
      if (!u) return send(404, { error: `Nenhum usuário Pipedrive com email ${email}` });
      return send(200, { user_id: u.id, name: u.name, email: u.email });
    }

    if (req.method === "POST" && url.pathname === "/api/lookup") {
      const auth = await requireUser(req);
      if (auth.error) return send(auth.status, { error: auth.error });
      const body = await readBody(req);
      const { phone, email } = body;
      const phoneNorm = normalizePhone(phone);
      const conditions = [];
      if (email && email.trim()) {
        conditions.push(`any_match(emails, e -> LOWER(e.value) = LOWER('${escapeSql(email.trim())}'))`);
      }
      if (phoneNorm && phoneNorm.length >= 8) {
        const tail = phoneNorm.slice(-9);
        conditions.push(`any_match(phones, p -> regexp_replace(p.value, '[^0-9]', '') LIKE '%${escapeSql(tail)}%')`);
      }
      if (conditions.length === 0) return send(400, { error: "Forneça pelo menos email ou telefone" });
      const sql = `
        SELECT id, name, owner_id, update_time, _nekt_sync_at,
               array_join(transform(emails, e -> e.value), '|') AS emails_str,
               array_join(transform(phones, p -> p.value), '|') AS phones_str,
               contains(label_ids, ${SAPRON_LABEL_ID}) AS has_sapron
        FROM nekt_trusted.pipedrive_v2_persons
        WHERE is_deleted = false AND (${conditions.join(" OR ")})
        LIMIT 20
      `;
      const csv = await queryNekt(sql);
      const rows = parseCSV(csv).map((r) => ({ ...r, has_sapron: r.has_sapron === "true" }));
      return send(200, { matches: rows });
    }

    if (req.method === "POST" && url.pathname === "/api/lookup-batch") {
      const auth = await requireUser(req);
      if (auth.error) return send(auth.status, { error: auth.error });
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) return send(400, { error: "rows vazio" });
      if (rows.length > 100) return send(400, { error: `Máximo 100 linhas por batch (recebi ${rows.length})` });

      const rowConditions = [];
      const rowMeta = rows.map((r) => {
        const emailLow = (r.email || "").toLowerCase().trim();
        const phoneNorm = normalizePhone(r.phone);
        const phoneTail = phoneNorm.length >= 8 ? phoneNorm.slice(-9) : "";
        const subConds = [];
        if (emailLow) subConds.push(`any_match(emails, e -> LOWER(e.value) = LOWER('${escapeSql(emailLow)}'))`);
        if (phoneTail) subConds.push(`any_match(phones, p -> regexp_replace(p.value, '[^0-9]', '') LIKE '%${escapeSql(phoneTail)}%')`);
        if (subConds.length > 0) rowConditions.push(`(${subConds.join(" OR ")})`);
        return { emailLow, phoneTail };
      });

      if (rowConditions.length === 0) {
        return send(200, { results: rows.map(() => ({ matches: [] })) });
      }

      const sql = `
        SELECT id, name, owner_id, update_time, _nekt_sync_at,
               array_join(transform(emails, e -> e.value), '|') AS emails_str,
               array_join(transform(phones, p -> p.value), '|') AS phones_str,
               contains(label_ids, ${SAPRON_LABEL_ID}) AS has_sapron,
               array_join(transform(emails, e -> LOWER(e.value)), '|') AS _emails_low,
               array_join(transform(phones, p -> regexp_replace(p.value, '[^0-9]', '')), '|') AS _phones_digits
        FROM nekt_trusted.pipedrive_v2_persons
        WHERE is_deleted = false AND (${rowConditions.join(" OR ")})
        LIMIT 1000
      `;
      const csv = await queryNekt(sql);
      const persons = parseCSV(csv).map((r) => ({ ...r, has_sapron: r.has_sapron === "true" }));

      const results = rowMeta.map((m) => {
        const matches = [];
        for (const p of persons) {
          let matched = false;
          if (m.emailLow) {
            const emails = (p._emails_low || "").split("|");
            if (emails.some((e) => e === m.emailLow)) matched = true;
          }
          if (!matched && m.phoneTail) {
            const phones = (p._phones_digits || "").split("|");
            if (phones.some((d) => d && d.includes(m.phoneTail))) matched = true;
          }
          if (matched) {
            const { _emails_low, _phones_digits, ...clean } = p;
            matches.push(clean);
          }
        }
        return { matches };
      });
      return send(200, { results });
    }

    if (req.method === "POST" && url.pathname === "/api/create") {
      const auth = await requireUser(req);
      if (auth.error) return send(auth.status, { error: auth.error });
      const body = await readBody(req);
      const { name, phone, email, owner_id } = body;
      if (!name || !owner_id) return send(400, { error: "name e owner_id obrigatórios" });
      if (!(email && email.trim()) && !(phone && phone.trim())) {
        return send(400, { error: "Forneça pelo menos email ou telefone" });
      }
      // Garantir que o owner_id enviado é o do próprio usuário autenticado (evita spoofing)
      if (String(owner_id) !== String(auth.user.id)) {
        return send(403, { error: "owner_id não corresponde ao usuário autenticado" });
      }
      const person = await createPdPerson({ name, phone, email, owner_id });
      return send(200, { person_id: person.id, name: person.name });
    }

    if (req.method === "POST" && url.pathname === "/api/merge") {
      const auth = await requireUser(req);
      if (auth.error) return send(auth.status, { error: auth.error });
      const body = await readBody(req);
      const keepId = body.keep_id;
      const mergeIds = Array.isArray(body.merge_ids) ? body.merge_ids : [];
      if (!keepId || mergeIds.length === 0) {
        return send(400, { error: "keep_id e merge_ids[] obrigatórios" });
      }
      const results = [];
      for (const mid of mergeIds) {
        if (String(mid) === String(keepId)) {
          results.push({ merge_id: mid, status: "skipped", error: "Mesmo ID do keep" });
          continue;
        }
        try {
          // Pipedrive merge: PUT /persons/{id}/merge — o {id} é absorvido em merge_with_id
          const r = await fetch(`${PD_DOMAIN}/api/v1/persons/${mid}/merge?api_token=${PD_TOKEN}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ merge_with_id: Number(keepId) }),
          });
          const j = await r.json();
          if (j.success) {
            results.push({ merge_id: mid, status: "ok" });
          } else {
            results.push({ merge_id: mid, status: "error", error: typeof j.error === "string" ? j.error : JSON.stringify(j.error || j) });
          }
        } catch (e) {
          results.push({ merge_id: mid, status: "error", error: e.message });
        }
      }
      const allOk = results.every((x) => x.status === "ok");
      return send(allOk ? 200 : 207, { keep_id: keepId, results });
    }

    return send(404, { error: "not found" });
  } catch (e) {
    console.error("Erro:", e);
    return send(500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ✓ Pipedrive Person Tool rodando em http://localhost:${PORT}`);
  console.log(`  ✓ Lookup via Nekt (nekt_trusted.pipedrive_v2_persons)`);
  console.log(`  ✓ Create via Pipedrive (${PD_DOMAIN})\n`);
  console.log(`  Abra no navegador: http://localhost:${PORT}\n`);
});
