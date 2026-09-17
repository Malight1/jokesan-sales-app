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
  // Earned from returns, spent on a later sale (migration 0023).
  credit_balance?: number;
  // Overrides their customer type's price list (migration 0025).
  price_list_id?: string | null;
  // Custom fields (migration 0032). Optional so screens keep working
  // against a database that hasn't run it yet.
  custom_fields?: Record<string, any>;
}
// customer_types with its price list, for resolving a sale's price
// (migration 0025) — lookups.customerTypes() stays the plain id/name form
// the rest of the app already uses.
export interface CustomerType extends Lookup {
  price_list_id?: string | null;
}
export interface Supplier {
  id: string; first_name: string | null; last_name: string | null;
  company_store: string | null; address: string | null; email: string | null; phone: string | null;
  custom_fields?: Record<string, any>;
}
export interface Material {
  id: string; name: string; unit: string | null; type_of_material: string;
  qty_balance: number; min_stock_level: number; barcode: string | null;
  // Record the supplier's batch number and expiry on purchases (0022).
  track_batches?: boolean;
  custom_fields?: Record<string, any>;
}
export interface FinishedGood {
  id: string; name: string; unit: string | null; qty_balance: number;
  min_stock_level: number; default_markup: number; selling_price: number; barcode: string | null;
  // Batch and expiry settings (migration 0022). Optional so screens keep
  // working against a database that hasn't run it yet.
  track_batches?: boolean;
  shelf_life_days?: number | null;
  pick_rule?: 'fifo' | 'fefo';
  batch_prefix?: string | null;
  nafdac_no?: string | null;
  custom_fields?: Record<string, any>;
}
export interface SalesOrder {
  id: string; transaction_date: string; customer_id: string | null;
  // Server-issued invoice number (0021), e.g. INV-000123.
  doc_no?: string | null;
  total_amount: number; amount_paid: number; balance: number; cogs: number;
  gross_profit: number; payment_status: string; reference: string | null;
  notes: string | null; created_at: string; voided: boolean;
  subtotal: number; vat_amount: number; vat_rate: number;
  branch_id: string | null;
  // Cumulative return adjustment (0023). total_amount/gross_profit stay as
  // invoiced; these two track what's been given back since.
  returned_total?: number; returned_profit?: number;
  // Set only after the fact, via customFields.set('sale', ...) — create_sale
  // has no way to supply these at creation time (migration 0032).
  custom_fields?: Record<string, any>;
}
export type PurchaseOrderStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';
export interface PurchaseOrder {
  id: string; purchase_date: string; supplier_id: string | null;
  total_amount: number; total_paid: number; balance: number;
  payment_status: string; processed: boolean; voided: boolean;
  branch_id: string | null;
  // Balance can go negative once returned_total exceeds it: the supplier
  // owes YOU (migration 0023).
  returned_total?: number;
  // Ordered before received (migration 0029). Optional so a screen still
  // works against a database that hasn't run it — every purchase defaults
  // to 'received' either way, matching the immediate-receipt "Quick
  // purchase" path that's always existed.
  doc_no?: string | null;
  status?: PurchaseOrderStatus;
  expected_date?: string | null;
  ordered_at?: string | null;
}
export interface PurchaseOrderLine {
  id: string; purchase_order_id: string; material_id: string;
  qty_ordered: number; qty_received: number; unit_cost: number;
}
export interface GoodsReceipt {
  id: string; branch_id: string; purchase_order_id: string; doc_no: string | null;
  received_at: string; received_by: string | null; note: string | null;
}
export interface ProductionRun {
  id: string; production_date: string; finished_good_id: string;
  expenses: number; material_cost: number; total_cost: number;
  unit_cost: number; qty_produced: number; voided: boolean;
  branch_id: string | null;
  batch_no?: string | null; expiry_date?: string | null;
}
export interface Expense {
  id: string; expense_date: string; expense_type_id: string | null;
  description: string | null; amount: number; payment_type_id: string | null;
  branch_id: string | null;
}
export interface StockMovement {
  id: number; product_kind: string; product_id: string; movement_type: string;
  branch_id: string | null;
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
// PRICE LISTS, QUANTITY BREAKS & DISCOUNT LIMITS (migration 0025)
//
// A price is resolved in this order: the customer's own list, then their
// customer type's list, then the company's default list, then the
// product's plain selling price. create_sale (server) is the only place
// this is actually enforced; the frontend just previews it from the same
// tables so POS/Sales can show a live price as a cart is built.
// ============================================================
export interface PriceList { id: string; name: string; is_default: boolean; is_active: boolean; }
export interface PriceListItem { id: string; price_list_id: string; finished_good_id: string; min_qty: number; price: number; }
export interface DiscountLine { reason: string; line_count: number; qty: number; discount_value: number; }

export const pricing = {
  lists: () => run<PriceList[]>(supabase.from('price_lists').select('*').order('name')),
  createList: (name: string) => run<PriceList>(supabase.from('price_lists').insert({ name: name.trim() }).select().single()),
  renameList: (id: string, name: string) => del(supabase.from('price_lists').update({ name: name.trim() }).eq('id', id)),
  // Only one list may be the default; clear the old one first.
  setDefault: async (id: string) => {
    await del(supabase.from('price_lists').update({ is_default: false }).eq('is_default', true));
    await del(supabase.from('price_lists').update({ is_default: true }).eq('id', id));
  },
  setActive: (id: string, is_active: boolean) => del(supabase.from('price_lists').update({ is_active }).eq('id', id)),
  removeList: (id: string) => del(supabase.from('price_lists').delete().eq('id', id)),
  // Every price for every list — small enough per tenant to load in one
  // go, and POS/Sales need instant, no-round-trip repricing as a cart
  // is built.
  allItems: () => run<PriceListItem[]>(supabase.from('price_list_items').select('*')),
  // A flat price per product for one list (min_qty 1). Quantity breaks
  // beyond that live in the database (0025) but aren't editable here yet.
  setPrice: (priceListId: string, finishedGoodId: string, price: number) =>
    del(supabase.from('price_list_items').upsert(
      { price_list_id: priceListId, finished_good_id: finishedGoodId, min_qty: 1, price },
      { onConflict: 'price_list_id,finished_good_id,min_qty' },
    )),
  clearPrice: (priceListId: string, finishedGoodId: string) =>
    del(supabase.from('price_list_items').delete().eq('price_list_id', priceListId).eq('finished_good_id', finishedGoodId).eq('min_qty', 1)),

  customerTypes: () => run<CustomerType[]>(supabase.from('customer_types').select('id, name, price_list_id').order('name')),
  setCustomerTypeList: (id: string, priceListId: string | null) =>
    del(supabase.from('customer_types').update({ price_list_id: priceListId }).eq('id', id)),

  discountReport: (from?: string, to?: string, branchId?: string | null) =>
    rpc<DiscountLine[]>('report_discounts', { p_from: from || null, p_to: to || null, ...(branchId ? { p_branch: branchId } : {}) }),

  hasApprovalPin: () => rpc<boolean>('has_approval_pin'),
  setApprovalPin: (pin: string) => rpcVoid('set_approval_pin', { p_pin: pin }),
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
// UNITS OF MEASURE (migration 0030, Phase 6c)
//
// The engine always works in base units — a unit only ever affects how a
// QUANTITY is entered ("2 Carton" -> 24 pieces); unit_price/cost_price
// stay per base unit throughout the app, matching what create_sale/
// create_purchase/receive_purchase_order actually do server-side.
// ============================================================
export interface ProductUnit {
  id: string; product_kind: 'material' | 'finished_good'; product_id: string;
  name: string; factor: number; barcode: string | null;
  default_for_purchase: boolean; default_for_sale: boolean;
}

export const productUnits = {
  list: () => run<ProductUnit[]>(supabase.from('product_units').select('*').order('factor')),
  forProduct: (kind: 'material' | 'finished_good', productId: string) =>
    run<ProductUnit[]>(supabase.from('product_units').select('*').eq('product_kind', kind).eq('product_id', productId).order('factor')),
  create: (u: { product_kind: 'material' | 'finished_good'; product_id: string; name: string; factor: number; barcode?: string | null }) =>
    run<ProductUnit>(supabase.from('product_units').insert(u).select().single()),
  remove: (id: string) => del(supabase.from('product_units').delete().eq('id', id)),
  findByBarcode: async (code: string): Promise<ProductUnit | null> => {
    const r = await supabase.from('product_units').select('*').eq('barcode', code).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data as ProductUnit | null;
  },
};

// ============================================================
// CUSTOM FIELDS (migration 0032, Phase 6e)
//
// One custom_field_defs row per field an admin defines; the value lives
// in a custom_fields jsonb column on the entity's own row. Customers,
// suppliers, finished goods and materials all have a direct write policy
// already, so their custom fields are set as part of the normal
// create/update call. A sale doesn't — sales_orders is RPC-only — so
// customFields.set() (set_custom_fields) is the only way to fill in a
// sale's fields, always after the fact.
// ============================================================
export type CustomFieldEntity = 'customer' | 'supplier' | 'finished_good' | 'material' | 'sale';
export interface CustomFieldDef {
  id: string; entity: CustomFieldEntity; key: string; label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options: string[] | null;
  required: boolean;
  show_on_invoice: boolean;
  sort_order: number;
}

export const customFieldDefs = {
  list: () => run<CustomFieldDef[]>(supabase.from('custom_field_defs').select('*').order('entity').order('sort_order')),
  forEntity: (entity: CustomFieldEntity) =>
    run<CustomFieldDef[]>(supabase.from('custom_field_defs').select('*').eq('entity', entity).order('sort_order')),
  create: (d: { entity: CustomFieldEntity; key: string; label: string; type: CustomFieldDef['type']; options?: string[] | null; required?: boolean; show_on_invoice?: boolean; sort_order?: number }) =>
    run<CustomFieldDef>(supabase.from('custom_field_defs').insert(d).select().single()),
  remove: (id: string) => del(supabase.from('custom_field_defs').delete().eq('id', id)),
};

export const customFields = {
  // The only path for a sale; also usable for the other four entities.
  set: (entity: CustomFieldEntity, entityId: string, fields: Record<string, any>) =>
    rpcVoid('set_custom_fields', { p_entity: entity, p_entity_id: entityId, p_fields: fields }),
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
  // Look a sale up by its invoice number, for the POS "Returns" counter.
  // RLS already limits a cashier to their own branch's sales.
  findByDocNo: async (docNo: string): Promise<SalesOrder | null> => {
    const clean = docNo.trim().toUpperCase();
    if (!clean) return null;
    const r = await supabase.from('sales_orders').select('*').ilike('doc_no', clean).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data as SalesOrder | null;
  },
  // The invoice number the server issued for a sale (create_sale returns the id).
  docNo: async (id: string): Promise<string | null> => {
    const r = await supabase.from('sales_orders').select('doc_no').eq('id', id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return (r.data as { doc_no: string | null } | null)?.doc_no ?? null;
  },
  create: (params: {
    customerId: string | null; date: string; paymentTypeId: string | null;
    amountPaid: number;
    // fg_batch_id sells from one exact batch (a scanned batch label).
    // discount_reason is only meaningful when unit_price is below what
    // resolve_price() would charge — the server works the discount amount
    // out for itself, it isn't sent here.
    items: { finished_good_id: string; quantity: number; unit_price: number; fg_batch_id?: string; discount_reason?: string | null }[];
    vatRate?: number;
    // Pinned by the offline queue so a sale replays at the branch it was
    // rung up at. Omitted otherwise: the server uses the caller's branch.
    branchId?: string | null;
    // A flat ₦ amount off the whole sale (migration 0025).
    orderDiscount?: number;
    // Needed only when the combined discount is over the cashier's limit.
    approval?: { userId: string; pin: string } | null;
  }) =>
    rpc<string>('create_sale', {
      p_customer: params.customerId, p_date: params.date,
      p_payment_type: params.paymentTypeId, p_amount_paid: params.amountPaid, p_items: params.items,
      p_vat_rate: params.vatRate ?? 0,
      ...(params.branchId ? { p_branch: params.branchId } : {}),
      ...(params.orderDiscount ? { p_order_discount: params.orderDiscount } : {}),
      ...(params.approval ? { p_approval: { user_id: params.approval.userId, pin: params.approval.pin } } : {}),
    }),
  addPayment: (saleId: string, amount: number, paymentTypeId: string | null, reference?: string, notes?: string) =>
    rpcVoid('record_sale_payment', {
      p_sale: saleId, p_amount: amount, p_payment_type: paymentTypeId,
      p_reference: reference ?? null, p_notes: notes ?? null,
    }),
  void: (saleId: string) => rpcVoid('void_sale', { p_sale: saleId }),
};

// ============================================================
// DELIVERY NOTES AND WAYBILLS (migration 0031, Phase 6d)
//
// Stock leaves at the point of sale, exactly as always — a delivery note
// is paperwork and status only, never a stock or cost record.
// ============================================================
export type DeliveryStatus = 'pending' | 'dispatched' | 'delivered' | 'failed';
export interface Delivery {
  id: string; branch_id: string; sales_order_id: string; doc_no: string | null;
  driver_name: string | null; vehicle_no: string | null; destination: string | null;
  status: DeliveryStatus;
  dispatched_at: string | null; delivered_at: string | null;
  received_by_name: string | null; proof_url: string | null; note: string | null;
  created_at: string;
}
export interface DeliveryItem { id: string; delivery_id: string; sale_item_id: string; qty: number; }

export const deliveries = {
  list: () => runAll<Delivery>((f, t) => supabase.from('deliveries').select('*').order('created_at', { ascending: false }).range(f, t)),
  forSale: (saleId: string) => run<Delivery[]>(supabase.from('deliveries').select('*').eq('sales_order_id', saleId).order('created_at', { ascending: false })),
  detail: (id: string) => run<any>(supabase.from('deliveries').select('*, delivery_items(*)').eq('id', id).single()),
  create: (params: {
    saleId: string; items: { sale_item_id: string; qty: number }[];
    driverName?: string | null; vehicleNo?: string | null; destination?: string | null; note?: string | null;
  }) =>
    rpc<string>('create_delivery_note', {
      p_sale: params.saleId, p_items: params.items,
      p_driver_name: params.driverName ?? null, p_vehicle_no: params.vehicleNo ?? null,
      p_destination: params.destination ?? null, p_note: params.note ?? null,
    }),
  dispatch: (id: string, driverName?: string | null, vehicleNo?: string | null) =>
    rpcVoid('dispatch_delivery', { p_delivery: id, p_driver_name: driverName ?? null, p_vehicle_no: vehicleNo ?? null }),
  markDelivered: (id: string, receivedByName?: string | null, proofUrl?: string | null) =>
    rpcVoid('mark_delivery_delivered', { p_delivery: id, p_received_by_name: receivedByName ?? null, p_proof_url: proofUrl ?? null }),
  markFailed: (id: string, note?: string | null) =>
    rpcVoid('mark_delivery_failed', { p_delivery: id, p_note: note ?? null }),
  // Proof-of-delivery photo → Supabase Storage, confined to the caller's
  // own tenant folder. The bucket is private (unlike public logos), so
  // viewing it needs a signed URL, not a plain public one.
  uploadProof: async (tenantId: string, deliveryId: string, file: File): Promise<string> => {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${tenantId}/${deliveryId}.${ext}`;
    const up = await supabase.storage.from('delivery-proofs').upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) throw new Error(up.error.message);
    const signed = await supabase.storage.from('delivery-proofs').createSignedUrl(path, 60 * 60 * 24 * 365);
    if (signed.error) throw new Error(signed.error.message);
    return signed.data.signedUrl;
  },
};

// ============================================================
// PURCHASES  (writes go through the create_purchase RPC engine)
// ============================================================
export const purchases = {
  list: () => runAll<PurchaseOrder>((f, t) => supabase.from('purchase_orders').select('*').order('purchase_date', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('purchase_orders').select('*, purchase_items(*), purchase_payments(*)').eq('id', id).single()),
  create: (params: {
    supplierId: string | null; date: string; paymentTypeId: string | null;
    amountPaid: number;
    items: { material_id: string; qty: number; cost_price: number; supplier_batch_no?: string | null; expiry_date?: string | null }[];
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

  // Ordered before received (migration 0029). createOrder places the
  // order (no stock, nothing owed yet); receive() can be called more than
  // once for the same order as goods arrive in parts.
  createOrder: (params: {
    supplierId: string | null;
    lines: { material_id: string; qty: number; unit_cost: number }[];
    expectedDate?: string | null; branchId?: string | null;
  }) =>
    rpc<string>('create_purchase_order', {
      p_supplier: params.supplierId, p_lines: params.lines,
      p_expected: params.expectedDate ?? null,
      ...(params.branchId ? { p_branch: params.branchId } : {}),
    }),
  receive: (purchaseId: string, lines: { line_id: string; qty: number; unit_cost?: number; supplier_batch_no?: string | null; expiry_date?: string | null }[], date?: string | null) =>
    rpc<string>('receive_purchase_order', { p_po: purchaseId, p_lines: lines, p_date: date ?? null }),
  cancelOrder: (purchaseId: string, reason?: string | null) =>
    rpcVoid('cancel_purchase_order', { p_po: purchaseId, p_reason: reason ?? null }),
  lines: (purchaseId: string) =>
    run<PurchaseOrderLine[]>(supabase.from('purchase_order_lines').select('*').eq('purchase_order_id', purchaseId)),
  receipts: (purchaseId: string) =>
    run<GoodsReceipt[]>(supabase.from('goods_receipts').select('*').eq('purchase_order_id', purchaseId).order('received_at', { ascending: false })),
};

// ============================================================
// RETURNS & CREDIT NOTES (migration 0023)
//
// A sale with a return is never voided or edited — total_amount and
// gross_profit stay exactly as invoiced. Money goes: first it pays down
// whatever the customer still owes, then whatever's left is refunded in
// cash/transfer or turned into store credit for a named customer.
// ============================================================
export type ReturnCondition = 'resellable' | 'damaged' | 'expired';
export interface SaleReturn {
  id: string; sales_order_id: string; branch_id: string | null;
  doc_no: string | null; return_date: string; reason: string | null;
  subtotal: number; vat_amount: number; total: number; cogs_reversed: number;
  applied_to_balance: number; refunded: number; to_store_credit: number;
  refund_payment_type_id: string | null; created_at: string;
  // Voidable (migration 0024): admin-only, and refused if the stock has
  // since moved on or the store credit has already been spent.
  voided?: boolean; voided_at?: string | null;
}
export interface SaleReturnItem {
  id: string; sale_return_id: string; sale_item_id: string; finished_good_id: string;
  qty: number; unit_price: number; amount: number; condition: ReturnCondition;
}
export interface PurchaseReturn {
  id: string; purchase_order_id: string; branch_id: string | null;
  doc_no: string | null; return_date: string; reason: string | null;
  total: number; created_at: string;
  voided?: boolean; voided_at?: string | null;
}
export interface PurchaseReturnItem {
  id: string; purchase_return_id: string; purchase_item_id: string; material_id: string;
  qty: number; cost_price: number; amount: number;
}
export interface ReturnsByProduct {
  fg_id: string; product_name: string; qty_returned: number; value_returned: number;
  resellable_qty: number; loss_value: number;
}

export const returns = {
  sales: {
    list: () => runAll<SaleReturn>((f, t) => supabase.from('sale_returns').select('*').order('return_date', { ascending: false }).range(f, t)),
    get: (id: string) => run<SaleReturn>(supabase.from('sale_returns').select('*').eq('id', id).single()),
    forSale: (saleId: string) => run<SaleReturn[]>(supabase.from('sale_returns').select('*').eq('sales_order_id', saleId).order('created_at')),
    items: (returnId: string) => run<SaleReturnItem[]>(supabase.from('sale_return_items').select('*').eq('sale_return_id', returnId)),
    create: (params: {
      saleId: string;
      items: { saleItemId: string; qty: number; condition?: ReturnCondition }[];
      reason?: string | null;
      remainderMethod?: 'cash' | 'store_credit';
      paymentTypeId?: string | null;
      date?: string;
    }) =>
      rpc<string>('create_sale_return', {
        p_sale: params.saleId,
        p_items: params.items.map(i => ({ sale_item_id: i.saleItemId, qty: i.qty, condition: i.condition ?? 'resellable' })),
        p_reason: params.reason ?? null,
        p_remainder_method: params.remainderMethod ?? 'cash',
        p_payment_type: params.paymentTypeId ?? null,
        ...(params.date ? { p_date: params.date } : {}),
      }),
    // Admin only — refused if the stock has since moved on, or if the
    // store credit it issued has already been spent.
    void: (returnId: string) => rpcVoid('void_sale_return', { p_return: returnId }),
  },
  purchases: {
    list: () => runAll<PurchaseReturn>((f, t) => supabase.from('purchase_returns').select('*').order('return_date', { ascending: false }).range(f, t)),
    forPurchase: (purchaseId: string) => run<PurchaseReturn[]>(supabase.from('purchase_returns').select('*').eq('purchase_order_id', purchaseId).order('created_at')),
    items: (returnId: string) => run<PurchaseReturnItem[]>(supabase.from('purchase_return_items').select('*').eq('purchase_return_id', returnId)),
    create: (params: {
      purchaseId: string;
      items: { purchaseItemId: string; qty: number }[];
      reason?: string | null;
    }) =>
      rpc<string>('create_purchase_return', {
        p_purchase: params.purchaseId,
        p_items: params.items.map(i => ({ purchase_item_id: i.purchaseItemId, qty: i.qty })),
        p_reason: params.reason ?? null,
      }),
    void: (returnId: string) => rpcVoid('void_purchase_return', { p_return: returnId }),
  },
  // Finance-only, mirrors report_product_profitability's role check.
  byProduct: (from?: string, to?: string, branchId?: string | null) =>
    rpc<ReturnsByProduct[]>('report_returns', {
      p_from: from || null, p_to: to || null,
      ...(branchId ? { p_branch: branchId } : {}),
    }),
};

// A named customer's earned-but-unspent refund. Spending it works like a
// second payment on a later sale — record_sale_payment is untouched.
export const storeCredit = {
  spend: (saleId: string, amount: number) => rpcVoid('spend_store_credit', { p_sale: saleId, p_amount: amount }),
};

// ============================================================
// QUOTES AND PROFORMA INVOICES (migration 0028, Phase 6a)
//
// A quote never touches stock or money — it becomes a real sale only via
// convert(), which is just create_sale() under the hood. So a discount on
// a quote can still need a manager's PIN at conversion time, same as any
// sale would (see the migration's own header comment for why this isn't
// fully seamless).
// ============================================================
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'converted' | 'cancelled';
export interface Quote {
  id: string; tenant_id: string; branch_id: string; doc_no: string | null;
  customer_id: string | null; kind: 'quote' | 'proforma';
  issue_date: string; valid_until: string | null; status: QuoteStatus;
  subtotal: number; list_value: number; discount_total: number;
  vat_rate: number; vat_amount: number; total: number;
  notes: string | null; terms: string | null; converted_sale_id: string | null;
  created_by: string | null; created_at: string;
}
export interface QuoteItem {
  id: string; quote_id: string; finished_good_id: string;
  quantity: number; list_price: number; unit_price: number; discount_amount: number; amount: number;
}

export const quotes = {
  list: () => runAll<Quote>((f, t) => supabase.from('quotes').select('*').order('created_at', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('quotes').select('*, quote_items(*)').eq('id', id).single()),
  create: (params: {
    customerId: string | null; kind: 'quote' | 'proforma';
    items: { finished_good_id: string; quantity: number; unit_price: number }[];
    validUntil?: string | null; notes?: string | null; terms?: string | null; branchId?: string | null;
  }) =>
    rpc<string>('create_quote', {
      p_customer: params.customerId, p_kind: params.kind, p_items: params.items,
      p_valid_until: params.validUntil ?? null, p_notes: params.notes ?? null, p_terms: params.terms ?? null,
      ...(params.branchId ? { p_branch: params.branchId } : {}),
    }),
  setStatus: (id: string, status: Exclude<QuoteStatus, 'converted'>) =>
    rpcVoid('update_quote_status', { p_quote: id, p_status: status }),
  convert: (id: string, amountPaid: number, paymentTypeId: string | null, approval?: { userId: string; pin: string } | null) =>
    rpc<string>('convert_quote', {
      p_quote: id, p_amount_paid: amountPaid, p_payment_type: paymentTypeId,
      ...(approval ? { p_approval: { user_id: approval.userId, pin: approval.pin } } : {}),
    }),
};

// ============================================================
// PRODUCTION  (writes go through the record_production RPC engine)
// ============================================================
export const production = {
  list: () => runAll<ProductionRun>((f, t) => supabase.from('production_runs').select('*').order('production_date', { ascending: false }).range(f, t)),
  detail: (id: string) => run<any>(supabase.from('production_runs').select('*, production_consumption(*)').eq('id', id).single()),
  // Batch number is generated by the server when left blank (0022); expiry
  // defaults to manufacture date + the product's shelf life.
  record: (params: {
    finishedGoodId: string; date: string; expenses: number; qty: number;
    materials: { material_id: string; qty: number }[];
    batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null;
  }) =>
    rpc<string>('record_production', {
      p_finished_good: params.finishedGoodId, p_date: params.date,
      p_expenses: params.expenses, p_qty: params.qty, p_materials: params.materials,
      ...(params.batchNo ? { p_batch_no: params.batchNo } : {}),
      ...(params.mfgDate ? { p_mfg_date: params.mfgDate } : {}),
      ...(params.expiryDate ? { p_expiry_date: params.expiryDate } : {}),
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
// One row per (branch, item) the branch carries. Quantities only — no
// costs — so every role can read it (migration 0020, stock_levels()).
export interface StockLevel {
  branch_id: string; branch_name: string;
  product_kind: 'material' | 'finished_good';
  product_id: string; name: string; unit: string | null;
  qty: number; min_level: number;
  // What can actually be sold: leaves out expired, on-hold and recalled
  // stock (0022). Missing from data cached before that migration.
  sellable_qty?: number;
}

export const stock = {
  // null → every active branch; an id → just that branch.
  levels: (branchId?: string | null) =>
    rpc<StockLevel[]>('stock_levels', branchId ? { p_branch: branchId } : {}),
  // Opening stock / found stock (positive) or damage / count shortfall
  // (negative). Positive adds a costed layer at the branch; negative leaves
  // FIFO and records what it cost.
  adjust: (params: {
    branchId: string | null; kind: 'material' | 'finished_good'; productId: string;
    qtyDelta: number; unitCost?: number | null; reason?: string | null;
    // Adding: the stock's batch number and dates. Removing: one exact batch.
    batchId?: string | null; batchNo?: string | null; expiry?: string | null; mfg?: string | null;
  }) =>
    rpc<string>('adjust_stock', {
      p_branch: params.branchId, p_kind: params.kind, p_product: params.productId,
      p_qty_delta: params.qtyDelta, p_unit_cost: params.unitCost ?? null, p_reason: params.reason ?? null,
      ...(params.batchId ? { p_batch: params.batchId } : {}),
      ...(params.batchNo ? { p_batch_no: params.batchNo } : {}),
      ...(params.expiry ? { p_expiry: params.expiry } : {}),
      ...(params.mfg ? { p_mfg: params.mfg } : {}),
    }),
  movements: (limit = 200) =>
    run<StockMovement[]>(supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(limit)),
};

// ============================================================
// BATCHES — numbers, manufacture/expiry dates, hold, recall, trace (0022)
// ============================================================
export type BatchStatus = 'available' | 'quarantine' | 'recalled';
export interface FgBatch {
  id: string; finished_good_id: string; branch_id: string;
  batch_no: string | null; mfg_date: string | null; expiry_date: string | null;
  status: BatchStatus; status_reason: string | null;
  qty: number; qty_remaining: number; unit_cost: number;
  origin: string; produced_at: string; production_run_id: string | null;
}
export interface ExpiryItem {
  batch_id: string; product_id: string; name: string; unit: string | null;
  batch_no: string | null; branch_id: string; branch: string;
  qty: number; expiry_date: string | null; days_left: number | null;
  status: BatchStatus;
  value: number | null;          // admin/accounts only
}
export interface ExpiryOverview {
  warning_days: number;
  expired_count: number; expiring_count: number; on_hold_count: number;
  expired_value: number | null; expiring_value: number | null;
  items: ExpiryItem[];
}
export interface BatchTrace {
  product: string; batch_no: string; nafdac_no: string | null; unit: string | null;
  mfg_date: string | null; expiry_date: string | null; made: number;
  status: BatchStatus; status_reason: string | null;
  shows_customers: boolean;
  sources: { material: string; unit: string | null; qty: number; supplier: string | null;
             supplier_batch_no: string | null; material_expiry: string | null; purchased_on: string | null }[];
  stock: { branch: string; qty: number }[];
  sold_qty: number;
  sales: { sale_id: string; doc_no: string | null; date: string; branch: string; qty: number;
           customer: string | null; phone: string | null }[];
}

const BATCH_COLS = 'id, finished_good_id, branch_id, batch_no, mfg_date, expiry_date, status, status_reason, qty, qty_remaining, unit_cost, origin, produced_at, production_run_id';

export const batches = {
  // Finished-goods layers. RLS limits staff to their own branch.
  list: (includeEmpty = false) =>
    runAll<FgBatch>((f, t) => {
      let q = supabase.from('fg_batches').select(BATCH_COLS)
        .order('expiry_date', { ascending: true, nullsFirst: false })
        .order('produced_at', { ascending: false });
      if (!includeEmpty) q = q.gt('qty_remaining', 0);
      return q.range(f, t);
    }),
  forRun: (runId: string) =>
    run<FgBatch[]>(supabase.from('fg_batches').select(BATCH_COLS).eq('production_run_id', runId)),
  expiry: (branchId?: string | null) =>
    rpc<ExpiryOverview>('expiry_overview', branchId ? { p_branch: branchId } : {}),
  trace: (finishedGoodId: string, batchNo: string) =>
    rpc<BatchTrace>('batch_trace', { p_fg: finishedGoodId, p_batch_no: batchNo }),
  // Every branch at once. Admin only; a reason is required unless releasing.
  setStatus: (finishedGoodId: string, batchNo: string, status: BatchStatus, reason?: string | null) =>
    rpc<number>('set_batch_status', { p_fg: finishedGoodId, p_batch_no: batchNo, p_status: status, p_reason: reason ?? null }),
  writeOff: (kind: 'material' | 'finished_good', batchId: string, reason?: string) =>
    rpc<string>('write_off_batch', { p_kind: kind, p_batch: batchId, p_reason: reason ?? 'Expired' }),
};

// ============================================================
// DOCUMENT NUMBERING (0021)
// ============================================================
export const docs = {
  prefix: async (docType: string): Promise<string | null> => {
    const r = await supabase.from('doc_sequences').select('prefix').eq('doc_type', docType).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return (r.data as { prefix: string } | null)?.prefix ?? null;
  },
  setPrefix: (docType: string, prefix: string) => rpcVoid('set_doc_prefix', { p_type: docType, p_prefix: prefix }),
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
  productProfitability: (from?: string, to?: string, branchId?: string | null) =>
    rpc<ProductProfit[]>('report_product_profitability', {
      p_from: from || null, p_to: to || null,
      ...(branchId ? { p_branch: branchId } : {}),
    }),
  salesSummary: () => runAll<any>((f, t) => supabase.from('sales_orders').select('transaction_date,total_amount,amount_paid,balance,cogs,gross_profit').order('transaction_date').range(f, t)),
  expenseSummary: () => runAll<any>((f, t) => supabase.from('expenses').select('expense_date,amount,expense_type_id').order('expense_date').range(f, t)),
  purchaseSummary: () => runAll<any>((f, t) => supabase.from('purchase_orders').select('purchase_date,total_amount,balance').order('purchase_date').range(f, t)),
};

// ============================================================
// DASHBOARD — one role-shaped aggregate (migration 0018)
// Replaces the nine full-table reads the old dashboard fired on mount.
// The payload differs by role: a cashier is never sent the P&L, because
// it isn't computed for them, not because the UI hides it.
// ============================================================
export interface LowStockItem {
  kind: 'material' | 'finished_good';
  name: string; qty: number; unit: string | null; min: number;
  branch?: string;
}
export interface BranchSnapshot {
  id: string; name: string; today: number; month: number;
  month_profit: number; outstanding: number; low_stock: number;
}
export interface DashboardSummary {
  role: 'admin' | 'sales' | 'inventory' | 'accounts';
  account_live: boolean;
  multi_branch?: boolean;
  branch_id?: string | null;
  branch_name?: string;
  by_branch?: BranchSnapshot[];
  low_goods_count: number;
  low_materials_count: number;
  low_stock: LowStockItem[];

  // cashier
  today_total?: number; today_count?: number;
  my_today_total?: number; my_today_count?: number; today_unpaid?: number;
  yesterday_total?: number;
  my_recent?: { id: string; date: string; total: number; balance: number; status: string; customer: string }[];
  week_trend?: { day: string; total: number }[];

  // storekeeper
  out_of_stock_count?: number;
  production_this_month?: number; production_runs_this_month?: number;
  open_purchases?: number;
  stock_items?: number;
  recent_production?: { id: string; date: string; product: string; qty: number }[];
  recent_movements?: { id: number; type: string; qty: number; kind: string; at: string; name?: string | null }[];

  // owner / accounts
  total_sales?: number; sales_count?: number; gross_profit?: number; outstanding?: number;
  total_purchases?: number; purchase_count?: number; creditors?: number;
  total_expenses?: number; expense_count?: number;
  month_sales?: number; month_sales_count?: number; month_profit?: number; month_expenses?: number;
  last_month_sales?: number; last_month_profit?: number;
  month_trend?: { month: string; label: string; total: number }[];
  recent_sales?: { id: string; date: string; total: number; status: string; customer: string; branch?: string }[];
  reminders?: { id: string; name: string; phone: string | null; balance: number; days: number }[];
}

export const dashboard = {
  summary: () => rpc<DashboardSummary>('dashboard_summary'),
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
  update: (id: string, patch: {
    name?: string; currency?: string; vat_enabled?: boolean; vat_rate?: number; tin?: string | null; logo_url?: string | null;
    expiry_warning_days?: number; allow_expired_sale?: boolean;
    cashier_returns?: 'none' | 'same_day_own' | 'any';
    shift_rules?: Partial<ShiftRules>;
    // Printed on a proforma invoice only (migration 0028) — a plain quote doesn't need it.
    bank_details?: { bank_name?: string; account_name?: string; account_number?: string };
  }) =>
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
  // Admin only: moves the admin's own "working at" branch, which decides
  // where their sales, purchases and production are recorded.
  setMine: (id: string) => rpcVoid('set_my_branch', { p_branch: id }),
};

// ============================================================
// STOCK TRANSFERS — move stock between branches at its FIFO cost
// ============================================================
export interface StockTransfer {
  id: string; from_branch_id: string; to_branch_id: string;
  product_kind: 'material' | 'finished_good'; product_id: string;
  qty: number; total_cost: number; note: string | null;
  created_by: string | null; created_at: string;
}
export const transfers = {
  list: () => runAll<StockTransfer>((f, t) =>
    supabase.from('stock_transfers').select('*').order('created_at', { ascending: false }).range(f, t)),
  // Without batchId only sellable stock moves (expired/held stays put); with
  // it, exactly that batch moves whatever its state (0022).
  create: (p: { fromBranchId: string; toBranchId: string; kind: 'material' | 'finished_good'; productId: string; qty: number; note?: string | null; batchId?: string | null }) =>
    rpc<string>('transfer_stock', {
      p_from: p.fromBranchId, p_to: p.toBranchId, p_kind: p.kind,
      p_product: p.productId, p_qty: p.qty, p_note: p.note ?? null,
      ...(p.batchId ? { p_batch: p.batchId } : {}),
    }),
};

// ============================================================
// SHIFTS AND CASH-UP (migration 0026)
//
// create_sale/record_sale_payment/create_sale_return/spend_store_credit
// all tag the caller's open shift server-side on their own — nothing here
// needs to pass a shift id into a sale. This module only covers opening
// and closing a till, pay-ins/pay-outs, and the two reports.
// ============================================================
export interface Register { id: string; branch_id: string; name: string; is_active: boolean; }
export interface ShiftRules {
  required_for: string[];   // e.g. ["sales"] once an admin turns it on
  blind_count: boolean;
  variance_alert: number;
  pay_out_limit: number;
}
export interface ShiftExpected {
  cash: number; opening_float: number; cash_sales?: number;
  pay_in: number; pay_out: number; drop: number;
  transfer?: number; card?: number; store_credit?: number;
}
export interface ShiftReport {
  shift_id: string; register_id: string; branch_id: string;
  opened_by: string; opened_at: string; opening_float: number;
  status?: 'open' | 'closed';
  doc_no?: string | null; closed_by?: string | null; closed_at?: string | null;
  sales_count: number; sales_total: number; discount_total: number; refunds_total: number;
  expected: ShiftExpected;
  counted_cash?: number | null; counted_breakdown?: Record<string, number> | null;
  variance?: number | null; notes?: string | null;
}

export const registers = {
  list: () => run<Register[]>(supabase.from('registers').select('*').order('name')),
  create: (name: string, branchId: string) =>
    run<Register>(supabase.from('registers').insert({ name: name.trim(), branch_id: branchId }).select().single()),
  setActive: (id: string, is_active: boolean) => del(supabase.from('registers').update({ is_active }).eq('id', id)),
};

export const shifts = {
  // null if the caller has no open till right now.
  myOpenShiftId: () => rpc<string | null>('current_open_shift'),
  open: (registerId: string, float: number) => rpc<string>('open_shift', { p_register: registerId, p_float: float }),
  addCashMovement: (kind: 'pay_in' | 'pay_out' | 'drop', amount: number, reason: string, approval?: { userId: string; pin: string } | null) =>
    rpc<string>('add_cash_movement', {
      p_kind: kind, p_amount: amount, p_reason: reason,
      ...(approval ? { p_approval: { user_id: approval.userId, pin: approval.pin } } : {}),
    }),
  xReport: (shiftId?: string) => rpc<ShiftReport>('x_report', shiftId ? { p_shift: shiftId } : undefined),
  zReport: (shiftId: string) => rpc<ShiftReport>('z_report', { p_shift: shiftId }),
  close: (countedCash: number, breakdown?: Record<string, number> | null, notes?: string | null) =>
    rpc<ShiftReport>('close_shift', { p_counted_cash: countedCash, p_breakdown: breakdown ?? null, p_notes: notes ?? null }),
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

// ============================================================
// AUTOMATIC PAYMENT CONFIRMATION (migration 0027, Phase 5a)
//
// Each business connects its OWN Paystack account — money never passes
// through StockFlow. Connecting and reading back the secret both happen
// inside Edge Functions; the app only ever sees integration_status()'s
// public-facing shape (status + public key, never the secret).
// ============================================================
export interface IntegrationStatus {
  connected: boolean;
  status: 'not_connected' | 'pending' | 'live' | 'error';
  public_key: string | null;
  last_verified_at: string | null;
}
export interface PaymentLink {
  id: string; sales_order_id: string; provider_ref: string; url: string;
  amount: number; status: 'pending' | 'paid' | 'expired' | 'cancelled'; created_at: string;
}

export const payments = {
  integrationStatus: () => rpc<IntegrationStatus>('integration_status'),
  connect: async (secretKey: string, publicKey: string): Promise<{ success?: boolean; error?: string }> => {
    const { data, error } = await supabase.functions.invoke('payments-connect', { body: { secretKey, publicKey } });
    if (error) return { error: error.message };
    return data;
  },
  createLink: async (saleId: string): Promise<{ success?: boolean; url?: string; reference?: string; error?: string }> => {
    const { data, error } = await supabase.functions.invoke('payment-link-create', { body: { saleId } });
    if (error) return { error: error.message };
    return data;
  },
  linksForSale: (saleId: string) =>
    run<PaymentLink[]>(supabase.from('payment_links').select('*').eq('sales_order_id', saleId).order('created_at', { ascending: false })),
};

// NOTE: there is deliberately no client wrapper for seed_sample_data /
// seed_demo_data_for. Demo data is seeded ONLY by running the SQL directly
// in the Supabase editor, and only ever against the pitch account. Any UI
// path to it would let a real tenant seed a stranger's contacts into their
// own live data — see migration 0015.
