'use client';

import { type ProductCard } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { MessageCircle, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from './StoreProvider';

type CategoryOption = { id: string; name: string; slug: string; thumb_url: string | null };
type Message =
  | { id: number; from: 'bot' | 'me'; text: string }
  | { id: number; from: 'bot'; products: ProductCard[]; categorySlug: string; categoryName: string }
  | { id: number; from: 'bot'; choices: 'categories' | 'after-products' | 'fallback' };

type NewMessage = Message extends infer M ? (M extends Message ? Omit<M, 'id'> : never) : never;

const KITS_SLUG = 'pooja-kits';

/**
 * Guided shopping: a button-driven flow over the live catalogue. There is no free-text
 * input and no AI, by design (Phase 1 scope).
 */
/** Opens the assistant from anywhere (menu drawer, top bar) on screens where the floating button is hidden. */
export const OPEN_ASSISTANT_EVENT = 'sac:open-assistant';
export function openAssistant() { window.dispatchEvent(new Event(OPEN_ASSISTANT_EVENT)); }

export function ShoppingAssistant({ categories, supportPhone }: { categories: CategoryOption[]; supportPhone: string }) {
  const { addToCart } = useStore();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const nextId = useRef(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_ASSISTANT_EVENT, show);
    return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, show);
  }, []);

  const push = (...items: NewMessage[]) => setMessages(current => [...current, ...items.map(item => ({ ...item, id: nextId.current++ }) as Message)]);

  useEffect(() => {
    if (open && messages.length === 0) {
      push({ from: 'bot', text: 'Namaste! 🙏 What are you looking for today?' }, { from: 'bot', choices: 'categories' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, loading]);

  const showCategory = async (slug: string, name: string, userText = name) => {
    push({ from: 'me', text: userText });
    setLoading(true);
    try {
      const result = await api.products({ category: slug, sort: 'popular', limit: 4, in_stock: true });
      if (!result.data.length) {
        push({ from: 'bot', text: `${name} items are restocking right now.` }, { from: 'bot', choices: 'fallback' });
      } else {
        push({ from: 'bot', text: slug === KITS_SLUG ? 'Here are our ready-made pooja kits:' : `Top picks in ${name}:` },
          { from: 'bot', products: result.data, categorySlug: slug, categoryName: name },
          { from: 'bot', choices: 'after-products' });
      }
    } catch {
      push({ from: 'bot', text: 'I could not load products just now.' }, { from: 'bot', choices: 'fallback' });
    } finally { setLoading(false); }
  };

  const supportLine = supportPhone ? `Call us at ${supportPhone}` : 'Contact our support team';
  const renderChoices = (kind: 'categories' | 'after-products' | 'fallback') => {
    if (kind === 'categories') {
      return (
        <div className="quick-replies">
          {categories.filter(category => category.slug !== KITS_SLUG).map(category => (
            <button key={category.id} type="button" onClick={() => void showCategory(category.slug, category.name)}>{category.name}</button>
          ))}
          <button type="button" onClick={() => void showCategory(KITS_SLUG, 'Pooja Kits', 'Need a complete puja set?')}>Need a complete puja set?</button>
          <button type="button" onClick={() => { push({ from: 'me', text: 'Something else' }, { from: 'bot', choices: 'fallback' }); }}>Something else</button>
        </div>
      );
    }
    if (kind === 'after-products') {
      return (
        <div className="quick-replies">
          <button type="button" onClick={() => push({ from: 'me', text: 'Show another category' }, { from: 'bot', text: 'Sure! Pick a category:' }, { from: 'bot', choices: 'categories' })}>Another category</button>
          <button type="button" onClick={() => void showCategory(KITS_SLUG, 'Pooja Kits', 'Need a complete puja set?')}>Complete puja set</button>
          <button type="button" onClick={() => push({ from: 'me', text: 'I need help' }, { from: 'bot', choices: 'fallback' })}>I need help</button>
        </div>
      );
    }
    return (
      <div className="bubble bot">
        You can <Link href="/categories" className="link-red" onClick={() => setOpen(false)}>browse our full catalog</Link>, or {supportLine.toLowerCase().startsWith('call') ? <>{supportLine}</> : <Link href="/contact" className="link-red" onClick={() => setOpen(false)}>contact our support team</Link>} — we&apos;re happy to help.
        <div className="quick-replies" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => push({ from: 'bot', text: 'What are you looking for?' }, { from: 'bot', choices: 'categories' })}>Start again</button>
        </div>
      </div>
    );
  };

  return (
    <>
      {open && (
        <section className="assistant" aria-label="Shopping assistant" role="dialog">
          <header className="assistant-head">
            <img src="/brand/lotus.png" alt="" width={36} height={36} />
            <div><strong>Shopping Assistant</strong><small>Find pooja essentials in a few taps</small></div>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close assistant"><X size={20} /></button>
          </header>
          <div className="assistant-body" ref={bodyRef} aria-live="polite">
            {messages.map(message => {
              if ('text' in message) return <div key={message.id} className={`bubble ${message.from}`}>{message.text}</div>;
              if ('products' in message) {
                return (
                  <div key={message.id} className="chat-cards">
                    {message.products.map(product => (
                      <div key={product.id} className="chat-card">
                        {product.thumb_url ? <img src={product.thumb_url} alt="" width={56} height={56} /> : <span />}
                        <div>
                          <Link href={`/products/${product.slug}`} onClick={() => setOpen(false)}><strong>{product.name}</strong></Link>
                          <span className="price">{product.has_variants ? 'From ' : ''}{formatRupees(product.price_paise)}</span>
                        </div>
                        {product.has_variants
                          ? <Link className="btn btn-outline btn-sm" href={`/products/${product.slug}`} onClick={() => setOpen(false)}>Options</Link>
                          : <button type="button" className="btn btn-outline btn-sm" onClick={() => void addToCart(product.id, 1)} aria-label={`Add ${product.name} to cart`}><Plus size={16} /> Add</button>}
                      </div>
                    ))}
                    <Link href={`/c/${message.categorySlug}`} className="link-red" onClick={() => setOpen(false)}>See all {message.categoryName} →</Link>
                  </div>
                );
              }
              return <div key={message.id}>{renderChoices(message.choices)}</div>;
            })}
            {loading && <div className="bubble bot"><span className="spinner" style={{ display: 'inline-block' }} /></div>}
          </div>
        </section>
      )}
      <button type="button" className="assistant-fab" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Close shopping assistant' : 'Open shopping assistant'}>
        {open ? <X size={26} /> : <MessageCircle size={28} />}
        {!open && <span className="ping" />}
      </button>
    </>
  );
}
