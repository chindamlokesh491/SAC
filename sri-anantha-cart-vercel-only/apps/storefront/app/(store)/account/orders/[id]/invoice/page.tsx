'use client';

import type { Invoice } from '@sac/contracts';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InvoiceView } from '@sac/ui-web';
import { api } from '@/lib/api';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.invoice(id).then(setInvoice).catch(() => setError('Invoice is not available for this order.')); }, [id]);
  if (error) return <div className="container empty" style={{ margin: '40px auto' }}>{error}</div>;
  if (!invoice) return <div className="container" style={{ padding: 40 }}><div className="skeleton" style={{ height: 400 }} /></div>;
  return <InvoiceView invoice={invoice} />;
}
