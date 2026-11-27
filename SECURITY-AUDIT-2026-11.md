# ProfixBook security test, 27 November 2026

What was tested: sign-up, sign-in, invites, password reset, the database access rules for every table and function, the server functions (payments, invites, support tools, AI assistant), the browser code, the live site's settings and headers, and the app's software packages.

How: attacks were run as real signed-in users (two separate businesses, an owner, a sales staff member, and an anonymous visitor) against a full local copy of the database built from every migration. Against the live site only safe checks were made: reading public settings and headers, and trying to read data without signing in. No accounts were created on the live site, nothing was written to it, and nothing was flooded.

## Fixes (27 November 2026)

All findings were fixed the same day. Migration `0065_security_fixes.sql` holds the database fixes, with 20 new tests in `supabase/tests/tests.sql` (754 pass). The original attack script was run again: the free-upgrade, platform-admin and anonymous-access attacks are now refused.

- **C1:** sign-up ignores the platform-admin flag. Platform admins are added by hand only.
- **C2:** a trigger refuses changes to plan, trial, expiry, suspension, AI limit and founding price unless they come from the server's payment check or a platform admin. Name, VAT, bank details and other settings stay editable.
- **M1:** `vercel.json` sends a Content-Security-Policy (scripts only from ProfixBook, Paystack and the OCR library's CDN; no framing), plus X-Frame-Options, X-Content-Type-Options, Referrer-Policy and Permissions-Policy. Checked locally with the same headers: dashboard, till, reports, Excel and PDF packs, statement upload and help all work with no blocked requests.
- **M2:** invites expire after 7 days. The join page says so, and Team settings marks old invites as expired.
- **M3:** the app asks for at least 8 characters on sign-up, reset, join and password change (existing passwords still sign in). Supabase's own minimum must be raised too (see below).
- **L1:** visitors who aren't signed in can call only the two functions public pages need (invite details and founding spots). Internal helpers can't be called from the app at all. New functions follow the same rule.
- **L2:** logos still open by link, but only a business's own logo folder can be listed.
- **L3:** a pay link written from the app always starts as unpaid.
- **L4:** a plain sign-up with an invited email is refused, with a message pointing to the invite link.
- **L5:** `xlsx` updated to 0.20.3 from SheetJS's official source. The rest are build tools.

### To finish (owner)

1. Run `supabase/migrations/0065_security_fixes.sql` in the Supabase SQL editor.
2. Redeploy the `accept-invite` Edge Function (it now asks for 8-character passwords).
3. In Supabase, Authentication, set the minimum password length to 8. Turn on leaked-password protection if your plan has it.
4. Check `select * from platform_admins;`: every row should be an account you know.
5. Commit and push so Vercel deploys the app changes and the new headers.


| # | Finding | Severity | Status |
|---|---|---|---|
| C1 | Anyone can make themselves a ProfixBook platform admin at sign-up | Critical | Fixed in 0065 |
| C2 | A business owner can give their own business a paid plan, extend their trial, lift a suspension and raise their AI limit | Critical | Fixed in 0065 |
| M1 | The website sends none of the standard security headers (clickjacking and script protection) | Medium | Fixed (vercel.json) |
| M2 | Staff invite links never expire | Medium | Fixed in 0065 + app |
| M3 | Passwords can be as short as 6 characters | Medium | Fixed in app; set Supabase too |
| L1 | Some internal helper functions answer anyone who has an ID | Low | Fixed in 0065 |
| L2 | Anyone can list the logo files, which reveals business IDs | Low | Fixed in 0065 |
| L3 | Pay-link records can be written directly instead of only through the server | Low | Fixed in 0065 |
| L4 | Signing up with an invited email joins that business before the email is confirmed | Low | Fixed in 0065 + app |
| L5 | Known issues in software packages, nearly all in build tools that never run for users | Low | xlsx updated; build tools left |

## Critical

### C1. Anyone can become a platform admin

The sign-up trigger (`handle_new_user`, migration 0043, current body in 0045) makes any new account a platform admin if its sign-up data contains `"platform_admin": true`. Sign-up data is written by whoever signs up: anyone can call the public sign-up endpoint with that one extra field. The normal sign-up page never sends it, but the server accepts it from anyone.

A platform admin can see every business, change any business's plan, read every support ticket, and use **View as** to open any customer's account with a sign-in link. That is a takeover of every business on ProfixBook.

Email confirmation is on, so the attacker needs a real inbox, which is easy to get.

**Fix:** remove that branch from `handle_new_user`, so platform admins can only be added by you, by hand, in the SQL editor. Then check `select * from platform_admins` on the live database: every row should be an account you recognise. If there is an unknown one, remove it and look at audit logs for `platform.impersonate`.

### C2. Owners can change their own plan and limits

The rule on the `tenants` table lets a business's owner update their own business row, with no limit on which columns. Tested and confirmed: an owner can set, on their own business:

- `plan` to `business` and `plan_expires_at` 10 years ahead: a free Business plan
- `trial_ends_at` years ahead: a never-ending trial
- `is_active` back to true: undoing a suspension you placed
- `assistant_monthly_limit`: unlimited AI questions, which Evotekra pays for
- `founding_number` and `founding_since`: a founding price they didn't earn

This needs no special tools: one request to the database API with the owner's own sign-in.

**Fix:** a database trigger that refuses changes to those columns unless the change comes from the server (the payment check function) or a platform admin. Normal settings (name, VAT, bank details, terms, logo) stay editable.

## Medium

### M1. No security headers on the website

The live site sends only HTTPS enforcement (`strict-transport-security`). It does not send:

- `Content-Security-Policy`, which limits where scripts can come from and blunts any future script-injection bug
- `frame-ancestors` / `X-Frame-Options`, which stops another site loading ProfixBook inside a hidden frame and tricking a user into clicking (clickjacking)
- `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`

**Fix:** add them in `vercel.json`. The policy must allow Supabase, Paystack's popup, Google Fonts and the payment providers.

### M2. Invite links never expire

A staff invite link stays valid until it is used or the owner cancels it. Whoever holds the link can create the invited person's account and set its password. A link forwarded or left in an old chat months later still works.

**Fix:** invites expire after 7 days, and the owner can resend one.

### M3. Short passwords allowed

The minimum password length is 6 characters, in the app and in Supabase.

**Fix:** raise it to 8 in Supabase (Authentication, Sign In / Providers, Password) and in the app's forms. If your Supabase plan offers it, turn on leaked-password protection.

## Low

### L1. Helper functions that answer anyone

139 database functions that run with extra rights can be called without signing in. Almost all of them check who is calling and refuse. A few internal helpers don't: `branch_name`, `effective_plan`, `default_branch_id`, `money_default_account`, `money_till_account` and `money_account_for`. Given a real business or branch ID, they return a branch name, a plan, or account IDs. IDs are long random values, so this needs one to have leaked first (see L2).

**Fix:** remove anonymous (and where unused, signed-in) access to the internal helpers.

### L2. Logo file list is public

Logos are meant to be public, but the storage rule also lets anyone list the files. Each file sits in a folder named after the business's ID, so the list reveals business IDs.

**Fix:** keep logos viewable by link, remove the public list rule.

### L3. Pay-link records can be written directly

Sales and accounts staff can insert rows into `payment_links` straight through the API, with any values, instead of only through the server function that creates real links. Payments themselves are still checked with the provider, so this can't mark a sale paid, but it can leave misleading records.

**Fix:** remove the direct insert rule; the server function already writes with full rights.

### L4. Invited email joins before confirmation

If someone signs up with an email that has a pending invite, the account is attached to that business straight away, before the email is confirmed. Email confirmation is on, so they can't sign in without the inbox, and the invite-link flow resets the password for the real person. Risk is small.

**Fix:** only attach on a confirmed email, or only through the invite link.

### L5. Software packages

`npm audit` lists 52 known issues (2 critical, 31 high). Almost all are in the build tools (react-scripts, webpack, dev server), which run on the developer's computer and Vercel's build, never in a user's browser or on the server. The ones that reach users' browsers:

- `xlsx`: a crafted spreadsheet could slow the page or tamper with objects. Users only open their own files (imports, bank statements), so the risk is low. Newer versions are on SheetJS's own site, not npm.
- `react-router`: the listed issue affects a server-rendering mode ProfixBook doesn't use.

**Fix:** update `xlsx` from SheetJS's site; plan a move off react-scripts (to Vite) at some point.

## What passed

- **Data between businesses:** owner A could not read, change or add to business B's products, customers, staff or business record. Every table has access rules switched on, and no rule lets everyone in.
- **Anonymous visitors:** reading tenants, people, customers, sales, payments, products, suppliers, expenses, money, audit logs, invites, payment settings, support tickets and bank statements on the live site without signing in returned nothing.
- **Staff limits:** a sales user could not make themselves admin, change business settings, move to another branch, or see the balance sheet.
- **Moving between businesses:** a user cannot move their own account into another business.
- **Platform admin table:** cannot be written to by anyone signed in (the problem is only the sign-up route in C1).
- **Subscription payments:** confirmed only by the server after checking with Paystack, and the amount is checked against the database's own price list. A fake confirmation is refused.
- **Payment webhooks:** Paystack messages are signature-checked; Moniepoint and OPay payments are re-confirmed with the provider before anything is marked paid.
- **Payment secrets:** each business's provider keys are stored in Supabase Vault and never readable from the app.
- **Sales, payments and stock** can only change through the controlled sale and purchase functions, never by writing tables directly.
- **Browser code:** no raw HTML injection points, no secrets in the code or the git history, only the public Supabase key in the website.
- **Sign-up and email:** email confirmation is required; only email sign-in is enabled.
- **Functions run with a fixed search path**, so they can't be tricked into running look-alike functions.
- **The AI assistant** runs with the signed-in person's own access, so it can only see their business.

## Not tested

- Brute-force and rate limits on sign-in and password reset: testing needs repeated requests against the live service, which wasn't done. Supabase applies its own limits; check them under Authentication, Rate Limits.
- Supabase dashboard access and who on your team has it: worth making sure every account there has two-factor sign-in on.
