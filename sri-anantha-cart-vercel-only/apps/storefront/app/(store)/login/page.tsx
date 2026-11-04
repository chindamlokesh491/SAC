import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

export default function LoginPage() {
  return (
    <div className="container">
      <div className="auth-wrap">
        <div className="auth-art">
          <h2>Everything for your Pooja</h2>
          <p>Sign in to order authentic pooja essentials, delivered in 15-30 minutes across Tirupati.</p>
        </div>
        <Suspense fallback={<div className="auth-form" />}><LoginForm /></Suspense>
      </div>
    </div>
  );
}
