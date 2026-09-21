import { DashboardSummary, ExpiryOverview } from '../lib/api';

// Sample payloads shaped exactly like dashboard_summary() returns them, one
// per role. Used by the dashboard render tests and the development-only
// preview page — never shipped in a production build.

const iso = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const monthLabel = (monthsAgo: number) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return {
    month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
  };
};

export const cashierFixture: DashboardSummary = {
  role: 'sales',
  account_live: true,
  multi_branch: true,
  branch_id: 'branch-abuja',
  branch_name: 'Abuja (Wuse)',
  low_goods_count: 3,
  low_materials_count: 1,
  low_stock: [
    { kind: 'finished_good', name: 'Liquid Soap 1L', qty: 0, unit: 'pcs', min: 12, branch: 'Abuja (Wuse)' },
    { kind: 'finished_good', name: 'Dishwash 500ml', qty: 4, unit: 'pcs', min: 10, branch: 'Abuja (Wuse)' },
    { kind: 'finished_good', name: 'Hand Wash 250ml', qty: 7, unit: 'pcs', min: 8, branch: 'Abuja (Wuse)' },
    { kind: 'material', name: 'Caustic Soda', qty: 3.5, unit: 'kg', min: 20, branch: 'Abuja (Wuse)' },
  ],
  today_total: 187450,
  today_count: 23,
  my_today_total: 64300,
  my_today_count: 9,
  today_unpaid: 18500,
  yesterday_total: 162900,
  my_recent: [
    { id: 's1', date: iso(0), total: 8750, balance: 0, status: 'full', customer: 'Walk-in' },
    { id: 's2', date: iso(0), total: 18500, balance: 18500, status: 'unpaid', customer: 'Mama Nkechi Supermart' },
    { id: 's3', date: iso(0), total: 4200, balance: 0, status: 'full', customer: 'Chidinma Okafor' },
    { id: 's4', date: iso(0), total: 12900, balance: 4900, status: 'part', customer: 'Grace Beauty World' },
    { id: 's5', date: iso(1), total: 6650, balance: 0, status: 'full', customer: 'Walk-in' },
  ],
  week_trend: [
    { day: iso(6), total: 141200 },
    { day: iso(5), total: 98650 },
    { day: iso(4), total: 176300 },
    // a closed day: the server simply returns nothing for it
    { day: iso(2), total: 203800 },
    { day: iso(1), total: 162900 },
    { day: iso(0), total: 187450 },
  ],
};

export const inventoryFixture: DashboardSummary = {
  role: 'inventory',
  account_live: true,
  multi_branch: true,
  branch_id: 'branch-lagos',
  branch_name: 'Lagos (Ikeja)',
  low_goods_count: 4,
  low_materials_count: 3,
  stock_items: 38,
  out_of_stock_count: 2,
  production_this_month: 1840,
  production_runs_this_month: 7,
  open_purchases: 3,
  low_stock: [
    { kind: 'material', name: 'Sodium Lauryl Sulphate', qty: 0, unit: 'kg', min: 25, branch: 'Lagos (Ikeja)' },
    { kind: 'finished_good', name: 'Liquid Soap 1L', qty: 0, unit: 'pcs', min: 40, branch: 'Lagos (Ikeja)' },
    { kind: 'material', name: '500ml Bottles', qty: 64, unit: 'pcs', min: 300, branch: 'Lagos (Ikeja)' },
    { kind: 'finished_good', name: 'Dishwash 500ml', qty: 11, unit: 'pcs', min: 30, branch: 'Lagos (Ikeja)' },
    { kind: 'material', name: 'Caustic Soda', qty: 18.5, unit: 'kg', min: 50, branch: 'Lagos (Ikeja)' },
    { kind: 'finished_good', name: 'Hand Wash 250ml', qty: 22, unit: 'pcs', min: 24, branch: 'Lagos (Ikeja)' },
  ],
  recent_production: [],
  recent_movements: [
    { id: 912, type: 'SALE', qty: -6, kind: 'finished_good', at: iso(0), name: 'Liquid Soap 1L' },
    { id: 911, type: 'TRANSFER', qty: -24, kind: 'finished_good', at: iso(0), name: 'Dishwash 500ml' },
    { id: 908, type: 'PRODUCTION', qty: 240, kind: 'finished_good', at: iso(1), name: 'Dishwash 500ml' },
    { id: 907, type: 'PRODUCTION', qty: -36, kind: 'material', at: iso(1), name: 'Caustic Soda' },
    { id: 901, type: 'PURCHASE', qty: 120, kind: 'material', at: iso(3), name: 'Palm Kernel Oil' },
  ],
};

// expiry_overview() as the owner sees it (money included); the storekeeper's
// screen never renders the value fields.
export const expiryFixture: ExpiryOverview = {
  warning_days: 60,
  expired_count: 1,
  expiring_count: 2,
  on_hold_count: 1,
  expired_value: 84000,
  expiring_value: 212500,
  items: [
    { batch_id: 'x1', product_id: 'p1', name: 'Hand Wash 250ml', unit: 'pcs', batch_no: 'HAND-251012-01',
      branch_id: 'branch-lagos', branch: 'Lagos (Ikeja)', qty: 24, expiry_date: iso(3), days_left: -3, status: 'available', value: 84000 },
    { batch_id: 'x2', product_id: 'p2', name: 'Liquid Soap 1L', unit: 'pcs', batch_no: 'LSOA-260801-02',
      branch_id: 'branch-abuja', branch: 'Abuja (Wuse)', qty: 12, expiry_date: iso(-400), days_left: 400, status: 'recalled', value: 30000 },
    { batch_id: 'x3', product_id: 'p3', name: 'Dishwash 500ml', unit: 'pcs', batch_no: 'DISH-260315-01',
      branch_id: 'branch-lagos', branch: 'Lagos (Ikeja)', qty: 60, expiry_date: iso(-12), days_left: 12, status: 'available', value: 120000 },
    { batch_id: 'x4', product_id: 'p1', name: 'Hand Wash 250ml', unit: 'pcs', batch_no: 'HAND-260401-01',
      branch_id: 'branch-lagos', branch: 'Lagos (Ikeja)', qty: 40, expiry_date: iso(-41), days_left: 41, status: 'available', value: 92500 },
  ],
};

export const ownerFixture: DashboardSummary = {
  role: 'admin',
  account_live: true,
  multi_branch: true,
  branch_id: 'branch-lagos',
  branch_name: 'Lagos (Ikeja)',
  low_goods_count: 6,
  low_materials_count: 4,
  low_stock: [],
  total_sales: 48213750,
  sales_count: 5120,
  gross_profit: 14982400,
  outstanding: 1238600,
  total_purchases: 27604300,
  purchase_count: 412,
  creditors: 684250,
  total_expenses: 6390800,
  expense_count: 881,
  month_sales: 3847250,
  month_sales_count: 402,
  month_profit: 1196330,
  month_expenses: 412900,
  last_month_sales: 3401800,
  last_month_profit: 1044200,
  month_trend: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((m, i) => ({
    ...monthLabel(m),
    total: [2810400, 2934150, 3102600, 2876900, 3350200, 3598750, 3214300, 3702450, 3951800, 4120650, 4388900, 3847250][i],
  })),
  recent_sales: [
    { id: 'o1', date: iso(0), total: 48600, status: 'full', customer: 'Emeka & Sons Distribution', branch: 'Lagos (Ikeja)' },
    { id: 'o2', date: iso(0), total: 18500, status: 'unpaid', customer: 'Mama Nkechi Supermart', branch: 'Abuja (Wuse)' },
    { id: 'o3', date: iso(0), total: 132750, status: 'part', customer: 'Freshmart Stores', branch: 'Ibadan (Ring Road)' },
    { id: 'o4', date: iso(1), total: 9400, status: 'full', customer: 'Walk-in', branch: 'Lagos (Ikeja)' },
    { id: 'o5', date: iso(1), total: 57300, status: 'full', customer: 'De-Luxe Hotels', branch: 'Lagos (Ikeja)' },
  ],
  reminders: [
    { id: 'c1', name: 'Kano Traders Co', phone: '08077778888', balance: 286400, days: 41 },
    { id: 'c2', name: 'Green Valley Schools', phone: '08144445555', balance: 154000, days: 23 },
    { id: 'c3', name: 'Chidinma Cosmetics', phone: '08033334444', balance: 38750, days: 16 },
  ],
  by_branch: [
    { id: 'b1', name: 'Abuja (Wuse)', today: 187450, month: 1102600, month_profit: 331900, outstanding: 402150, low_stock: 4 },
    { id: 'b2', name: 'Ibadan (Ring Road)', today: 96300, month: 718450, month_profit: 204310, outstanding: 298700, low_stock: 0 },
    { id: 'b3', name: 'Lagos (Ikeja)', today: 241900, month: 2026200, month_profit: 660120, outstanding: 537750, low_stock: 6 },
  ],
};

// A retail owner: today first, week second, stock valued at cost, best and
// dead sellers — a genuinely different dashboard (src/retail), not a
// rearranged OwnerDashboard. See plan §1.1.
export const retailOwnerFixture: DashboardSummary = {
  role: 'admin',
  business_type: 'retail',
  account_live: true,
  multi_branch: true,
  branch_id: 'branch-ikeja',
  branch_name: 'Lagos (Ikeja)',
  low_goods_count: 3,
  low_materials_count: 0,
  low_stock: [
    { kind: 'finished_good', name: 'Coca-Cola 50cl (crate)', qty: 2, unit: 'crate', min: 10, branch: 'Lagos (Ikeja)' },
    { kind: 'finished_good', name: 'Indomie Chicken (carton)', qty: 0, unit: 'carton', min: 8, branch: 'Lagos (Ikeja)' },
    { kind: 'finished_good', name: 'Peak Milk 400g (carton)', qty: 5, unit: 'carton', min: 12, branch: 'Lagos (Ikeja)' },
  ],
  today_total: 284600,
  yesterday_total: 231900,
  today_unpaid: 12500,
  week_trend: [
    { day: iso(6), total: 198400 },
    { day: iso(5), total: 172300 },
    { day: iso(4), total: 246800 },
    // a closed day: the server simply returns nothing for it
    { day: iso(2), total: 209750 },
    { day: iso(1), total: 231900 },
    { day: iso(0), total: 284600 },
  ],
  outstanding: 96500,
  creditors: 412300,
  reminders: [
    { id: 'c1', name: 'Blessing Catering Services', phone: '08033445566', balance: 54000, days: 19 },
    { id: 'c2', name: 'Uncle Femi', phone: '08099887766', balance: 42500, days: 9 },
  ],
  by_branch: [
    { id: 'b1', name: 'Lagos (Ikeja)', today: 284600, month: 4812300, month_profit: 962400, outstanding: 96500, low_stock: 3 },
    { id: 'b2', name: 'Lagos (Yaba)', today: 156200, month: 2904100, month_profit: 561200, outstanding: 61200, low_stock: 1 },
  ],
  stock_value: {
    value_at_cost: 3184500,
    units_on_hand: 1842,
    product_count: 56,
  },
  movers: {
    period_days: 30,
    fast_movers: [
      { product_id: 'p1', name: 'Coca-Cola 50cl (crate)', unit: 'crate', qty_sold: 214, on_hand: 12, days_of_cover: 1.7 },
      { product_id: 'p2', name: 'Indomie Chicken (carton)', unit: 'carton', qty_sold: 168, on_hand: 6, days_of_cover: 1.1 },
      { product_id: 'p3', name: 'Peak Milk 400g (carton)', unit: 'carton', qty_sold: 142, on_hand: 20, days_of_cover: 4.2 },
      { product_id: 'p4', name: 'Golden Morn 500g', unit: 'pcs', qty_sold: 96, on_hand: 34, days_of_cover: 10.6 },
      { product_id: 'p5', name: 'Dettol Soap 100g', unit: 'pcs', qty_sold: 88, on_hand: 60, days_of_cover: 20.5 },
    ],
    dead_stock: [
      { product_id: 'p9', name: 'Imported Sparkling Wine', unit: 'pcs', on_hand: 14, days_since_sale: 46 },
      { product_id: 'p10', name: 'Luxury Gift Basket', unit: 'pcs', on_hand: 6, days_since_sale: null },
    ],
  },
};

// A brand-new retail shop, day one: no products, no sales, nothing owed.
// Onboarding is out of scope (plan context), so every panel's empty state
// has to carry that weight on its own — this fixture is what exercises them.
export const retailEmptyFixture: DashboardSummary = {
  role: 'admin',
  business_type: 'retail',
  account_live: true,
  multi_branch: false,
  low_goods_count: 0,
  low_materials_count: 0,
  low_stock: [],
  today_total: 0,
  yesterday_total: 0,
  today_unpaid: 0,
  week_trend: [],
  outstanding: 0,
  creditors: 0,
  reminders: [],
  by_branch: [],
  stock_value: { value_at_cost: 0, units_on_hand: 0, product_count: 0 },
  movers: { period_days: 30, fast_movers: [], dead_stock: [] },
};
