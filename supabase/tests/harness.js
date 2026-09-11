// Runs the real StockFlow migrations against PGlite (Postgres in WASM) with
// just enough of Supabase stubbed out: the auth schema + auth.uid(), the
// storage schema, and the authenticated/anon roles with Supabase's default
// grants. Lets us execute the engine, RLS and triggers before the user runs
// anything on the live project.
//
// From the repo root (see README.md in this folder):
//   node supabase/tests/harness.js                               run all migrations
//   node supabase/tests/harness.js --pre supabase/tests/pre.sql --before 0020 \
//        --test supabase/tests/tests.sql                          legacy data + full scenario
//
// A test script records results into t_results; the last result set it
// returns is printed as a pass/fail table.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

const MIG = path.resolve(__dirname, '../migrations');

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const PRE = arg('--pre');
const BEFORE = arg('--before');
const TEST = arg('--test');

const STUBS = `
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
-- Supabase resolves the caller from the JWT; here a GUC stands in for it.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
           nullif(current_setting('request.jwt.claim.sub', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
         ), '')::uuid
$$;

create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text, name text, owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
grant usage on schema public, auth, storage to authenticated, anon;
-- Supabase's default privileges: API roles get table access, RLS decides rows.
alter default privileges in schema public grant all on tables    to authenticated, anon;
alter default privileges in schema public grant all on sequences to authenticated, anon;
grant select, insert, update, delete on storage.objects to authenticated;
`;

function prep(sql) {
  // pgcrypto isn't bundled; gen_random_uuid() is core Postgres anyway.
  return sql.replace(/create extension if not exists "pgcrypto";/gi, '-- (pgcrypto stubbed)');
}

async function runFile(db, file, label) {
  try {
    await db.exec(prep(fs.readFileSync(file, 'utf8')));
    console.log(`  ✓ ${label}`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${label}\n      ${e.message}${e.position ? ` (at char ${e.position})` : ''}`);
    return false;
  }
}

async function main() {
  const db = new PGlite();
  await db.exec(STUBS);

  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (PRE && BEFORE && f.startsWith(BEFORE)) {
      if (!(await runFile(db, PRE, `(pre) ${path.basename(PRE)}`))) process.exit(1);
    }
    if (!(await runFile(db, path.join(MIG, f), f))) process.exit(1);
  }

  if (TEST) {
    console.log(`\n=== ${path.basename(TEST)} ===`);
    let res;
    try {
      res = await db.exec(fs.readFileSync(TEST, 'utf8'));
    } catch (e) {
      console.log(`  ✗ test script aborted: ${e.message}`);
      process.exit(1);
    }
    const last = [...res].reverse().find(r => r.rows && r.rows.length);
    if (!last) { console.log('  (no results returned)'); return; }
    let failed = 0;
    for (const r of last.rows) {
      const mark = r.pass ? '✓' : '✗';
      if (!r.pass) failed++;
      console.log(`  ${mark} ${r.name}${!r.pass && r.detail ? `\n      → ${r.detail}` : ''}`);
    }
    console.log(`\n  ${last.rows.length - failed}/${last.rows.length} passed`);
    if (failed) process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
