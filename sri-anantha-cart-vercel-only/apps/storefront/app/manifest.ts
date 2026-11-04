import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sri Anantha Cart — Your Pooja Essentials',
    short_name: 'Anantha Cart',
    description: 'Authentic pooja essentials delivered in 15-30 minutes in Tirupati.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fefcf7',
    theme_color: '#7c1300',
    categories: ['shopping', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
