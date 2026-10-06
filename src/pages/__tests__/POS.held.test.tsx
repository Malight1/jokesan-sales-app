import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import POS from '../POS';
import { holdSale, listHeld } from '../../lib/heldSales';

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
let mockProfile: any = { id: 'u-amaka', full_name: 'Amaka Obi', role: 'sales', branch_id: 'b1' };

jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('../../lib/AuthContext', () => ({
  useAuth: () => ({
    tenant: { id: 't1', name: 'Mama Tolu Stores', plan: 'starter', vat_enabled: false, vat_rate: 0, type: 'single' },
    profile: mockProfile,
  }),
}));
jest.mock('../../lib/ToastContext', () => ({ useToast: () => mockToast }));
jest.mock('../../lib/useBranches', () => ({ useBranches: () => ({ multi: false, myBranchId: 'b1', myBranchName: 'Main' }) }));
jest.mock('../../lib/useTillGate', () => ({ useTillGate: () => ({ blocked: false, shift: null, refetch: jest.fn() }) }));
jest.mock('../Sales', () => ({ ReturnModal: () => null }));

const mockGoods = [
  { id: 'bread', name: 'Agege Bread (loaf)', unit: 'loaf', qty_balance: 6, min_stock_level: 2, default_markup: 1.4, selling_price: 1200, barcode: null },
  { id: 'milk', name: 'Peak Milk 400g (carton)', unit: 'carton', qty_balance: 6, min_stock_level: 2, default_markup: 1.4, selling_price: 18000, barcode: null },
];
let mockStock: Record<string, number> = {};
const mockLevel = (id: string) => ({
  branch_id: 'b1', branch_name: 'Main', product_kind: 'finished_good', product_id: id,
  name: id, unit: null, qty: mockStock[id], min_level: 2, sellable_qty: mockStock[id],
});

jest.mock('../../lib/api', () => ({
  sales: { create: jest.fn(), docNo: jest.fn(), findByDocNo: jest.fn() },
  finishedGoods: { list: () => Promise.resolve(mockGoods) },
  customers: { list: () => Promise.resolve([]) },
  lookups: { paymentTypes: () => Promise.resolve([{ id: 'cash', name: 'Cash' }, { id: 'credit', name: 'Credit' }]) },
  branding: { toDataUrl: jest.fn() },
  stock: { levels: () => Promise.resolve(Object.keys(mockStock).map(mockLevel)) },
  pricing: { lists: () => Promise.resolve([]), allItems: () => Promise.resolve([]), customerTypes: () => Promise.resolve([]) },
  productUnits: { list: () => Promise.resolve([]) },
}));

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });
beforeEach(() => {
  localStorage.clear();
  mockStock = { bread: 6, milk: 6 };
  mockProfile = { id: 'u-amaka', full_name: 'Amaka Obi', role: 'sales', branch_id: 'b1' };
  Object.values(mockToast).forEach(f => f.mockClear());
});

const tile = (name: RegExp) => screen.findByRole('button', { name });
const qtyOf = (name: string) => within(screen.getByRole('group', { name: `Quantity of ${name}` })).getByText(/^\d+$/).textContent;

describe('holding a sale at the till', () => {
  it('parks the basket, serves the next customer, then resumes it', async () => {
    render(<POS />);
    fireEvent.click(await tile(/^Agege Bread/));
    fireEvent.click(await tile(/^Agege Bread/));
    expect(qtyOf('Agege Bread (loaf)')).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Hold this sale' }));
    expect(screen.queryByRole('group', { name: /Quantity of/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Held sales, 1' })).toBeInTheDocument();
    expect(listHeld('t1', 'b1')[0]).toMatchObject({ label: 'Walk-in', total: 2400 });

    // Next customer.
    fireEvent.click(await tile(/^Peak Milk/));
    expect(qtyOf('Peak Milk 400g (carton)')).toBe('1');

    // Resuming swaps: the bread comes back, the milk sale goes on hold.
    fireEvent.click(screen.getByRole('button', { name: 'Held sales, 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(qtyOf('Agege Bread (loaf)')).toBe('2');
    expect(screen.queryByRole('group', { name: 'Quantity of Peak Milk 400g (carton)' })).toBeNull();
    const held = listHeld('t1', 'b1');
    expect(held).toHaveLength(1);
    expect(held[0].lines[0]).toMatchObject({ goodId: 'milk', qty: 1 });
    expect(mockToast.success).toHaveBeenLastCalledWith(expect.stringMatching(/now held/));
  });

  it('trims a held basket to the stock that is actually left', async () => {
    holdSale('t1', 'b1', {
      customerId: '', label: 'Walk-in', orderDiscount: 0, total: 3600,
      lines: [{ goodId: 'bread', name: 'Agege Bread (loaf)', qty: 3, unitPrice: 1200 }],
    });
    mockStock = { bread: 1, milk: 6 };
    render(<POS />);
    await tile(/^Agege Bread/);
    fireEvent.click(screen.getByRole('button', { name: 'Held sales, 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(qtyOf('Agege Bread (loaf)')).toBe('1');
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/Cut to what's left: Agege Bread/));
  });

  it('needs a second tap to discard a held sale', async () => {
    holdSale('t1', 'b1', {
      customerId: '', label: 'Walk-in', orderDiscount: 0, total: 1200,
      lines: [{ goodId: 'bread', name: 'Agege Bread (loaf)', qty: 1, unitPrice: 1200 }],
    });
    render(<POS />);
    await tile(/^Agege Bread/);
    fireEvent.click(screen.getByRole('button', { name: 'Held sales, 1' }));
    fireEvent.click(screen.getByRole('button', { name: "Discard Walk-in's sale" }));
    expect(listHeld('t1', 'b1')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: "Tap again to discard Walk-in's sale" }));
    expect(listHeld('t1', 'b1')).toHaveLength(0);
  });

  it('shows who held a basket when two cashiers share the device', async () => {
    const first = render(<POS />);
    fireEvent.click(await tile(/^Agege Bread/));
    fireEvent.click(screen.getByRole('button', { name: 'Hold this sale' }));
    expect(listHeld('t1', 'b1')[0].heldBy).toEqual({ id: 'u-amaka', name: 'Amaka Obi' });
    fireEvent.click(screen.getByRole('button', { name: 'Held sales, 1' }));
    expect(screen.getByText(/held by you/)).toBeInTheDocument();
    first.unmount();

    // Shift change: Tunde signs in on the same phone.
    mockProfile = { id: 'u-tunde', full_name: 'Tunde Bello', role: 'sales', branch_id: 'b1' };
    render(<POS />);
    await tile(/^Agege Bread/);
    fireEvent.click(screen.getByRole('button', { name: 'Held sales, 1' }));
    expect(screen.getByText(/held by Amaka Obi/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(qtyOf('Agege Bread (loaf)')).toBe('1');
    expect(mockToast.success).toHaveBeenLastCalledWith(expect.stringMatching(/held by Amaka Obi/));
  });
});
