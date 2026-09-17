// ============================================================
// StockFlow — Ask StockFlow, an AI assistant over the app's own data
// (Phase 7b)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "assistant" → paste this) OR via CLI:
//   supabase functions deploy assistant
//
// Set the secret (Project Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY = sk-ant-...   (StockFlow's own key — never a
//   per-tenant one, and it never reaches the frontend)
//
// The model never touches the database directly and is never trusted
// with a number of its own. Every fact it states comes from calling one
// of a fixed set of read-only RPCs — through a Supabase client built
// from the ASKING USER'S OWN JWT, forwarded straight through from the
// request. That means a cashier asking "how much should I reorder?" gets
// exactly the same "your role isn't allowed to view reorder suggestions"
// refusal the RPC would give from the UI — no branch or role restriction
// is bypassed just because a model is asking on the user's behalf.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// One model for now — Haiku 4.5, cheap enough for everyday questions.
// The plan's own note about escalating to a larger model for "analysis"
// questions needs a real classifier to do well; not built this sitting.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are "Ask StockFlow", built into a Nigerian inventory and manufacturing
app called StockFlow. You answer questions about ONE business's own data by
calling the tools available to you — you have no other source of numbers.

Rules, no exceptions:
- Every figure in your answer must come from a tool call you actually made in
  this conversation. Never estimate, round suspiciously, or invent a number.
- If a tool call fails or is refused (wrong role, wrong plan, not found),
  say so plainly and explain what that means — don't paper over it or guess
  an answer instead.
- You can only read data, never change it. If asked to do something that
  changes a record (record a sale, edit a price, place an order), explain
  that you can't and point to the right screen in the app instead.
- Money is Nigerian Naira (₦) unless the business's own data says otherwise.
- Keep answers short and concrete — a shop owner reading this on a phone.`;

const TOOLS = [
  {
    name: 'dashboard_summary',
    description: "This business's role-shaped dashboard summary for the asking user — sales, stock, profit and alerts, shaped for their own role (admin/sales/inventory/accounts).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'stock_levels',
    description: 'Current stock on hand per material and finished good, optionally at one branch. Returns branch, product, unit, quantity, min stock level, and sellable quantity (excludes expired/recalled/on-hold stock).',
    input_schema: {
      type: 'object',
      properties: { branch_id: { type: 'string', description: 'Optional branch UUID. Omit to use the caller\'s own branch.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'reorder_suggestions',
    description: 'Smart reorder suggestions for raw materials only (not finished goods) — how much of each material to order and why, based on real usage history, its variability, and the learned supplier lead time. Admin/inventory only.',
    input_schema: {
      type: 'object',
      properties: { branch_id: { type: 'string', description: 'Optional branch UUID. Omit to use the caller\'s own branch.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'batch_trace',
    description: 'Trace one finished-good production batch end to end: which raw material batches went into it (and their supplier), which sales it went out to, and how much is left. Needs the exact finished-good id and batch number — ask the user for the batch number if they only gave a product name.',
    input_schema: {
      type: 'object',
      properties: {
        finished_good_id: { type: 'string', description: 'UUID of the finished good.' },
        batch_no: { type: 'string', description: 'The batch number as printed on the label.' },
      },
      required: ['finished_good_id', 'batch_no'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_product_profitability',
    description: 'Quantity sold, revenue, cost and gross profit per finished good over a date range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive. Omit for no lower bound.' },
        to: { type: 'string', description: 'ISO date, inclusive. Omit for no upper bound.' },
        branch_id: { type: 'string', description: 'Optional branch UUID. Omit for all branches the caller can see.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report_returns',
    description: 'Customer returns and credit notes per finished good over a date range — quantity returned, reasons, and value.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive.' },
        to: { type: 'string', description: 'ISO date, inclusive.' },
        branch_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report_discounts',
    description: 'Discounts given on sales, grouped by the reason recorded, over a date range — how many lines, how much quantity, and the total value discounted.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive.' },
        to: { type: 'string', description: 'ISO date, inclusive.' },
        branch_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(client: ReturnType<typeof createClient>, name: string, input: Record<string, unknown>) {
  switch (name) {
    case 'dashboard_summary':
      return await client.rpc('dashboard_summary');
    case 'stock_levels':
      return await client.rpc('stock_levels', { p_branch: input.branch_id ?? null });
    case 'reorder_suggestions':
      return await client.rpc('reorder_suggestions', { p_branch: input.branch_id ?? null });
    case 'batch_trace':
      return await client.rpc('batch_trace', { p_fg: input.finished_good_id, p_batch_no: input.batch_no });
    case 'report_product_profitability':
      return await client.rpc('report_product_profitability', { p_from: input.from ?? null, p_to: input.to ?? null, p_branch: input.branch_id ?? null });
    case 'report_returns':
      return await client.rpc('report_returns', { p_from: input.from ?? null, p_to: input.to ?? null, p_branch: input.branch_id ?? null });
    case 'report_discounts':
      return await client.rpc('report_discounts', { p_from: input.from ?? null, p_to: input.to ?? null, p_branch: input.branch_id ?? null });
    default:
      return { data: null, error: { message: `Unknown tool "${name}".` } };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { question, history } = await req.json();
    if (!question || typeof question !== 'string' || !question.trim()) {
      return json({ error: 'Ask a question first.' });
    }

    // Every RPC call below goes through THIS client, built from the
    // caller's own JWT — RLS and every has_role()/branch check apply
    // exactly as if the user called it themselves.
    const authHeader = req.headers.get('Authorization') ?? '';
    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await client.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' });

    // Plan + monthly quota, checked and recorded BEFORE spending anything
    // on Claude — a rejected question never reaches the API. Returned as
    // a 200 with an `error` field, not a non-2xx status: supabase-js's
    // functions.invoke() surfaces a non-2xx as a generic "non-2xx status
    // code" error and drops the actual response body, which would bury
    // this exact, deliberately-worded message the user needs to see.
    const { data: quota, error: quotaErr } = await client.rpc('check_and_record_assistant_question');
    if (quotaErr) return json({ error: quotaErr.message });

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) return json({ error: 'The AI assistant isn\'t set up for this account yet.' });

    const messages: any[] = [...(Array.isArray(history) ? history : []), { role: 'user', content: question }];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOLS, messages }),
      });
      if (!res.ok) {
        return json({ error: `The assistant is temporarily unavailable (${res.status}). Try again shortly.` });
      }
      const data = await res.json();
      const content = data.content ?? [];
      messages.push({ role: 'assistant', content });

      const toolUses = content.filter((b: any) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const answer = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        return json({ answer: answer || "I couldn't find an answer to that.", quota, messages });
      }

      const toolResults = [];
      for (const use of toolUses) {
        const { data: toolData, error: toolError } = await callTool(client, use.name, use.input ?? {});
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(toolError ? { error: toolError.message } : (toolData ?? [])),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return json({ error: 'That question needed too many steps to answer — try asking something narrower.' });
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
