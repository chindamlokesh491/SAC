import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container" style={{ padding: '60px 24px' }}>
      <div className="empty"><h1 style={{ fontSize: 30 }}>Page not found</h1><p>The page you are looking for may have moved or no longer exists.</p><Link href="/" className="btn btn-primary">Go to Home</Link></div>
    </div>
  );
}
