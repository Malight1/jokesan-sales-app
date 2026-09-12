import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardView } from '../Dashboard';
import { cashierFixture, inventoryFixture, ownerFixture } from '../../dev/dashboardFixtures';
import { DashboardSummary } from '../../lib/api';

jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('../../lib/AuthContext', () => ({
  useAuth: () => ({ profile: { role: 'sales', full_name: 'Amaka Obi' }, tenant: { name: 'Jokesan' } }),
}));
jest.mock('../../lib/ToastContext', () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn() }),
}));

// Recharts' ResponsiveContainer measures with ResizeObserver, which jsdom lacks.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
(global as any).ResizeObserver = (global as any).ResizeObserver ?? NoopResizeObserver;

const renderView = (d: DashboardSummary) =>
  render(<MemoryRouter><DashboardView d={d} onRefresh={() => {}} /></MemoryRouter>);

describe('role dashboards', () => {
  it('cashier gets a till: their own takings and two big actions', () => {
    renderView(cashierFixture);
    expect(screen.getByText('Your sales today')).toBeInTheDocument();
    expect(screen.getByText('₦64,300')).toBeInTheDocument();
    expect(screen.getByText(/Good (morning|afternoon|evening), Amaka/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new sale/i })).toHaveAttribute('href', '/pos');
    expect(screen.getByRole('link', { name: /record a payment/i })).toHaveAttribute('href', '/sales');
  });

  it('cashier never sees company profit or expenses', () => {
    const { container } = renderView(cashierFixture);
    expect(container.textContent).not.toMatch(/gross profit|expenses|owe suppliers/i);
  });

  it('cashier compares today with yesterday in words, not just colour', () => {
    renderView(cashierFixture);
    expect(screen.getByText(/Up 15% on yesterday/)).toBeInTheDocument();
  });

  it('storekeeper gets shelf health and a reorder list with a next step per item', () => {
    renderView(inventoryFixture);
    expect(screen.getByText(/below reorder level/i)).toBeInTheDocument();
    expect(screen.getByText('healthy', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Buy' })[0]).toHaveAttribute('href', '/purchases');
    expect(screen.getAllByRole('link', { name: 'Produce' })[0]).toHaveAttribute('href', '/production');
  });

  it('storekeeper screen carries no money at all', () => {
    const { container } = renderView(inventoryFixture);
    expect(container.textContent).not.toMatch(/₦/);
  });

  it('owner compares this month with the same days last month', () => {
    renderView(ownerFixture);
    expect(screen.getByText(/on the same days last month/)).toBeInTheDocument();
    expect(screen.getByText('31.1% of sales')).toBeInTheDocument();
  });

  it('owner sees a branch table only when the company has branches', () => {
    renderView(ownerFixture);
    expect(screen.getByText('Branches this month')).toBeInTheDocument();
  });

  it('single-location owner gets no branch table', () => {
    renderView({ ...ownerFixture, multi_branch: false });
    expect(screen.queryByText('Branches this month')).not.toBeInTheDocument();
  });

  it.each([
    ['cashier', cashierFixture],
    ['storekeeper', inventoryFixture],
    ['owner', ownerFixture],
  ])('%s dashboard has no em or en dashes in visible text', (_name, fixture) => {
    const { container } = renderView(fixture);
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  it('shows friendly empty states rather than blank panels', () => {
    renderView({ ...cashierFixture, my_recent: [], week_trend: [], low_stock: [], low_goods_count: 0 });
    expect(screen.getByText('Sales you ring up will appear here.')).toBeInTheDocument();
    expect(screen.getByText('No sales in the last 7 days yet.')).toBeInTheDocument();
    expect(screen.getByText('Every product is above its reorder level.')).toBeInTheDocument();
  });
});
