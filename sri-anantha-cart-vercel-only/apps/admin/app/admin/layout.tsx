import type { Metadata } from 'next';
import { AdminFrame } from '@/components/admin/AdminFrame';
import '@/styles/admin.css';

export const metadata: Metadata = { title: { default: 'Admin', template: '%s · Admin · Sri Anantha Cart' }, robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminFrame>{children}</AdminFrame>;
}
