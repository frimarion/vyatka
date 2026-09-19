#!/usr/bin/env node
// Генерация JWT_SECRET и пары ключей anon / service_role для self-hosted Supabase.
// Ключи — обычные HS256-токены, подписанные JWT_SECRET: Kong и PostgREST
// проверяют подпись и берут роль из claim "role".
//
//   node deploy/gen-keys.mjs            — новый секрет и ключи
//   node deploy/gen-keys.mjs <secret>   — ключи под уже существующий секрет
//
// Вывод содержит SERVICE_ROLE_KEY — он обходит RLS целиком. В репозиторий его
// не класть: только в .env на сервере и, при необходимости, в файл вне проекта.

import { createHmac, randomBytes } from "node:crypto";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function sign(payload, secret) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const secret = process.argv[2] || randomBytes(32).toString("hex");
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600;          // 10 лет — как у дойловского ключа

const anon = sign({ role: "anon", iss: "supabase", iat, exp }, secret);
const service = sign({ role: "service_role", iss: "supabase", iat, exp }, secret);

console.log(`JWT_SECRET=${secret}`);
console.log(`ANON_KEY=${anon}`);
console.log(`SERVICE_ROLE_KEY=${service}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(18).toString("base64url")}`);
console.log(`DASHBOARD_PASSWORD=${randomBytes(12).toString("base64url")}`);
