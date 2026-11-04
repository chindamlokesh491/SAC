'use client';

import { usePathname } from 'next/navigation';
import { AdminProvider } from './AdminProvider';
import { AdminShell } from './AdminShell';

export function AdminFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <AdminProvider>{pathname === '/admin/login' ? children : <AdminShell>{children}</AdminShell>}</AdminProvider>;
}
