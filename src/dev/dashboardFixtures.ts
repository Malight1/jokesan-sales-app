import { DashboardSummary } from '../lib/api';

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
