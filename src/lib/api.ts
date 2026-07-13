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
  email: string | null; customer_type_id: string | null;
}
export interface Supplier {
  id: string; first_name: string | null; last_name: string | null;
  company_store: string | null; address: string | null; email: string | null; phone: string | null;
}
export interface Material {
  id: string; name: string; unit: string | null; type_of_material: string;
  qty_balance: number; min_stock_level: number;
}
export interface FinishedGood {
  id: string; name: string; unit: string | null; qty_balance: number;
  min_stock_level: number; default_markup: number; selling_price: number;
}
export interface SalesOrder {
  id: string; transaction_date: string; customer_id: string | null;
  total_amount: number; amount_paid: number; balance: number; cogs: number;
  gross_profit: number; payment_status: string; reference: string | null;
  notes: string | null; created_at: string; voided: boolean;
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
  list: () => run<Customer[]>(supabase.from('customers').select('*').order('created_at', { ascending: false })),
  create: (c: Partial<Customer>) => run<Customer>(supabase.from('customers').insert(c).select().single()),
  update: (id: string, c: Partial<Customer>) => run<Customer>(supabase.from('customers').update(c).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('customers').delete().eq('id', id)),
};

// ============================================================
// SUPPLIERS
// ============================================================
export const suppliers = {
  list: () => run<Supplier[]>(supabase.from('suppliers').select('*').order('created_at', { ascending: false })),
  create: (s: Partial<Supplier>) => run<Supplier>(supabase.from('suppliers').insert(s).select().single()),
  update: (id: string, s: Partial<Supplier>) => run<Supplier>(supabase.from('suppliers').update(s).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('suppliers').delete().eq('id', id)),
};

// ============================================================
// MATERIALS (raw + packaging)
// ============================================================
export const materials = {
  list: () => run<Material[]>(supabase.from('materials').select('*').order('name')),
  create: (m: Partial<Material>) => run<Material>(supabase.from('materials').insert(m).select().single()),
  update: (id: string, m: Partial<Material>) => run<Material>(supabase.from('materials').update(m).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('materials').delete().eq('id', id)),
  setMinLevel: (id: string, min_stock_level: number) => del(supabase.from('materials').update({ min_stock_level }).eq('id', id)),
};

// ============================================================
// FINISHED GOODS
// ============================================================
export const finishedGoods = {
  list: () => run<FinishedGood[]>(supabase.from('finished_goods').select('*').order('name')),
  create: (g: Partial<FinishedGood>) => run<FinishedGood>(supabase.from('finished_goods').insert(g).select().single()),
  update: (id: string, g: Partial<FinishedGood>) => run<FinishedGood>(supabase.from('finished_goods').update(g).eq('id', id).select().single()),
  remove: (id: string) => del(supabase.from('finished_goods').delete().eq('id', id)),
  setMinLevel: (id: string, min_stock_level: number) => del(supabase.from('finished_goods').update({ min_stock_level }).eq('id', id)),
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
  list: () => run<SalesOrder[]>(supabase.from('sales_orders').select('*').order('transaction_date', { ascending: false })),
  detail: (id: string) => run<any>(supabase.from('sales_orders').select('*, sale_items(*), sale_payments(*)').eq('id', id).single()),
  create: (params: {
    customerId: string | null; date: string; paymentTypeId: string | null;
    amountPaid: number; items: { finished_good_id: string; quantity: number; unit_price: number }[];
  }) =>
    rpc<string>('create_sale', {
      p_customer: params.customerId, p_date: params.date,
      p_payment_type: params.paymentTypeId, p_amount_paid: params.amountPaid, p_items: params.items,
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
  list: () => run<PurchaseOrder[]>(supabase.from('purchase_orders').select('*').order('purchase_date', { ascending: false })),
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
  list: () => run<ProductionRun[]>(supabase.from('production_runs').select('*').order('production_date', { ascending: false })),
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
  list: () => run<Expense[]>(supabase.from('expenses').select('*').order('expense_date', { ascending: false })),
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
export const reports = {
  salesSummary: () => run<any[]>(supabase.from('sales_orders').select('transaction_date,total_amount,amount_paid,balance,cogs,gross_profit')),
  expenseSummary: () => run<any[]>(supabase.from('expenses').select('expense_date,amount,expense_type_id')),
  purchaseSummary: () => run<any[]>(supabase.from('purchase_orders').select('purchase_date,total_amount,balance')),
};

// ============================================================
// TEAM & SETTINGS (admin)
// ============================================================
export interface TeamMember {
  id: string; full_name: string | null; email: string | null;
  role: string; is_active: boolean;
}
export interface StaffInvite {
  id: string; email: string; role: string; status: string; created_at: string;
}

export const team = {
  members: () => run<TeamMember[]>(supabase.from('profiles').select('id, full_name, email, role, is_active').order('created_at')),
  setRole: (id: string, role: string) => del(supabase.from('profiles').update({ role }).eq('id', id)),
  setActive: (id: string, is_active: boolean) => del(supabase.from('profiles').update({ is_active }).eq('id', id)),
  invites: () => run<StaffInvite[]>(supabase.from('staff_invites').select('id, email, role, status, created_at').eq('status', 'pending').order('created_at', { ascending: false })),
  invite: (email: string, role: string) => del(supabase.from('staff_invites').insert({ email: email.trim().toLowerCase(), role })),
  revokeInvite: (id: string) => del(supabase.from('staff_invites').delete().eq('id', id)),
};

export const tenantApi = {
  update: (id: string, patch: { name?: string; currency?: string }) =>
    del(supabase.from('tenants').update(patch).eq('id', id)),
};

// Generic CRUD over the three lookup tables (payment/expense/customer types)
export type LookupTable = 'payment_types' | 'expense_types' | 'customer_types';
export const lookupsAdmin = {
  add: (table: LookupTable, name: string) => del(supabase.from(table).insert({ name })),
  remove: (table: LookupTable, id: string) => del(supabase.from(table).delete().eq('id', id)),
};

export const profileApi = {
  updateName: (id: string, full_name: string) => del(supabase.from('profiles').update({ full_name }).eq('id', id)),
  changePassword: async (password: string) => {
    const r = await supabase.auth.updateUser({ password });
    if (r.error) throw new Error(r.error.message);
  },
};

// ============================================================
// SEED — populate current tenant with Jokesan starter data
// ============================================================
export const demo = {
  seed: () => rpcVoid('seed_sample_data'),
};
