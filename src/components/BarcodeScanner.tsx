import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Keyboard } from 'lucide-react';
import Modal from './Modal';

// Camera barcode/QR scanner using the phone's camera. Falls back to a
// manual text entry field if the camera can't start (permission denied,
// desktop with no webcam, etc.) so scanning never blocks the workflow.
export default function BarcodeScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const regionRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<any>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let cancelled = false;

    import('html5-qrcode').then(({ Html5Qrcode }) => {
      if (cancelled || !regionRef.current) return;
      const scanner = new Html5Qrcode(regionRef.current.id);
      scannerRef.current = scanner;

      scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (decodedText: string) => {
          onScan(decodedText);
          stop();
        },
        () => { /* per-frame decode misses — expected while aiming, ignore */ }
      ).then(() => setStarting(false))
        .catch((err: any) => {
          setStarting(false);
          setCameraError(err?.message ?? 'Could not access camera.');
        });
    });

    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    const s = scannerRef.current;
    if (s && s.isScanning) {
      s.stop().then(() => s.clear()).catch(() => {});
    }
  };

  const handleClose = () => { stop(); onClose(); };

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode.trim()) { onScan(manualCode.trim()); handleClose(); }
  };

  return (
    <Modal onClose={handleClose} maxWidth={420}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Camera size={18} /> Scan Barcode</h2>
          <button className="close-btn" onClick={handleClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {!cameraError && (
            <div id="barcode-scan-region" ref={regionRef} style={{ width: '100%', minHeight: 220, borderRadius: 8, overflow: 'hidden', background: '#0f172a' }} />
          )}
          {starting && !cameraError && <p style={{ fontSize: '0.8rem', color: '#94a3b8', textAlign: 'center', marginTop: 8 }}>Starting camera…</p>}
          {cameraError && (
            <div className="alert alert-warning" style={{ fontSize: '0.82rem', marginBottom: '0.75rem' }}>
              Couldn't access the camera ({cameraError}). Type the barcode instead.
            </div>
          )}
          <form onSubmit={submitManual} style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Keyboard size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              <input value={manualCode} onChange={e => setManualCode(e.target.value)} placeholder="Or type barcode number…"
                style={{ width: '100%', padding: '0.5rem 0.6rem 0.5rem 2rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.9rem' }} />
            </div>
            <button type="submit" className="btn-primary btn-sm">Use</button>
          </form>
        </div>
    </Modal>
  );
}
