'use client';

import { ArrowLeft, ArrowRight, Heart, MapPin, Search, ShieldCheck, ShoppingCart } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@sac/ui-web';
import { PincodeChecker } from './LocationTools';
import { useStore } from './StoreProvider';

const GUEST_TOUR_KEY = 'sac-guest-tour-done';
const accountTourKey = (userId: string) => `sac-account-tour-done:${userId}`;
const PIN_KEY = 'sac-pin-asked';
export const OPEN_TOUR_EVENT = 'sac:open-tour';

const STEPS = [
  { icon: Search, title: 'Find what you need', body: 'Browse by category or search for any pooja item, such as “diya”, “kumkum” or “camphor”. Exact matches come first, then a few similar items.' },
  { icon: ShoppingCart, title: 'Add to cart, no account needed', body: 'Tap Add to Cart, then use − and + to change the quantity. Tap the heart to save items for later. Both are kept on this device while you browse.' },
  { icon: MapPin, title: 'Check delivery to your area', body: 'Enter your PIN code or use your current location. We deliver across Tirupati in 15–30 minutes, or at a time slot you choose.' },
  { icon: ShieldCheck, title: 'Sign in only at checkout', body: 'When you are ready to order, sign in with Google or verify your mobile number with a one-time code. Your cart and wishlist move to your account, and you can track every order.' },
];

const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return '1'; } };
const mark = (key: string) => { try { window.localStorage.setItem(key, '1'); } catch { /* storage unavailable */ } };

/** First visit: a four-step introduction, then (for guests) a delivery PIN check. Each shows once; neither blocks browsing. */
export function FirstVisit() {
  const { user, ready, pincode } = useStore();
  const pathname = usePathname();
  const [stage, setStage] = useState<'none' | 'tour' | 'pin'>('none');
  const [step, setStep] = useState(0);

  const tourKey = user ? accountTourKey(user.id) : GUEST_TOUR_KEY;
  const nextStage = useCallback((afterTour: boolean) => {
    if (!afterTour && !read(tourKey)) { setStep(0); setStage('tour'); return; }
    if (!user && !pincode && !read(PIN_KEY)) { setStage('pin'); return; }
    setStage('none');
  }, [user, pincode, tourKey]);

  useEffect(() => {
    // Not on sign-in or checkout pages, where an introduction would interrupt.
    if (!ready || /^\/(login|checkout|orders\/)/.test(pathname ?? '')) return;
    const timer = window.setTimeout(() => nextStage(false), 600);
    return () => window.clearTimeout(timer);
  // Only decide once per page load, after the session is known.
  }, [ready, user?.id, nextStage, pathname]);

  useEffect(() => {
    const open = () => { setStep(0); setStage('tour'); };
    window.addEventListener(OPEN_TOUR_EVENT, open);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, open);
  }, []);

  const finishTour = () => { mark(tourKey); nextStage(true); };
  const closePin = () => { mark(PIN_KEY); setStage('none'); };

  if (stage === 'tour') {
    const current = STEPS[step]!;
    const Icon = current.icon;
    const last = step === STEPS.length - 1;
    return (
      <Modal title="Welcome to Sri Anantha Cart" onClose={finishTour}>
        <div className="modal-body tour">
          <div className="tour-art" aria-hidden="true"><Icon size={40} strokeWidth={1.6} />{step === 1 && <Heart size={22} className="tour-heart" />}</div>
          <p className="tour-count">Step {step + 1} of {STEPS.length}</p>
          <h3>{current.title}</h3>
          <p>{current.body}</p>
          <div className="tour-dots" aria-hidden="true">{STEPS.map((item, index) => <span key={item.title} className={index === step ? 'on' : ''} />)}</div>
        </div>
        <div className="modal-foot tour-foot">
          {step === 0 ? <button type="button" className="btn btn-ghost" onClick={finishTour}>Skip</button>
            : <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}><ArrowLeft size={16} /> Back</button>}
          <button type="button" className="btn btn-primary" onClick={() => (last ? finishTour() : setStep(step + 1))} autoFocus>{last ? 'Start shopping' : <>Next <ArrowRight size={16} /></>}</button>
        </div>
      </Modal>
    );
  }
  if (stage === 'pin') {
    return (
      <Modal title="Check delivery to your area" onClose={closePin}>
        <div className="modal-body">
          <p className="muted" style={{ margin: 0 }}>Enter your PIN code or let us detect it. You can keep browsing either way.</p>
          <PincodeChecker autoFocus onChecked={() => mark(PIN_KEY)} />
        </div>
        <div className="modal-foot"><button type="button" className="btn btn-primary" onClick={closePin}>Continue shopping</button></div>
      </Modal>
    );
  }
  return null;
}

/** Footer / help link that replays the introduction. */
export function TourLink({ className, children = 'How to use this store' }: { className?: string; children?: React.ReactNode }) {
  return <button type="button" className={className ?? 'link-plain'} onClick={() => window.dispatchEvent(new Event(OPEN_TOUR_EVENT))}>{children}</button>;
}
