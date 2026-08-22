import { supabase } from './supabase';

// ============================================================
// Typed data-access layer. Every page talks to the backend
// through these functions — never to supabase directly.
// Reads use the auto-generated REST API (RLS-protected).
// Writes that touch stock/costing go through RPC engine fns.
// ============================================================

// ---------- Shared types (match Supabase schema) ----------
export interface Customer {
  id: string; first_name: string | null; last_name: string | null;
  company_store: string | null; address: string | null; phone: string | null;
  email: string | null; customer_type_id: string | null; last_reminded_at: string | null;
}
export interface Supplier {
  id: string; first_name: string | null; last_name: string | null;
  company_store: string | null; address: string | null; email: string | null; phone: string | null;
}
export interface Material {
  id: string; name: string; unit: string | null; type_of_material: string;
  qty_balance: number; min_stock_level: number; barcode: string | null;
}
export interface FinishedGood {
  id: string; name: string; unit: string | null; qty_balance: number;
  min_stock_level: number; default_markup: number; selling_price: number; barcode: string | null;
}
export interface SalesOrder {
  id: string; transaction_date: string; customer_id: string | null;
  total_amount: number; amount_paid: number; balance: number; cogs: number;
  gross_profit: number; payment_status: string; reference: string | null;
  notes: string | null; created_at: string; voided: boolean;
  subtotal: number; vat_amount: number; vat_rate: number;
}
export interface PurchaseOrder {
  id: string; purchase_date: string; supplier_id: string | null;
  total_amount: number; total_paid: number; balance: number;
  payment_status: string; processed: boolean; voided: boolean;
}
export interface ProductionRun {
  id: string; production_date: string; finished_good_id: string;
  expenses: number; material_cost: number; total_cost: number;
  unit_cost: number; qty_produced: number; voided: boolean;
}
export interface Expense {
  id: string; expense_date: string; expense_type_id: string | null;
  description: string | null; amount: number; payment_type_id: string | null;
}
export interface StockMovement {
  id: number; product_kind: string; product_id: string; movement_type: string;
  quantity: number; created_at: string;
}
export interface Lookup { id: string; name: string; }

// ---------- helpers ----------
// Await a supabase query builder (a thenable) and return a real Promise<T>.
async function run<T>(builder: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const res = await builder;
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
// PostgREST caps a single response at a fixed row count (1000 by default) and
// returns 200 for the truncated page — so an unpaged select silently shrinks
// once a tenant grows, and a P&L just quietly reports a smaller number. Every
// unbounded read goes through this instead: it walks .range() windows until a
// page comes back empty, advancing by however many rows actually arrived, so
// it stays correct whatever the server's cap is set to.
const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000; // runaway guard; a tenant this size needs server-side aggregation

async function runAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const res = await page(from, from + PAGE_SIZE - 1);
    if (res.error) throw new Error(res.error.message);
    const batch = res.data ?? [];
    out.push(...batch);
    if (batch.length === 0 || out.length >= MAX_ROWS) return out;
    from += batch.length;
  }
}

// Await an RPC that returns a value.
async function rpc<T>(name: string, args?: Record<string, any>): Promise<T> {
  const res = await supabase.rpc(name, args);
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
// Await an RPC/void write.
async function rpcVoid(name: string, args?: Record<string, any>): Promise<void> {
  const res = await supabase.rpc(name, args);
  if (res.error) throw new Error(res.error.message);
}
async function del(builder: PromiseLike<{ error: any }>): Promise<void> {
  const res = await builder;
  if (res.error) throw new Error(res.error.message);
}

// ============================================================
// LOOKUPS
// ============================================================
export const lookups = {
  paymentTypes: () => run<Lookup[]>(supabase.from('payment_types').select('id,name').order('name')),
  customerTypes: () => run<Lookup[]>(supabase.from('customer_types').select('id,name').order('name')),
  expenseTypes: () => run<Lookup[]>(supabase.from('expense_types').select('id,name').order('name')),
};

// ============================================================
// CUSTOMERS
// ============================================================
export const customers = {
  list: () => runAll<Customer>((f, t) => supabase.from('customers').select('*').order('created_at', { ascending: false }).range(f, t)),
  create: (c: Partial<Customer>) => run<Customer>(supabase.from('customers').insert(c).select().single()),
  update: (id: string, c: Partial<Customer>) => run<Customer>(supabase.from('customers').update(c).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('customers').delete().eq('id', id)),
  markReminded: (id: string) => del(supabase.from('customers').update({ last_reminded_at: new Date().toISOString() }).eq('id', id)),
};

// ============================================================
// SUPPLIERS
// ============================================================
export const suppliers = {
  list: () => runAll<Supplier>((f, t) => supabase.from('suppliers').select('*').order('created_at', { ascending: false }).range(f, t)),
  create: (s: Partial<Supplier>) => run<Supplier>(supabase.from('suppliers').insert(s).select().single()),
  update: (id: string, s: Partial<Supplier>) => run<Supplier>(supabase.from('suppliers').update(s).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('suppliers').delete().eq('id', id)),
};

// ============================================================
// MATERIALS (raw + packaging)
// ============================================================
export const materials = {
  list: () => runAll<Material>((f, t) => supabase.from('materials').select('*').order('name').range(f, t)),
  create: (m: Partial<Material>) => run<Material>(supabase.from('materials').insert(m).select().single()),
  update: (id: string, m: Partial<Material>) => run<Material>(supabase.from('materials').update(m).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('materials').delete().eq('id', id)),
  setMinLevel: (id: string, min_stock_level: number) => del(supabase.from('materials').update({ min_stock_level }).eq('id', id)),
  findByBarcode: async (code: string): Promise<Material | null> => {
    const r = await supabase.from('materials').select('*').eq('barcode', code).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data as Material | null;
  },
};

// ============================================================
// FINISHED GOODS
// ============================================================
export const finishedGoods = {
  list: () => runAll<FinishedGood>((f, t) => supabase.from('finished_goods').select('*').order('name').range(f, t)),
  create: (g: Partial<FinishedGood>) => run<FinishedGood>(supabase.from('finished_goods').insert(g).select().single()),
  update: (id: string, g: Partial<FinishedGood>) => run<FinishedGood>(supabase.from('finished_goods').update(g).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('finished_goods').delete().eq('id', id)),
  setMinLevel: (id: string, min_stock_level: number) => del(supabase.from('finished_goods').update({ min_stock_level }).eq('id', id)),
  findByBarcode: async (code: string): Promise<FinishedGood | null> => {
    const r = await supabase.from('finished_goods').select('*').eq('barcode', code).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data as FinishedGood | null;
  },
};

// ============================================================
// BOM (recipes)
// ============================================================
export const boms = {
  forProduct: (finishedGoodId: string) =>
    run<any>(supabase.from('boms').select('id, yield_qty, bom_items(id, material_id, quantity, unit)')
      .eq('finished_good_id', finishedGoodId).maybeSingle()),
  upsert: async (finishedGoodId: string, yieldQty: number, items: { material_id: string; quantity: number; unit?: string }[]) => {
    const existing = await supabase.from('boms').select('id').eq('finished_good_id', finishedGoodId).maybeSingle();
    let bomId = existing.data?.id as string | undefined;
    if (bomId) {
      await supabase.from('boms').update({ yield_qty: yieldQty }).eq('id', bomId);
      await supabase.from('bom_items').delete().eq('bom_id', bomId);
    } else {
      const created = await run<{ id: string }>(supabase.from('boms').insert({ finished_good_id: finishedGoodId, yield_qty: yieldQty }).select('id').single());
      bomId = created.id;
    }
    if (items.length) {
      const rows = items.map(it => ({ bom_id: bomId, material_id: it.material_id, quantity: it.quantity, unit: it.unit ?? null }));
      await del(supabase.from('bom_items').insert(rows));
    }
    return bomId!;
  },
};

// ============================================================
// SALES  (writes go through the create_sale RPC engine)
// ============================================================
export const sales = {
  list: () => runAll<SalesOrder>((f, t) => supabase.from('sales_orders').select('*').order('transaction_date', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('sales_orders').select('*, sale_items(*), sale_payments(*)').eq('id', id).single()),
  create: (params: {
    customerId: string | null; date: string; paymentTypeId: string | null;
    amountPaid: number; items: { finished_good_id: string; quantity: number; unit_price: number }[];
    vatRate?: number;
  }) =>
    rpc<string>('create_sale', {
      p_customer: params.customerId, p_date: params.date,
      p_payment_type: params.paymentTypeId, p_amount_paid: params.amountPaid, p_items: params.items,
      p_vat_rate: params.vatRate ?? 0,
    }),
  addPayment: (saleId: string, amount: number, paymentTypeId: string | null, reference?: string, notes?: string) =>
    rpcVoid('record_sale_payment', {
      p_sale: saleId, p_amount: amount, p_payment_type: paymentTypeId,
      p_reference: reference ?? null, p_notes: notes ?? null,
    }),
  void: (saleId: string) => rpcVoid('void_sale', { p_sale: saleId }),
};

// ============================================================
// PURCHASES  (writes go through the create_purchase RPC engine)
// ============================================================
export const purchases = {
  list: () => runAll<PurchaseOrder>((f, t) => supabase.from('purchase_orders').select('*').order('purchase_date', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('purchase_orders').select('*, purchase_items(*), purchase_payments(*)').eq('id', id).single()),
  create: (params: {
    supplierId: string | null; date: string; paymentTypeId: string | null;
    amountPaid: number; items: { material_id: string; qty: number; cost_price: number }[];
  }) =>
    rpc<string>('create_purchase', {
      p_supplier: params.supplierId, p_date: params.date,
      p_payment_type: params.paymentTypeId, p_amount_paid: params.amountPaid, p_items: params.items,
    }),
  addPayment: (purchaseId: string, amount: number, paymentTypeId: string | null, reference?: string, notes?: string) =>
    rpcVoid('record_purchase_payment', {
      p_purchase: purchaseId, p_amount: amount, p_payment_type: paymentTypeId,
      p_reference: reference ?? null, p_notes: notes ?? null,
    }),
  void: (purchaseId: string) => rpcVoid('void_purchase', { p_purchase: purchaseId }),
};

// ============================================================
// PRODUCTION  (writes go through the record_production RPC engine)
// ============================================================
export const production = {
  list: () => runAll<ProductionRun>((f, t) => supabase.from('production_runs').select('*').order('production_date', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('production_runs').select('*, production_consumption(*)').eq('id', id).single()),
  record: (params: {
    finishedGoodId: string; date: string; expenses: number; qty: number;
    materials: { material_id: string; qty: number }[];
  }) =>
    rpc<string>('record_production', {
      p_finished_good: params.finishedGoodId, p_date: params.date,
      p_expenses: params.expenses, p_qty: params.qty, p_materials: params.materials,
    }),
  void: (runId: string) => rpcVoid('void_production', { p_run: runId }),
};

// ============================================================
// EXPENSES
// ============================================================
export const expenses = {
  list: () => runAll<Expense>((f, t) => supabase.from('expenses').select('*').order('expense_date', { ascending: false }).range(f, t)),
  create: (e: Partial<Expense>) => run<Expense>(supabase.from('expenses').insert(e).select().single()),
  update: (id: string, e: Partial<Expense>) => run<Expense>(supabase.from('expenses').update(e).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('expenses').delete().eq('id', id)),
};

// ============================================================
// STOCK MOVEMENTS (ledger)
// ============================================================
export const stock = {
  movements: (limit = 200) =>
    run<StockMovement[]>(supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(limit)),
};

// ============================================================
// DASHBOARD / REPORTS aggregates
// ============================================================
export interface ProductProfit {
  fg_id: string; product_name: string; qty_sold: number;
  total_revenue: number; total_cogs: number; profit: number; margin_pct: number;
}

export const reports = {
  // Aggregated in SQL (migration 0016) rather than in the browser: it reads
  // sales_consumption, the highest-volume table, and uses the FIFO unit_cost
  // the engine actually consumed.
  productProfitability: (from?: string, to?: string) =>
    rpc<ProductProfit[]>('report_product_profitability', {
      p_from: from || null, p_to: to || null,
    }),
  salesSummary: () => runAll<any>((f, t) => supabase.from('sales_orders').select('transaction_date,total_amount,amount_paid,balance,cogs,gross_profit').order('transaction_date').range(f, t)),
  expenseSummary: () => runAll<any>((f, t) => supabase.from('expenses').select('expense_date,amount,expense_type_id').order('expense_date').range(f, t)),
  purchaseSummary: () => runAll<any>((f, t) => supabase.from('purchase_orders').select('purchase_date,total_amount,balance').order('purchase_date').range(f, t)),
};

// ============================================================
// TEAM & SETTINGS (admin)
// ============================================================
export interface TeamMember {
  id: string; full_name: string | null; email: string | null;
  role: string; is_active: boolean; branch_id: string | null;
}
export interface StaffInvite {
  id: string; email: string; role: string; status: string; created_at: string; branch_id: string | null;
}

export const team = {
  members: () => runAll<TeamMember>((f, t) => supabase.from('profiles').select('id, full_name, email, role, is_active, branch_id').order('created_at').range(f, t)),
  setRole: (id: string, role: string) => del(supabase.from('profiles').update({ role }).eq('id', id)),
  setActive: (id: string, is_active: boolean) => del(supabase.from('profiles').update({ is_active }).eq('id', id)),
  setBranch: (id: string, branch_id: string | null) => del(supabase.from('profiles').update({ branch_id }).eq('id', id)),
  invites: () => run<StaffInvite[]>(supabase.from('staff_invites').select('id, email, role, status, created_at, branch_id').eq('status', 'pending').order('created_at', { ascending: false })),
  invite: (email: string, role: string, branch_id?: string | null) =>
    del(supabase.from('staff_invites').insert({ email: email.trim().toLowerCase(), role, branch_id: branch_id ?? null })),
  revokeInvite: (id: string) => del(supabase.from('staff_invites').delete().eq('id', id)),
  // Best-effort real invite email via the invite-teammate Edge Function.
  // Never throws — the caller falls back to "Copy Invite Message" on failure.
  sendInviteEmail: async (email: string, redirectTo: string, role: string, tenantName: string): Promise<{ ok: boolean; error?: string }> => {
    const { data, error } = await supabase.functions.invoke('invite-teammate', { body: { email, redirectTo, role, tenantName } });
    if (error) return { ok: false, error: error.message };
    if (data?.error) return { ok: false, error: data.error };
    return { ok: true };
  },
};

export const tenantApi = {
  update: (id: string, patch: { name?: string; currency?: string; vat_enabled?: boolean; vat_rate?: number; tin?: string | null; logo_url?: string | null }) =>
    del(supabase.from('tenants').update(patch).eq('id', id)),
};

// ============================================================
// BRANCHES (multi_branch tenants only)
// ============================================================
export interface Branch { id: string; name: string; address: string | null; is_active: boolean; }
export const branches = {
  list: () => run<Branch[]>(supabase.from('branches').select('*').order('name')),
  create: (b: { name: string; address?: string | null }) => run<Branch>(supabase.from('branches').insert(b).select().single()),
  update: (id: string, b: Partial<Branch>) => run<Branch>(supabase.from('branches').update(b).eq('id', id).select().single()),
  setActive: (id: string, is_active: boolean) => del(supabase.from('branches').update({ is_active }).eq('id', id)),
};

// Generic CRUD over the three lookup tables (payment/expense/customer types)
export type LookupTable = 'payment_types' | 'expense_types' | 'customer_types';
export const lookupsAdmin = {
  add: (table: LookupTable, name: string) => del(supabase.from(table).insert({ name })),
  rename: (table: LookupTable, id: string, name: string) => del(supabase.from(table).update({ name }).eq('id', id)),
  remove: (table: LookupTable, id: string) => del(supabase.from(table).delete().eq('id', id)),
};

export const profileApi = {
  updateName: (id: string, full_name: string) => del(supabase.from('profiles').update({ full_name }).eq('id', id)),
  changePassword: async (password: string) => {
    const r = await supabase.auth.updateUser({ password });
    if (r.error) throw new Error(r.error.message);
  },
};

// ---- Logo upload → Supabase Storage, returns public data URL ----
export const branding = {
  uploadLogo: async (tenantId: string, file: File): Promise<string> => {
    const ext = file.name.split('.').pop()?.toLowerCase() === 'jpg' ? 'jpeg' : (file.name.split('.').pop()?.toLowerCase() || 'png');
    const path = `${tenantId}/logo.${ext}`;
    const up = await supabase.storage.from('logos').upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) throw new Error(up.error.message);
    const { data } = supabase.storage.from('logos').getPublicUrl(path);
    return data.publicUrl;
  },
  // Fetch an image URL and return a data URL (jsPDF needs base64, not a URL).
  toDataUrl: async (url: string): Promise<string> => {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  },
};

// ============================================================
// SUPER ADMIN (platform owner)
// ============================================================
export interface PlatformTenant {
  id: string; name: string; plan: string; is_active: boolean;
  created_at: string; users: number; sales_count: number; revenue: number;
}
export const platform = {
  isAdmin: () => rpc<boolean>('is_platform_admin'),
  tenants: () => rpc<PlatformTenant[]>('platform_tenants'),
  setActive: (tenantId: string, active: boolean) => rpcVoid('platform_set_active', { p_tenant: tenantId, p_active: active }),
};

// ============================================================
// BILLING (Paystack) — public key in the browser, secret key in the
// Edge Function. After Popup success we verify server-side.
// ============================================================
export const PLANS = [
  { id: 'starter',  name: 'Starter',  price: 7500,  users: 1,  blurb: 'Solo owner', features: ['Full ERP + invoices', 'WhatsApp receipts', 'CSV import', 'VAT', '1 user'] },
  { id: 'growth',   name: 'Growth',   price: 20000, users: 5,  blurb: 'Small team', features: ['Everything in Starter', 'POS mode', 'Smart Insights', 'Debtor reminders', '5 users'] },
  { id: 'business', name: 'Business',  price: 45000, users: 15, blurb: 'Multi-branch', features: ['Everything in Growth', 'Branches', 'Bank reconciliation', 'Priority support', '15 users'] },
] as const;

export const billing = {
  verify: async (reference: string, plan: string): Promise<{ success?: boolean; error?: string; expires?: string }> => {
    const { data, error } = await supabase.functions.invoke('paystack-verify', { body: { reference, plan } });
    if (error) return { error: error.message };
    return data;
  },
};

// NOTE: there is deliberately no client wrapper for seed_sample_data /
// seed_demo_data_for. Demo data is seeded ONLY by running the SQL directly
// in the Supabase editor, and only ever against the pitch account. Any UI
// path to it would let a real tenant seed a stranger's contacts into their
// own live data — see migration 0015.
