import { FirstVisit } from '@/components/store/FirstVisit';
import { Footer } from '@/components/store/Footer';
import { Header, TopBar } from '@/components/store/Header';
import { ShoppingAssistant } from '@/components/store/ShoppingAssistant';
import { StoreProvider } from '@/components/store/StoreProvider';
import { ServiceWorker } from '@/components/store/ServiceWorker';
import { getCategories, getStoreConfig } from '@/lib/server-api';
import '@/styles/store.css';

export default async function StoreLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [categories, config] = await Promise.all([getCategories().catch(() => []), getStoreConfig()]);
  return (
    <StoreProvider>
      <a href="#main" className="sr-only">Skip to content</a>
      <TopBar />
      <Header categories={categories} />
      <main id="main">{children}</main>
      <Footer categories={categories} config={config} />
      <ShoppingAssistant categories={categories.map(({ id, name, slug, thumb_url }) => ({ id, name, slug, thumb_url }))} supportPhone={config?.store.support_phone ?? ''} />
      <FirstVisit />
      <ServiceWorker />
    </StoreProvider>
  );
}
