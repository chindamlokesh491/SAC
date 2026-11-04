'use client';

import type { Invoice } from '@sac/contracts';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { InvoiceView } from '@sac/ui-web';

export default function AdminInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { request } = useAdmin();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { request<{ data: Invoice }>(`/api/v1/admin/orders/${id}/invoice`).then(result => setInvoice(result.data)).catch(err => setError(adminError(err))); }, [id, request]);
  if (error) return <div className="empty">{error}</div>;
  if (!invoice) return <div className="skeleton" style={{ height: 400 }} />;
  return <><style>{'@media print { .admin-side, .admin-top { display: none !important; } .admin-shell { display: block; background: #fff; } }'}</style><InvoiceView invoice={invoice} /></>;
}
