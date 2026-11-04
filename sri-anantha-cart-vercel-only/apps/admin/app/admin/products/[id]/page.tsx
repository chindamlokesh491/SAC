'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { ProductForm, type ProductRecord } from '@/components/admin/ProductForm';

export default function EditProductPage() {
  const { id } = useParams<{ id: string }>();
  const { request } = useAdmin();
  const [product, setProduct] = useState<ProductRecord | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { request<{ data: ProductRecord }>(`/api/v1/admin/products/${id}`).then(result => setProduct(result.data)).catch(err => setError(adminError(err))); }, [id, request]);
  if (error) return <div className="empty">{error}</div>;
  if (!product) return <div className="skeleton" style={{ height: 500 }} />;
  return <ProductForm key={product.id} product={product} />;
}
