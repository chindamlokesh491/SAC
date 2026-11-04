/** Uploaded images exist in 400, 720 and 1200 px versions; let the browser pick the smallest that is sharp. */
export function imageSrcSet(url: string): string | undefined {
  const match = /^(.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/.exec(url);
  return match ? `${match[1]}-sm.webp 400w, ${match[1]}-md.webp 720w, ${url} 1200w` : undefined;
}

export const PRODUCT_IMAGE_SIZES = '(max-width: 900px) 92vw, 560px';

/** Absolute URL for structured data: local /media paths get the site origin, Storage URLs are already absolute. */
export function absoluteImageUrl(url: string, siteUrl: string): string {
  return /^https?:\/\//.test(url) ? url : `${siteUrl}${url}`;
}
