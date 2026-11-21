import React, { useState } from 'react';
import { Wallet, ArrowLeftRight, ClipboardList, Lock } from 'lucide-react';
import Modal from './Modal';
import CashMovementModal from './CashMovementModal';
import CloseTillModal from './CloseTillModal';
import { shifts as shiftsApi, ShiftReport } from '../lib/api';
import './TillPanels.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// The till bar shown above POS once a shift is open: when it opened, and
// the three things a cashier does with the drawer. Closing the till is a
// button of its own, not tucked in a menu, so nobody has to hunt for it.
export default function TillHeader({ shift, onChanged }: { shift: ShiftReport; onChanged: () => void }) {
  const [showCash, setShowCash] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [showX, setShowX] = useState(false);
  const [xReport, setXReport] = useState<ShiftReport | null>(null);
  const [xError, setXError] = useState<string | null>(null);

  const openedAt = new Date(shift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const viewX = async () => {
    setShowX(true);
    setXReport(null);
    setXError(null);
    try { setXReport(await shiftsApi.xReport(shift.shift_id)); }
    catch (e: any) { setXError(e.message ?? String(e)); }
  };

  return (
    <div className="till-header">
      <span className="till-status"><Wallet size={15} aria-hidden="true" /> Till open since {openedAt}</span>
      <div className="till-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={() => setShowCash(true)}>
          <ArrowLeftRight size={15} aria-hidden="true" /> Pay in / out
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={viewX}>
          <ClipboardList size={15} aria-hidden="true" /> X report
        </button>
        <button type="button" className="btn-primary btn-sm" onClick={() => setShowClose(true)}>
          <Lock size={15} aria-hidden="true" /> Close till
        </button>
      </div>

      {showCash && <CashMovementModal onClose={() => setShowCash(false)} onDone={onChanged} />}
      {showClose && <CloseTillModal onClose={() => setShowClose(false)} onDone={onChanged} />}

      {showX && (
        <Modal onClose={() => setShowX(false)} maxWidth={380}>
          <div className="modal-header"><h2>X report</h2></div>
          <div className="modal-body">
            {xError && <p style={{ color: '#dc2626' }}>{xError}</p>}
            {!xError && !xReport && <p>Loading…</p>}
            {xReport && (
              <>
                <div className="till-close-figures">
                  <div><span>Opening float</span><strong>{fmt(xReport.opening_float)}</strong></div>
                  <div><span>Sales</span><strong>{fmt(xReport.sales_total)}</strong></div>
                  <div><span>Expected cash</span><strong>{fmt(xReport.expected.cash)}</strong></div>
                </div>
                <p className="till-close-summary">
                  {xReport.sales_count} sale{xReport.sales_count === 1 ? '' : 's'} so far this till
                  {xReport.refunds_total ? ` · ${fmt(xReport.refunds_total)} refunded` : ''}
                </p>
              </>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-primary" onClick={() => setShowX(false)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
