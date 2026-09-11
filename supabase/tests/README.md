# Database tests

Runs every migration in `../migrations` against [PGlite](https://pglite.dev) —
real Postgres compiled to WebAssembly — with Supabase's `auth` and `storage`
schemas and the `authenticated`/`anon` roles stubbed. Nothing touches the live
project.

`tests.sql` drives a two-branch company (Lagos + Abuja) with an owner, a
cashier, a storekeeper and a bookkeeper through the real FIFO engine and RLS:
per-branch selling, transfers at cost, adjustments, voids, payments, VAT,
role-shaped dashboards, who-can-see-what, branch lifecycle, and the books
balancing (company total = branch layers = movement ledger).

`pre.sql` plants an existing single-branch account in today's live state —
opening stock typed straight into `qty_balance` — *before* `0020` runs, so the
reconcile step is tested on real-shaped data.

## Run

PGlite isn't a project dependency, so install it without saving:

```bash
npm install --no-save @electric-sql/pglite@0.2
```

```bash
node supabase/tests/harness.js --pre supabase/tests/pre.sql --before 0020 --test supabase/tests/tests.sql
```

Exits non-zero if any migration fails to apply or any check fails.

## Add a check

Each check records into `t_results`. Act as a user with `t_as('<uuid>')`
(switches to the `authenticated` role, so RLS applies) and go back with
`t_su()`. Use `t_ok(name, sql)`, `t_err(name, sql, 'expected message')`, or
`t_rec(name, boolean)`.

The whole script runs as one transaction, so `now()` is the same everywhere —
give rows an explicit `created_at` when order matters.
