import { Mail, MapPin, Phone } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { CMS_PAGES } from '@/lib/cms';
import { getStoreConfig } from '@/lib/server-api';

type Props = { params: Promise<{ page: string }> };
export const dynamicParams = false;
export const revalidate = 300;
export function generateStaticParams() { return Object.keys(CMS_PAGES).map(page => ({ page })); }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = CMS_PAGES[(await params).page];
  return page ? { title: page.title, description: page.description } : {};
}

export default async function CmsPage({ params }: Props) {
  const { page: slug } = await params;
  const page = CMS_PAGES[slug];
  if (!page) notFound();
  const config = slug === 'contact' ? await getStoreConfig() : null;
  return (
    <div className="container cms">
      <Breadcrumbs items={[{ label: page.title }]} />
      <h1>{page.title}</h1>
      {page.sections.map((section, index) => (
        <section key={index}>
          {section.heading && <h2>{section.heading}</h2>}
          {section.body.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
        </section>
      ))}
      {slug === 'contact' && (
        <div className="box" style={{ display: 'grid', gap: 12, marginTop: 20 }}>
          {config?.store.support_phone && <p style={{ margin: 0, display: 'flex', gap: 10 }}><Phone size={20} color="var(--red)" /> <a href={`tel:${config.store.support_phone.replace(/\s/g, '')}`}>{config.store.support_phone}</a></p>}
          {config?.store.whatsapp && <p style={{ margin: 0, display: 'flex', gap: 10 }}><Phone size={20} color="var(--green)" /> <a href={`https://wa.me/${config.store.whatsapp.replace(/\D/g, '')}`} rel="noopener noreferrer" target="_blank">WhatsApp {config.store.whatsapp}</a></p>}
          {config?.store.support_email && <p style={{ margin: 0, display: 'flex', gap: 10 }}><Mail size={20} color="var(--red)" /> <a href={`mailto:${config.store.support_email}`}>{config.store.support_email}</a></p>}
          <p style={{ margin: 0, display: 'flex', gap: 10 }}><MapPin size={20} color="var(--red)" /> {config?.store.address || 'Tirupati, Andhra Pradesh'}</p>
        </div>
      )}
    </div>
  );
}
