import React, { useState } from 'react';
import { FileText, CheckCircle2, XCircle, Send } from 'lucide-react';
import {
  deliveries as deliveriesApi, sales as salesApi, customers as customersApi, finishedGoods as goodsApi, branding,
  Delivery, DeliveryStatus, SalesOrder, Customer, FinishedGood,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateWaybillPdf } from '../lib/invoice';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import Modal from '../components/Modal';

const STATUS_BADGE: Record<DeliveryStatus, string> = {
  pending: 'badge-gray', dispatched: 'badge-primary', delivered: 'badge-success', failed: 'badge-danger',
};

export default function Deliveries() {
  const toast = useToast();
  const { tenant } = useAuth();
  const { data: rows, loading, error, refetch } = useQuery<Delivery[]>(() => deliveriesApi.list(), [], { cacheKey: 'deliveries-list' });
  const { data: sales } = useQuery<SalesOrder[]>(() => salesApi.list(), [], { cacheKey: 'deliveries-sales' });
  const { data: customers } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'deliveries-customers' });
  const { data: goods } = useQuery<FinishedGood[]>(() => goodsApi.list(), [], { cacheKey: 'deliveries-goods' });

  const [dispatchFor, setDispatchFor] = useState<Delivery | null>(null);
  const [deliverFor, setDeliverFor] = useState<Delivery | null>(null);
  const [failFor, setFailFor] = useState<Delivery | null>(null);

  const saleFor = (id: string) => sales?.find(s => s.id === id);
  const customerName = (id: string | null | undefined) => {
    const c = customers?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };
  const invoiceNo = (id: string) => saleFor(id)?.doc_no || 'INV-' + id.slice(0, 8).toUpperCase();

  const downloadWaybill = async (d: Delivery) => {
    try {
      const detail = await deliveriesApi.detail(d.id);
      const so = saleFor(d.sales_order_id);
      const saleDetail = await salesApi.detail(d.sales_order_id);
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      const itemsById = new Map<string, any>((saleDetail.sale_items ?? []).map((i: any) => [i.id, i]));
      await generateWaybillPdf({
        companyName: tenant?.name ?? 'My Business',
        docNo: d.doc_no ?? d.id.slice(0, 8).toUpperCase(),
        date: d.created_at.split('T')[0],
        customerName: customerName(so?.customer_id),
        destination: d.destination,
        driverName: d.driver_name,
        vehicleNo: d.vehicle_no,
        note: d.note,
        items: (detail.delivery_items ?? []).map((di: any) => {
          const si = itemsById.get(di.sale_item_id);
          const g = goods?.find(x => x.id === si?.finished_good_id);
          return { name: g?.name ?? 'Item', qty: di.qty, unit: g?.unit };
        }),
        tin: tenant?.tin, logoDataUrl: logo,
      });
    } catch (e: any) {
      toast.error(e.message ?? 'Could not generate the waybill.');
    }
  };

  const columns: Column<Delivery>[] = [
    { key: 'doc_no', header: 'No.', value: d => d.doc_no ?? '', render: d => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{d.doc_no}</span> },
    { key: 'sale', header: 'Invoice', value: d => invoiceNo(d.sales_order_id) },
    { key: 'customer', header: 'Customer', value: d => customerName(saleFor(d.sales_order_id)?.customer_id) },
    { key: 'destination', header: 'Destination', value: d => d.destination ?? '—' },
    { key: 'driver', header: 'Driver', value: d => d.driver_name ?? '—' },
    { key: 'status', header: 'Status', value: d => d.status, render: d => <span className={STATUS_BADGE[d.status]}>{d.status}</span> },
  ];

  const rowActions: RowAction<Delivery>[] = [
    { icon: <Send size={15} />, label: 'Dispatch', onClick: setDispatchFor, show: d => d.status === 'pending' },
    { icon: <CheckCircle2 size={15} />, label: 'Mark delivered', onClick: setDeliverFor, show: d => d.status === 'dispatched' },
    { icon: <FileText size={15} />, label: 'Download waybill', onClick: downloadWaybill },
    { icon: <XCircle size={15} />, label: 'Mark failed', onClick: setFailFor, show: d => d.status === 'pending' || d.status === 'dispatched', variant: 'danger' },
  ];

  if (loading) return <Loading label="Loading deliveries…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Deliveries</h1>
          <p>Waybills and delivery status — stock already left at the point of sale; this just tracks what happens after</p>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows ?? []}
        getRowKey={d => d.id}
        rowActions={rowActions}
        searchKeys={[d => d.doc_no ?? '', d => d.destination ?? '', d => d.driver_name ?? '']}
        searchPlaceholder="Search deliveries…"
        emptyMessage='No delivery notes yet — create one from a sale via "Create delivery note".'
      />

      {dispatchFor && (
        <DispatchModal delivery={dispatchFor} onClose={() => setDispatchFor(null)} onDone={() => { setDispatchFor(null); refetch(); }} />
      )}
      {deliverFor && (
        <DeliverModal delivery={deliverFor} tenantId={tenant?.id ?? ''} onClose={() => setDeliverFor(null)} onDone={() => { setDeliverFor(null); refetch(); }} />
      )}
      {failFor && (
        <FailModal delivery={failFor} onClose={() => setFailFor(null)} onDone={() => { setFailFor(null); refetch(); }} />
      )}
    </div>
  );
}

function DispatchModal({ delivery, onClose, onDone }: { delivery: Delivery; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [driverName, setDriverName] = useState(delivery.driver_name ?? '');
  const [vehicleNo, setVehicleNo] = useState(delivery.vehicle_no ?? '');
  const mut = useMutation(deliveriesApi.dispatch);

  const submit = async () => {
    const res = await mut.mutate(delivery.id, driverName.trim() || null, vehicleNo.trim() || null);
    if (res !== null) { toast.success(`${delivery.doc_no} dispatched.`); onDone(); }
    else toast.error(mut.error ?? 'Could not dispatch.');
  };

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header"><h2>Dispatch {delivery.doc_no}</h2></div>
      <div className="modal-body">
        {mut.error && <ErrorState message={mut.error} />}
        <div className="form-group"><label>Driver</label><input value={driverName} onChange={e => setDriverName(e.target.value)} /></div>
        <div className="form-group"><label>Vehicle No.</label><input value={vehicleNo} onChange={e => setVehicleNo(e.target.value)} /></div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={mut.pending} onClick={submit}>{mut.pending ? 'Saving…' : 'Dispatch'}</button>
      </div>
    </Modal>
  );
}

function DeliverModal({ delivery, tenantId, onClose, onDone }: { delivery: Delivery; tenantId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [receivedBy, setReceivedBy] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation(deliveriesApi.markDelivered);

  const submit = async () => {
    setUploading(true);
    setError(null);
    try {
      let proofUrl: string | null = null;
      if (file) proofUrl = await deliveriesApi.uploadProof(tenantId, delivery.id, file);
      const res = await mut.mutate(delivery.id, receivedBy.trim() || null, proofUrl);
      if (res !== null) { toast.success(`${delivery.doc_no} marked delivered.`); onDone(); }
      else setError(mut.error ?? 'Could not update.');
    } catch (e: any) {
      setError(e.message ?? 'Could not upload the proof photo.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header"><h2>Mark {delivery.doc_no} delivered</h2></div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <div className="form-group"><label>Received by</label><input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} placeholder="Name on the ground" /></div>
        <div className="form-group">
          <label>Proof of delivery (optional photo)</label>
          <input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={uploading || mut.pending} onClick={submit}>
          {uploading || mut.pending ? 'Saving…' : 'Mark Delivered'}
        </button>
      </div>
    </Modal>
  );
}

function FailModal({ delivery, onClose, onDone }: { delivery: Delivery; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const mut = useMutation(deliveriesApi.markFailed);

  const submit = async () => {
    const res = await mut.mutate(delivery.id, note.trim() || null);
    if (res !== null) { toast.success(`${delivery.doc_no} marked failed.`); onDone(); }
    else toast.error(mut.error ?? 'Could not update.');
  };

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header"><h2>Mark {delivery.doc_no} failed</h2></div>
      <div className="modal-body">
        {mut.error && <ErrorState message={mut.error} />}
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          Whatever this note claimed can be put on a new delivery note afterwards.
        </p>
        <div className="form-group"><label>Reason</label><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. truck broke down" /></div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={mut.pending} onClick={submit}>{mut.pending ? 'Saving…' : 'Mark Failed'}</button>
      </div>
    </Modal>
  );
}
