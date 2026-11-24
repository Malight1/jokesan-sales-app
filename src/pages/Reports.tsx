import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Download, MessageCircle } from 'lucide-react';
import { sales as salesApi, expenses as expensesApi, finishedGoods as goodsApi, customers as customersApi,
         purchases as purchasesApi, suppliers as suppliersApi, reports as reportsApi, returns as returnsApi, pricing, lookups, stock,
         StockCostRow } from '../lib/api';
import { hasFeature } from '../lib/features';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct } from '../lib/branchStock';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { whatsappLink, paymentRequestMessage } from '../lib/whatsapp';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column } from '../components/DataTable';
import { exportExcel, exportPDF, ExportColumn } from '../lib/exporters';
import { isRetail, label } from '../retail';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

type Tab = 'pnl' | 'sales' | 'expenses' | 'stock' | 'debtors' | 'creditors' | 'products' | 'returns' | 'discounts' | 'vat';
const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'pnl', label: 'Profit & Loss' },
  { id: 'sales', label: 'Sales' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'stock', label: 'Stock' },
  { id: 'debtors', label: 'Debtors' },
  { id: 'creditors', label: 'Creditors' },
  { id: 'products', label: 'Product Profit' },
  { id: 'returns', label: 'Returns' },
  { id: 'discounts', label: 'Discounts' },
  { id: 'vat', label: 'VAT' },
];

export default function Reports() {
  const { tenant } = useAuth();
  const toast = useToast();
  const retail = isRetail(tenant);
  const tiersEnabled = hasFeature(tenant, 'price_tiers');
  const vatOn = !!tenant?.vat_enabled;
  const TABS = ALL_TABS.filter(t => (t.id !== 'discounts' || tiersEnabled) && (t.id !== 'vat' || vatOn));
  const [tab, setTab] = useState<Tab>('pnl');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // '' = every branch. Only offered to multi-branch companies.
  const [branch, setBranch] = useState('');
  // How the Sales tab's trend chart buckets rows — From/To only narrows
  // which rows are included, this decides how they're grouped.
  const [period, setPeriod] = useState<'day' | 'month' | 'year'>('month');
  const { multi, active, nameOf } = useBranches();

  const salesQ = useQuery(() => salesApi.list(), []);
  const expQ = useQuery(() => expensesApi.list(), []);
  const goodsQ = useQuery(() => goodsApi.list(), []);
  const custQ = useQuery(() => customersApi.list(), []);
  const expTypesQ = useQuery(() => lookups.expenseTypes(), []);
  const purchQ = useQuery(() => purchasesApi.list(), []);
  const suppQ = useQuery(() => suppliersApi.list(), []);
  // Aggregated server-side, so it re-runs when the date range changes.
  const prodProfitQ = useQuery(() => reportsApi.productProfitability(from, to, branch || null), [from, to, branch]);
  // Netted by the return's OWN date (migration 0023), so this can differ
  // from what the Sales tab shows for the same range.
  const returnsQ = useQuery(() => returnsApi.byProduct(from, to, branch || null), [from, to, branch]);
  // Returns are taken off on the day they happened (0055), like the
  // dashboard, so a return in October doesn't rewrite September.
  const returnTotalsQ = useQuery(() => returnsApi.totalsByDay(from, to, branch || null), [from, to, branch]);
  const discountsQ = useQuery(() => tiersEnabled ? pricing.discountReport(from, to, branch || null) : Promise.resolve([]), [from, to, branch, tiersEnabled]);
  // Per-branch quantities for the Stock tab when a branch is chosen.
  const levelsQ = useQuery(() => stock.levels(null), []);
  // Stock losses, till short/over and store credit owed (0060).
  const extrasQ = useQuery(() => reportsApi.extras(from, to, branch || null).catch(() => null), [from, to, branch]);
  // What stock on hand cost, per item (0060).
  const stockCostQ = useQuery(() => reportsApi.stockValue(branch || null).catch(() => [] as StockCostRow[]), [branch]);

  const loading = salesQ.loading || expQ.loading || goodsQ.loading || returnTotalsQ.loading;
  const error = salesQ.error || expQ.error || goodsQ.error || returnTotalsQ.error;

  const inRange = (d: string | null) => {
    if (!d) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  const inBranch = (b: string | null | undefined) => !branch || b === branch;

  // Voided sales are excluded from every report.
  const sales = (salesQ.data ?? []).filter(s => !s.voided && inRange(s.transaction_date) && inBranch(s.branch_id));
  // Voided expenses never count (0060).
  const expenses = (expQ.data ?? []).filter(e => !e.voided && inRange(e.expense_date) && inBranch(e.branch_id));
  // Debts are "as of" the To date: every unpaid invoice up to then, however
  // old. A From date must not hide a customer who has owed since August.
  const upTo = (d: string | null) => !d || !to || d <= to;
  const salesOwing = (salesQ.data ?? []).filter(s => !s.voided && s.balance > 0 && upTo(s.transaction_date) && inBranch(s.branch_id));
  // With a branch chosen, stock is what THAT branch holds, not the company total.
  const branchQty = qtyByProduct((levelsQ.data ?? []).filter(l => l.product_kind === 'finished_good'), branch);
  const goods = (goodsQ.data ?? []).map(g => branch ? { ...g, qty_balance: branchQty.get(g.id) ?? 0 } : g);

  // Revenue is before VAT: VAT is the government's money, and gross
  // profit (which the engine already works out without VAT) has to equal
  // revenue minus cost of goods on the P&L.
  const returnDays = returnTotalsQ.data ?? [];
  const exVat = (t: { total_amount: number; vat_amount?: number | null }) => (t.total_amount || 0) - (t.vat_amount || 0);
  const grossSales = sales.reduce((s, t) => s + exVat(t), 0);
  const returnsExVat = returnDays.reduce((s, r) => s + Number(r.subtotal || 0), 0);
  const totalSales = grossSales - returnsExVat;
  const totalCogs = sales.reduce((s, t) => s + (t.cogs || 0), 0)
    - returnDays.reduce((s, r) => s + Number(r.cogs_reversed || 0), 0);
  const grossProfit = totalSales - totalCogs;
  const vatCollected = sales.reduce((s, t) => s + (t.vat_amount || 0), 0)
    - returnDays.reduce((s, r) => s + Number(r.vat_amount || 0), 0);
  const totalOutstanding = salesOwing.reduce((s, t) => s + (t.balance || 0), 0);
  // VAT you can claim back on a receipt isn't a cost.
  const expenseCost = (e: { amount: number; vat_amount?: number }) => (e.amount || 0) - Number(e.vat_amount || 0);
  const totalExpenses = expenses.reduce((s, e) => s + expenseCost(e), 0);
  const extras = extrasQ.data;
  const stockLoss = Number(extras?.stock_loss || 0);
  // Positive = the tills came up short overall.
  const tillShort = Number(extras?.till_short || 0) - Number(extras?.till_over || 0);
  const netProfit = grossProfit - totalExpenses - stockLoss - tillShort;
  const costRows = stockCostQ.data ?? [];
  const costOf = new Map(costRows.filter(r => r.product_kind === 'finished_good').map(r => [r.product_id, Number(r.value_at_cost || 0)]));
  const stockValue = goods.reduce((s, g) => s + (costOf.get(g.id) ?? 0), 0);
  const stockAtPrice = goods.reduce((s, g) => s + g.selling_price * Math.max(0, g.qty_balance), 0);
  const materialsAtCost = costRows.filter(r => r.product_kind === 'material').reduce((s, r) => s + Number(r.value_at_cost || 0), 0);

  // Sales vs expenses, bucketed by day, month or year — sorted on a
  // zero-padded ISO-shaped key so it's chronological regardless of how the
  // label itself is localized (a plain localized string like "22 Sep"
  // doesn't sort correctly, especially once a range crosses a year).
  const periodBucket = (dateStr: string): { key: string; label: string } => {
    const d = new Date(dateStr);
    if (period === 'day') {
      return { key: dateStr, label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) };
    }
    if (period === 'year') {
      const y = String(d.getFullYear());
      return { key: y, label: y };
    }
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return { key, label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) };
  };
  const periodMap: Record<string, { label: string; sales: number; expenses: number }> = {};
  sales.forEach(s => {
    if (!s.transaction_date) return;
    const { key, label } = periodBucket(s.transaction_date);
    periodMap[key] = periodMap[key] || { label, sales: 0, expenses: 0 };
    periodMap[key].sales += exVat(s);
  });
  returnDays.forEach(r => {
    const { key, label } = periodBucket(r.return_date);
    periodMap[key] = periodMap[key] || { label, sales: 0, expenses: 0 };
    periodMap[key].sales -= Number(r.subtotal || 0);
  });
  expenses.forEach(e => {
    if (!e.expense_date) return;
    const { key, label } = periodBucket(e.expense_date);
    periodMap[key] = periodMap[key] || { label, sales: 0, expenses: 0 };
    periodMap[key].expenses += expenseCost(e);
  });
  const monthlySales = Object.entries(periodMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ month: v.label, sales: v.sales, expenses: v.expenses }));

  // Expense by type
  const typeName = (id: string | null) => expTypesQ.data?.find(t => t.id === id)?.name ?? 'Other';
  const expTypeMap: Record<string, number> = {};
  expenses.forEach(e => { const n = typeName(e.expense_type_id); expTypeMap[n] = (expTypeMap[n] || 0) + expenseCost(e); });
  const expenseByType = Object.entries(expTypeMap).map(([name, value]) => ({ name, value }));

  // Debtors: customers with outstanding balances
  const custName = (id: string | null) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Unknown' : 'Walk-in';
  };
  const debtorMap: Record<string, { id: string | null; name: string; phone: string | null; total: number; paid: number; balance: number; count: number }> = {};
  salesOwing.forEach(s => {
    const key = s.customer_id ?? 'walkin';
    const phone = custQ.data?.find(c => c.id === s.customer_id)?.phone ?? null;
    debtorMap[key] = debtorMap[key] || { id: s.customer_id, name: custName(s.customer_id), phone, total: 0, paid: 0, balance: 0, count: 0 };
    debtorMap[key].total += s.total_amount;
    debtorMap[key].paid += s.amount_paid;
    debtorMap[key].balance += s.balance;
    debtorMap[key].count += 1;
  });
  const debtors = Object.values(debtorMap).sort((a, b) => b.balance - a.balance);

  // Creditors: suppliers we still owe. Same shape as debtors, other direction.
  const suppName = (id: string | null) => {
    const x = suppQ.data?.find(v => v.id === id);
    return x ? `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() || x.company_store || 'Unknown' : 'No supplier';
  };
  const purchases = (purchQ.data ?? []).filter(pu => !pu.voided && inRange(pu.purchase_date) && inBranch(pu.branch_id));
  const purchasesOwing = (purchQ.data ?? []).filter(pu => !pu.voided && pu.balance > 0 && upTo(pu.purchase_date) && inBranch(pu.branch_id));
  const creditorMap: Record<string, { key: string; name: string; total: number; paid: number; balance: number; count: number }> = {};
  purchasesOwing.forEach(pu => {
    const key = pu.supplier_id ?? 'none';
    creditorMap[key] = creditorMap[key] || { key, name: suppName(pu.supplier_id), total: 0, paid: 0, balance: 0, count: 0 };
    creditorMap[key].total += pu.total_amount;
    creditorMap[key].paid += pu.total_paid;
    creditorMap[key].balance += pu.balance;
    creditorMap[key].count += 1;
  });
  const creditors = Object.values(creditorMap).sort((a, b) => b.balance - a.balance);
  const totalOwed = creditors.reduce((sum, c) => sum + c.balance, 0);

  const asOfLabel = to ? `up to ${to}` : 'up to today';

  // VAT by month: charged on sales (less returns) against VAT paid to
  // suppliers and on expenses that can be claimed back.
  const vatMonths: Record<string, { month: string; sales: number; purchases: number; expenses: number }> = {};
  const vatRow = (d: string) => {
    const k = d.slice(0, 7);
    return (vatMonths[k] = vatMonths[k] || { month: k, sales: 0, purchases: 0, expenses: 0 });
  };
  sales.forEach(t => { if (t.transaction_date && t.vat_amount) vatRow(t.transaction_date).sales += Number(t.vat_amount); });
  returnDays.forEach(r => { if (Number(r.vat_amount || 0)) vatRow(r.return_date).sales -= Number(r.vat_amount); });
  purchases.forEach(pu => { if (Number(pu.vat_amount || 0)) vatRow(pu.purchase_date).purchases += Number(pu.vat_amount); });
  expenses.forEach(e => { if (Number(e.vat_amount || 0)) vatRow(e.expense_date).expenses += Number(e.vat_amount); });
  const vatRows = Object.values(vatMonths).sort((a, b) => b.month.localeCompare(a.month))
    .map(r => ({ ...r, due: r.sales - r.purchases - r.expenses }));
  const vatDueTotal = vatRows.reduce((s, r) => s + r.due, 0);
  const monthName = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const productProfit = prodProfitQ.data ?? [];
  const productRevenue = productProfit.reduce((sum, r) => sum + Number(r.total_revenue || 0), 0);
  const productProfitTotal = productProfit.reduce((sum, r) => sum + Number(r.profit || 0), 0);

  const remindDebtor = async (d: { id: string | null; name: string; phone: string | null; balance: number }) => {
    if (!hasFeature(tenant, 'debt_reminders')) {
      toast.info('WhatsApp debt reminders are on the Growth plan and above. Upgrade under Settings → Billing.');
      return;
    }
    const message = paymentRequestMessage({
      businessName: tenant?.name ?? 'us', customerName: d.name, total: d.balance, bank: tenant?.bank_details,
    });
    window.open(whatsappLink(d.phone, message), '_blank');
    if (d.id) await customersApi.markReminded(d.id);
  };

  const rangeLabel = (from || to ? ` (${from || 'start'} → ${to || 'today'})` : '') + (branch ? ` — ${nameOf(branch)}` : '');

  // ---- Table column definitions (DataTable gives each one search, sort and paging) ----
  const salesCols: Column<any>[] = [
    { key: 'transaction_date', header: 'Date', value: r => r.transaction_date },
    { key: 'customer', header: 'Customer', value: r => custName(r.customer_id) },
    ...(multi && !branch ? [{ key: 'branch', header: 'Branch', value: (r: any) => nameOf(r.branch_id) } as Column<any>] : []),
    { key: 'total_amount', header: 'Total', align: 'right', value: r => r.total_amount, render: r => <strong>{fmt(r.total_amount)}</strong> },
    { key: 'amount_paid', header: 'Paid', align: 'right', value: r => r.amount_paid, render: r => fmt(r.amount_paid) },
    { key: 'balance', header: 'Balance', align: 'right', value: r => r.balance,
      render: r => <span style={{ color: r.balance > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{fmt(r.balance)}</span> },
    { key: 'gross_profit', header: 'Profit', align: 'right', value: r => r.gross_profit,
      render: r => <span style={{ color: '#16a34a', fontWeight: 600 }}>{fmt(r.gross_profit)}</span> },
  ];

  const expenseCols: Column<any>[] = [
    { key: 'expense_date', header: 'Date', value: r => r.expense_date },
    { key: 'type', header: 'Type', value: r => typeName(r.expense_type_id) },
    { key: 'description', header: 'Description', value: r => r.description ?? '—' },
    { key: 'amount', header: 'Amount', align: 'right', value: r => r.amount, render: r => <strong>{fmt(r.amount)}</strong> },
  ];

  const stockCols: Column<any>[] = [
    { key: 'name', header: 'Product', value: r => r.name, render: r => <strong>{r.name}</strong> },
    { key: 'qty_balance', header: 'Qty', align: 'right', value: r => r.qty_balance, render: r => r.qty_balance.toLocaleString() },
    { key: 'cost_value', header: 'Value at cost', align: 'right', value: r => costOf.get(r.id) ?? 0,
      render: r => <strong>{fmt(costOf.get(r.id) ?? 0)}</strong> },
    { key: 'price_value', header: 'At selling price', align: 'right', value: r => r.selling_price * Math.max(0, r.qty_balance),
      render: r => fmt(r.selling_price * Math.max(0, r.qty_balance)) },
  ];

  const vatCols: Column<any>[] = [
    { key: 'month', header: 'Month', value: r => r.month, render: r => <strong>{monthName(r.month)}</strong> },
    { key: 'sales', header: 'VAT charged on sales', align: 'right', value: r => r.sales, render: r => fmt(r.sales) },
    { key: 'purchases', header: 'VAT paid to suppliers', align: 'right', value: r => r.purchases, render: r => fmt(r.purchases) },
    { key: 'expenses', header: 'VAT on expenses', align: 'right', value: r => r.expenses, render: r => fmt(r.expenses) },
    { key: 'due', header: 'VAT to pay', align: 'right', value: r => r.due,
      render: r => r.due < 0
        ? <strong style={{ color: '#16a34a' }}>{fmt(-r.due)} to claim back</strong>
        : <strong>{fmt(r.due)}</strong> },
  ];

  const debtorCols: Column<any>[] = [
    { key: 'name', header: 'Customer', value: r => r.name, render: r => <strong>{r.name}</strong> },
    { key: 'count', header: 'Invoices', align: 'right', value: r => r.count },
    { key: 'total', header: 'Total', align: 'right', value: r => r.total, render: r => fmt(r.total) },
    { key: 'paid', header: 'Paid', align: 'right', value: r => r.paid, render: r => fmt(r.paid) },
    { key: 'balance', header: 'Outstanding', align: 'right', value: r => r.balance,
      render: r => <span style={{ color: '#dc2626', fontWeight: 700 }}>{fmt(r.balance)}</span> },
    { key: 'remind', header: '', sortable: false, align: 'right', value: () => '',
      render: r => (
        <button className="btn-secondary btn-sm" onClick={() => remindDebtor(r)} title="Send WhatsApp payment reminder">
          <MessageCircle size={14} /> Remind
        </button>
      ) },
  ];

  const creditorCols: Column<any>[] = [
    { key: 'name', header: 'Supplier', value: r => r.name, render: r => <strong>{r.name}</strong> },
    { key: 'count', header: 'Bills', align: 'right', value: r => r.count },
    { key: 'total', header: 'Total', align: 'right', value: r => r.total, render: r => fmt(r.total) },
    { key: 'paid', header: 'Paid', align: 'right', value: r => r.paid, render: r => fmt(r.paid) },
    { key: 'balance', header: 'Owed', align: 'right', value: r => r.balance,
      render: r => <span style={{ color: '#d97706', fontWeight: 700 }}>{fmt(r.balance)}</span> },
  ];

  const productCols: Column<any>[] = [
    { key: 'product_name', header: 'Product', value: r => r.product_name, render: r => <strong>{r.product_name}</strong> },
    { key: 'qty_sold', header: 'Qty Sold', align: 'right', value: r => Number(r.qty_sold), render: r => Number(r.qty_sold).toLocaleString() },
    { key: 'total_revenue', header: 'Revenue', align: 'right', value: r => Number(r.total_revenue), render: r => fmt(Number(r.total_revenue)) },
    { key: 'total_cogs', header: 'COGS', align: 'right', value: r => Number(r.total_cogs), render: r => fmt(Number(r.total_cogs)) },
    { key: 'profit', header: 'Gross Profit', align: 'right', value: r => Number(r.profit),
      render: r => <span style={{ fontWeight: 700, color: Number(r.profit) >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(Number(r.profit))}</span> },
    { key: 'margin_pct', header: 'Margin', align: 'right', value: r => Number(r.margin_pct),
      render: r => <span className={Number(r.margin_pct) >= 20 ? 'badge-success' : Number(r.margin_pct) > 0 ? 'badge-warning' : 'badge-danger'}>
        {Number(r.margin_pct).toFixed(1)}%
      </span> },
  ];

  const returnsData = returnsQ.data ?? [];
  const returnedValue = returnsData.reduce((s, r) => s + Number(r.value_returned || 0), 0);
  const returnedLoss = returnsData.reduce((s, r) => s + Number(r.loss_value || 0), 0);
  const returnCols: Column<any>[] = [
    { key: 'product_name', header: 'Product', value: r => r.product_name, render: r => <strong>{r.product_name}</strong> },
    { key: 'qty_returned', header: 'Qty Returned', align: 'right', value: r => Number(r.qty_returned), render: r => Number(r.qty_returned).toLocaleString() },
    { key: 'value_returned', header: 'Value', align: 'right', value: r => Number(r.value_returned), render: r => fmt(Number(r.value_returned)) },
    { key: 'resellable_qty', header: 'Resellable', align: 'right', value: r => Number(r.resellable_qty), render: r => Number(r.resellable_qty).toLocaleString() },
    { key: 'loss_value', header: 'Written Off', align: 'right', value: r => Number(r.loss_value),
      render: r => Number(r.loss_value) > 0 ? <span style={{ color: '#dc2626', fontWeight: 600 }}>{fmt(Number(r.loss_value))}</span> : '—' },
  ];

  const discountsData = discountsQ.data ?? [];
  const discountedValue = discountsData.reduce((s, r) => s + Number(r.discount_value || 0), 0);
  const discountCols: Column<any>[] = [
    { key: 'reason', header: 'Reason', value: r => r.reason, render: r => <strong>{r.reason}</strong> },
    { key: 'line_count', header: 'Lines', align: 'right', value: r => Number(r.line_count), render: r => Number(r.line_count).toLocaleString() },
    { key: 'qty', header: 'Qty', align: 'right', value: r => Number(r.qty), render: r => Number(r.qty).toLocaleString() },
    { key: 'discount_value', header: 'Discount Given', align: 'right', value: r => Number(r.discount_value),
      render: r => <span style={{ color: '#dc2626', fontWeight: 600 }}>{fmt(Number(r.discount_value))}</span> },
  ];

  // ---- Exports per tab ----
  const doExport = async (kind: 'xlsx' | 'pdf') => {
    let cols: ExportColumn<any>[] = [];
    let rows: any[] = [];
    let name: string = tab;
    let title = '';

    if (tab === 'pnl') {
      cols = [{ header: 'Item', value: r => r.item }, { header: 'Amount (₦)', value: r => r.amount }];
      rows = [
        { item: 'Sales (before VAT)', amount: grossSales },
        { item: 'Less returns', amount: -returnsExVat },
        { item: 'Revenue', amount: totalSales },
        { item: 'Cost of Goods Sold (COGS)', amount: -totalCogs },
        { item: 'Gross Profit', amount: grossProfit },
        { item: 'Operating Expenses', amount: -totalExpenses },
        ...(stockLoss !== 0 ? [{ item: 'Stock written off or lost (at cost)', amount: -stockLoss }] : []),
        ...(tillShort !== 0 ? [{ item: tillShort > 0 ? 'Till cash short' : 'Till cash over', amount: -tillShort }] : []),
        { item: 'Net Profit', amount: netProfit },
        ...(vatCollected !== 0 ? [{ item: 'VAT collected (owed to the tax office, not income)', amount: vatCollected }] : []),
      ];
      name = 'profit-and-loss'; title = 'Profit & Loss' + rangeLabel;
    } else if (tab === 'sales') {
      cols = [
        { header: 'Date', value: r => r.transaction_date },
        { header: 'Customer', value: r => custName(r.customer_id) },
        { header: 'Total', value: r => r.total_amount },
        { header: 'Paid', value: r => r.amount_paid },
        { header: 'Balance', value: r => r.balance },
        { header: 'COGS', value: r => r.cogs },
        { header: 'Profit', value: r => r.gross_profit },
        { header: 'Status', value: r => r.payment_status },
      ];
      rows = sales; name = 'sales-report'; title = 'Sales Report' + rangeLabel;
    } else if (tab === 'expenses') {
      cols = [
        { header: 'Date', value: r => r.expense_date },
        { header: 'Type', value: r => typeName(r.expense_type_id) },
        { header: 'Description', value: r => r.description ?? '' },
        { header: 'Amount', value: r => r.amount },
        { header: 'VAT included', value: r => Number(r.vat_amount || 0) },
      ];
      rows = expenses; name = 'expenses-report'; title = 'Expenses Report' + rangeLabel;
    } else if (tab === 'stock') {
      cols = [
        { header: 'Product', value: r => r.name },
        { header: 'Qty', value: r => r.qty_balance },
        { header: 'Value at cost', value: r => costOf.get(r.id) ?? 0 },
        { header: 'At selling price', value: r => r.selling_price * Math.max(0, r.qty_balance) },
      ];
      rows = goods; name = 'stock-report'; title = 'Stock Value Report' + (branch ? ` — ${nameOf(branch)}` : '');
    } else if (tab === 'debtors') {
      cols = [
        { header: 'Customer', value: r => r.name },
        { header: 'Invoices', value: r => r.count },
        { header: 'Total', value: r => r.total },
        { header: 'Paid', value: r => r.paid },
        { header: 'Outstanding', value: r => r.balance },
      ];
      rows = debtors; name = 'debtors-report'; title = `Owed to you, invoices ${asOfLabel}` + (branch ? ` — ${nameOf(branch)}` : '');
    } else if (tab === 'creditors') {
      cols = [
        { header: 'Supplier', value: r => r.name },
        { header: 'Bills', value: r => r.count },
        { header: 'Total', value: r => r.total },
        { header: 'Paid', value: r => r.paid },
        { header: 'Owed', value: r => r.balance },
      ];
      rows = creditors; name = 'creditors-report'; title = `You owe suppliers, bills ${asOfLabel}` + (branch ? ` — ${nameOf(branch)}` : '');
    } else if (tab === 'products') {
      cols = [
        { header: 'Product', value: r => r.product_name },
        { header: 'Qty Sold', value: r => r.qty_sold },
        { header: 'Revenue', value: r => r.total_revenue },
        { header: 'COGS', value: r => r.total_cogs },
        { header: 'Gross Profit', value: r => r.profit },
        { header: 'Margin %', value: r => r.margin_pct },
      ];
      rows = productProfit; name = 'product-profitability'; title = 'Product Profitability' + rangeLabel;
    } else if (tab === 'returns') {
      cols = [
        { header: 'Product', value: r => r.product_name },
        { header: 'Qty Returned', value: r => r.qty_returned },
        { header: 'Value', value: r => r.value_returned },
        { header: 'Resellable Qty', value: r => r.resellable_qty },
        { header: 'Written Off', value: r => r.loss_value },
      ];
      rows = returnsData; name = 'returns-report'; title = 'Returns' + rangeLabel;
    } else if (tab === 'vat') {
      cols = [
        { header: 'Month', value: r => monthName(r.month) },
        { header: 'VAT charged on sales', value: r => r.sales },
        { header: 'VAT paid to suppliers', value: r => r.purchases },
        { header: 'VAT on expenses', value: r => r.expenses },
        { header: 'VAT to pay', value: r => r.due },
      ];
      rows = vatRows; name = 'vat-report'; title = 'VAT' + rangeLabel;
    } else {
      cols = [
        { header: 'Reason', value: r => r.reason },
        { header: 'Lines', value: r => r.line_count },
        { header: 'Qty', value: r => r.qty },
        { header: 'Discount Given', value: r => r.discount_value },
      ];
      rows = discountsData; name = 'discounts-report'; title = 'Discounts' + rangeLabel;
    }

    try {
      if (kind === 'xlsx') await exportExcel(cols, rows, name);
      else await exportPDF(cols, rows, name, title);
    } catch {
      window.alert('Could not build the export file. Please try again.');
    }
  };

  if (loading) return <Loading label="Building reports…" />;
  if (error) return <ErrorState message={error} onRetry={() => { salesQ.refetch(); expQ.refetch(); goodsQ.refetch(); }} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Reports</h1><p>Business performance overview{rangeLabel}</p></div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-secondary" onClick={() => doExport('xlsx')}><Download size={15} /> Excel</button>
          <button className="btn-secondary" onClick={() => doExport('pdf')}><Download size={15} /> PDF</button>
        </div>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        {multi && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Branch</label>
            <select value={branch} onChange={e => setBranch(e.target.value)}>
              <option value="">All branches</option>
              {active.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        {(from || to || branch) && (
          <button className="btn-ghost btn-sm" style={{ marginBottom: 4 }} onClick={() => { setFrom(''); setTo(''); setBranch(''); }}>Clear</button>
        )}
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="stat-label">Revenue</div><div className="stat-value">{fmt(totalSales)}</div></div>
        <div className="stat-card"><div className="stat-label">Gross Profit</div><div className="stat-value" style={{ color: '#16a34a' }}>{fmt(grossProfit)}</div></div>
        <div className="stat-card"><div className="stat-label">Net Profit</div><div className="stat-value" style={{ color: netProfit >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(netProfit)}</div></div>
        <div className="stat-card"><div className="stat-label">Owed to you</div><div className="stat-value" style={{ color: '#dc2626' }}>{fmt(totalOutstanding)}</div></div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '0.6rem 1.1rem', background: 'none', border: 'none', cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400, color: tab === t.id ? '#2563eb' : '#64748b',
              borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
              fontSize: '0.875rem', marginBottom: '-1px' }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pnl' && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ marginBottom: '1rem' }}>Profit &amp; Loss{rangeLabel}</h3>
          {[
            ...(returnsExVat !== 0 ? [
              { label: 'Sales (before VAT)', value: grossSales },
              { label: 'Less returns', value: -returnsExVat },
            ] : []),
            { label: 'Revenue', value: totalSales, strong: returnsExVat !== 0 },
            { label: 'Cost of Goods Sold (COGS)', value: -totalCogs },
            { label: 'Gross Profit', value: grossProfit, strong: true },
            { label: 'Operating Expenses', value: -totalExpenses },
            ...(stockLoss !== 0 ? [{ label: 'Stock written off or lost (at cost)', value: -stockLoss }] : []),
            ...(tillShort !== 0 ? [{ label: tillShort > 0 ? 'Till cash short' : 'Till cash over', value: -tillShort }] : []),
            { label: 'Net Profit', value: netProfit, strong: true, final: true },
          ].map(row => (
            <div key={row.label} style={{
              display: 'flex', justifyContent: 'space-between', padding: '0.7rem 0',
              borderBottom: row.final ? 'none' : '1px solid #f1f5f9',
              borderTop: row.final ? '2px solid #e2e8f0' : 'none',
              fontWeight: row.strong ? 700 : 400,
            }}>
              <span>{row.label}</span>
              <span style={{ color: row.value < 0 ? '#dc2626' : row.strong ? (row.value >= 0 ? '#16a34a' : '#dc2626') : '#1e293b' }}>
                {row.value < 0 ? `(${fmt(Math.abs(row.value))})` : fmt(row.value)}
              </span>
            </div>
          ))}
          {stockLoss !== 0 && (
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.75rem' }}>
              Stock was taken off without a sale {extras?.stock_loss_count} time{extras?.stock_loss_count === 1 ? '' : 's'} in this period (expired, damaged, or a stock count came up short). It is counted at what it cost you.
            </p>
          )}
          {vatCollected !== 0 && (
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.75rem' }}>
              VAT collected in this period: <strong>{fmt(vatCollected)}</strong>. It is owed to the tax office, so it isn't counted as revenue.
            </p>
          )}
        </div>
      )}

      {tab === 'sales' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0 }}>Sales vs Expenses, by {period}</h3>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              {(['day', 'month', 'year'] as const).map(p => (
                <button key={p} type="button"
                  className={period === p ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                  onClick={() => setPeriod(p)}>
                  {p === 'day' ? 'Daily' : p === 'month' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
          </div>
          {monthlySales.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No data in this range.</p> : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={monthlySales}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v: any) => '₦' + (v / 1000) + 'k'} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: any) => fmt(v)} />
                <Bar dataKey="sales" name="Sales" fill="#2563eb" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#dc2626" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div style={{ marginTop: '1.5rem' }}>
            <DataTable
              columns={salesCols}
              rows={sales}
              getRowKey={r => r.id}
              searchKeys={[r => custName(r.customer_id), r => r.transaction_date ?? '', r => r.payment_status ?? '']}
              searchPlaceholder="Search by customer, date or status…"
              emptyMessage="No sales in this period."
            />
          </div>
        </div>
      )}

      {tab === 'expenses' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div className="card">
            <h3 style={{ marginBottom: '1rem' }}>Expenses by Type</h3>
            {expenseByType.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No expenses in this range.</p> : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={expenseByType} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90}
                    label={({ name, percent }: any) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}>
                    {expenseByType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => fmt(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="card">
            <h3 style={{ marginBottom: '1rem' }}>Expense Breakdown</h3>
            {expenseByType.map((e, i) => (
              <div key={e.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                  <span style={{ fontSize: '0.875rem' }}>{e.name}</span>
                </div>
                <strong style={{ fontSize: '0.875rem' }}>{fmt(e.value)}</strong>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', fontWeight: 700 }}>
              <span>Total</span><span>{fmt(totalExpenses)}</span>
            </div>
          </div>
          {/* The tab's export produces these rows, so they belong on screen too. */}
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 style={{ marginBottom: '1rem' }}>All Expenses{rangeLabel}</h3>
            <DataTable
              columns={expenseCols}
              rows={expenses}
              getRowKey={e => e.id}
              searchKeys={[e => typeName(e.expense_type_id), e => e.description ?? '', e => e.expense_date ?? '']}
              searchPlaceholder="Search by type, description or date…"
              emptyMessage="No expenses in this period."
            />
          </div>
        </div>
      )}

      {tab === 'stock' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>{label(retail, 'Finished Goods', 'Products')} stock at cost: {fmt(stockValue)}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            What the stock on hand cost you{branch ? ` at ${nameOf(branch)}` : ''}. At today's selling prices it would bring in {fmt(stockAtPrice)}.
            {materialsAtCost > 0 && <> Raw materials on hand cost {fmt(materialsAtCost)}.</>}
          </p>
          <DataTable
            columns={stockCols}
            rows={goods}
            getRowKey={g => g.id}
            searchKeys={[g => g.name]}
            searchPlaceholder="Search products…"
            emptyMessage={label(retail, 'No finished goods yet.', 'No products yet.')}
          />
        </div>
      )}

      {tab === 'debtors' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Owed to you: {fmt(totalOutstanding)}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Every unpaid invoice dated {asOfLabel}, however old. The From date doesn't hide older debts.
            {Number(extras?.store_credit_owed || 0) > 0 && <> You also owe {extras?.store_credit_customers} customer{extras?.store_credit_customers === 1 ? '' : 's'} {fmt(Number(extras?.store_credit_owed))} in store credit.</>}
          </p>
          <DataTable
            columns={debtorCols}
            rows={debtors}
            getRowKey={d => d.id ?? 'walkin'}
            searchKeys={[d => d.name]}
            searchPlaceholder="Search customers…"
            emptyMessage="Nobody owes you anything right now."
          />
        </div>
      )}

      {tab === 'creditors' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>You owe suppliers: {fmt(totalOwed)}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Every unpaid bill dated {asOfLabel}, however old.
          </p>
          <DataTable
            columns={creditorCols}
            rows={creditors}
            getRowKey={c => c.key}
            searchKeys={[c => c.name]}
            searchPlaceholder="Search suppliers…"
            emptyMessage="You don't owe any supplier right now."
          />
        </div>
      )}

      {tab === 'products' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Product Profitability{rangeLabel}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Margin per product, costed from the FIFO batches each sale actually consumed.
          </p>
          <DataTable
            columns={productCols}
            rows={productProfit}
            getRowKey={r => r.fg_id}
            loading={prodProfitQ.loading}
            error={prodProfitQ.error}
            onRetry={prodProfitQ.refetch}
            searchKeys={[r => r.product_name]}
            searchPlaceholder="Search products…"
            emptyMessage="No sales in this period yet."
          />
          {productProfit.length > 0 && (
            <p style={{ marginTop: '0.9rem', fontSize: '0.9rem', color: '#475569' }}>
              Across {productProfit.length} product{productProfit.length !== 1 ? 's' : ''}:{' '}
              <strong>{fmt(productRevenue)}</strong> revenue,{' '}
              <strong style={{ color: productProfitTotal >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(productProfitTotal)}</strong> gross profit
              {productRevenue > 0 && <> ({((productProfitTotal / productRevenue) * 100).toFixed(1)}% blended margin)</>}.
            </p>
          )}
        </div>
      )}

      {tab === 'returns' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Returns{rangeLabel}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Counted by the day the return happened, not the day of the original sale.
          </p>
          <DataTable
            columns={returnCols}
            rows={returnsData}
            getRowKey={r => r.fg_id}
            loading={returnsQ.loading}
            error={returnsQ.error}
            onRetry={returnsQ.refetch}
            searchKeys={[r => r.product_name]}
            searchPlaceholder="Search products…"
            emptyMessage="No returns in this period."
          />
          {returnsData.length > 0 && (
            <p style={{ marginTop: '0.9rem', fontSize: '0.9rem', color: '#475569' }}>
              {fmt(returnedValue)} returned across {returnsData.length} product{returnsData.length !== 1 ? 's' : ''}
              {returnedLoss > 0 && <>, of which <strong style={{ color: '#dc2626' }}>{fmt(returnedLoss)}</strong> was written off as damaged or expired</>}.
            </p>
          )}
        </div>
      )}

      {tab === 'discounts' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Discounts{rangeLabel}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Grouped by the reason given at the till or on the sale — order-level discounts aren't broken out here yet.
          </p>
          <DataTable
            columns={discountCols}
            rows={discountsData}
            getRowKey={r => r.reason}
            loading={discountsQ.loading}
            error={discountsQ.error}
            onRetry={discountsQ.refetch}
            searchKeys={[r => r.reason]}
            searchPlaceholder="Search reasons…"
            emptyMessage="No discounts given in this period."
          />
          {discountsData.length > 0 && (
            <p style={{ marginTop: '0.9rem', fontSize: '0.9rem', color: '#475569' }}>
              <strong style={{ color: '#dc2626' }}>{fmt(discountedValue)}</strong> given away across {discountsData.length} reason{discountsData.length !== 1 ? 's' : ''}.
            </p>
          )}
        </div>
      )}

      {tab === 'vat' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>VAT{rangeLabel}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            VAT you charged customers, less the VAT you paid suppliers and on expenses, month by month. Add a supplier's VAT on the purchase, and an expense's VAT when you log it, so it counts here.
          </p>
          <DataTable
            columns={vatCols}
            rows={vatRows}
            getRowKey={r => r.month}
            searchKeys={[r => monthName(r.month)]}
            searchPlaceholder="Search months…"
            emptyMessage="No VAT in this period."
          />
          {vatRows.length > 0 && (
            <p style={{ marginTop: '0.9rem', fontSize: '0.9rem', color: '#475569' }}>
              {vatDueTotal >= 0
                ? <>VAT to pay for this period: <strong>{fmt(vatDueTotal)}</strong>.</>
                : <>You paid <strong style={{ color: '#16a34a' }}>{fmt(-vatDueTotal)}</strong> more VAT than you charged in this period.</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
