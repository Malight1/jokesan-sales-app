import { sales } from '../api';
import { enqueueSale, enqueuePayment, flushQueue, getQueue } from '../offlineQueue';

jest.mock('../api', () => ({ sales: { create: jest.fn(), addPayment: jest.fn() } }));

const mockSales = sales as unknown as { create: jest.Mock; addPayment: jest.Mock };

const salePayload = {
  customerId: null, date: '2026-09-12', paymentTypeId: null, amountPaid: 600,
  items: [{ finished_good_id: 'soap', quantity: 10, unit_price: 60 }], branchId: 'lagos',
};

beforeEach(() => {
  localStorage.clear();
  mockSales.create.mockReset().mockResolvedValue('sale-id');
  mockSales.addPayment.mockReset().mockResolvedValue(undefined);
});

describe('offline queue', () => {
  it('replays a queued sale through create_sale', async () => {
    enqueueSale(salePayload, '10 soap');
    const res = await flushQueue();
    expect(res).toEqual({ synced: 1, failed: 0 });
    expect(mockSales.create).toHaveBeenCalledWith(salePayload);
    expect(getQueue()).toHaveLength(0);
  });

  it('replays a queued payment as a payment, never as a sale', async () => {
    enqueuePayment({ saleId: 's1', amount: 5000, paymentTypeId: 'cash' }, 'Payment ₦5,000');
    await flushQueue();
    expect(mockSales.addPayment).toHaveBeenCalledWith('s1', 5000, 'cash');
    expect(mockSales.create).not.toHaveBeenCalled();
  });

  it('keeps a rejected item for the cashier and carries on with the rest', async () => {
    mockSales.addPayment.mockRejectedValueOnce(new Error('That payment is more than the ₦2,000 still owed.'));
    enqueuePayment({ saleId: 's1', amount: 5000, paymentTypeId: null }, 'Payment');
    enqueueSale(salePayload, 'Sale');
    const res = await flushQueue();
    expect(res).toEqual({ synced: 1, failed: 1 });
    const left = getQueue();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ type: 'sale_payment', status: 'failed', failReason: expect.stringMatching(/more than/) });
  });

  it('still syncs sales queued by the previous version of the app', async () => {
    localStorage.setItem('sf_offline_queue', JSON.stringify([
      { id: 'q_old', type: 'sale', createdAt: 1, payload: salePayload, status: 'pending', label: 'old' },
    ]));
    const res = await flushQueue();
    expect(res.synced).toBe(1);
    expect(mockSales.create).toHaveBeenCalledWith(salePayload);
  });

  it('fails loudly on something it does not know how to replay', async () => {
    localStorage.setItem('sf_offline_queue', JSON.stringify([
      { id: 'q_new', type: 'return', createdAt: 1, payload: {}, status: 'pending', label: 'future item' },
    ]));
    const res = await flushQueue();
    expect(res.failed).toBe(1);
    expect(getQueue()[0].status).toBe('failed');
  });
});
