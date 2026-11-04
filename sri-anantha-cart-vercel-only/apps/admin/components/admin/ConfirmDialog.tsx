'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from '@sac/ui-web';

/**
 * Confirmation step for actions that are hard to undo. With `typeToConfirm`, the confirm button
 * unlocks only after the exact text (e.g. the product name) is typed.
 */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'primary', typeToConfirm, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; typeToConfirm?: string;
  onConfirm: (typed: string) => Promise<void> | void; onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = !typeToConfirm || typed.trim() === typeToConfirm;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try { await onConfirm(typed.trim()); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={submit}>
        <div className="modal-body confirm-body">
          {children}
          {typeToConfirm && (
            <label className="field" htmlFor="confirm-text"><span>Type <strong>{typeToConfirm}</strong> to confirm</span>
              <input id="confirm-text" className="input" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" />
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !ready}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
