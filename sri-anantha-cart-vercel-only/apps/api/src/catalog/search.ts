import type { Pool } from 'pg';
import { queryCards, type ProductCard } from './queries.js';

export const SIMILAR_LIMIT = 6;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/**
 * Normalises a query into lower-case words. Plurals match their singular ("diyas" → "diya"),
 * because every word is matched as a word prefix.
 */
export function searchTerms(q: string) {
  const full = q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
  const words = [...new Set(full.split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0)
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)))].slice(0, 6);
  return { full, words, prefix: `${escapeLike(full)}%` };
}

/**
 * True when the word starts any word of the text. Punctuation in the text is treated as a space,
 * and query words contain only letters and digits, so no LIKE or regex metacharacters reach SQL.
 */
const wordStart = (text: string, word: string) =>
  `(' ' || lower(regexp_replace(${text}, '[^[:alnum:]]+', ' ', 'g'))) LIKE ('% ' || ${word} || '%')`;

/**
 * Exact search: every query word must start a word of the product's own name, subtitle or highlights
 * (scope "product"), or of its category / subcategory name (scope "category", used only when nothing
 * matches by name, e.g. "pooja essentials"). Long descriptions are never searched; they cause unrelated matches.
 */
const PRODUCT_FIELDS = ['p.name', "COALESCE(p.short_description, '')", "array_to_string(p.highlights, ' ')"];
const CATEGORY_FIELDS = ["COALESCE(c.name, '')", "COALESCE(sub.name, '')"];

export function exactMatch(wordsParam: string, scope: 'product' | 'category' = 'product') {
  const fields = scope === 'product' ? PRODUCT_FIELDS : CATEGORY_FIELDS;
  return `NOT EXISTS (SELECT 1 FROM unnest(${wordsParam}::text[]) AS w(word)
    WHERE NOT (${fields.map(field => wordStart(field, 'w.word')).join(' OR ')}))`;
}

/** Best first: whole name, name starts with the query, every word in the name, then category/subtitle matches. */
export function relevanceOrder(fullParam: string, prefixParam: string, wordsParam: string) {
  const allInName = `NOT EXISTS (SELECT 1 FROM unnest(${wordsParam}::text[]) AS w(word) WHERE NOT ${wordStart('p.name', 'w.word')})`;
  return `(CASE WHEN lower(p.name) = ${fullParam} THEN 0 WHEN lower(p.name) LIKE ${prefixParam} ESCAPE '\\' THEN 1 WHEN ${allInName} THEN 2 ELSE 3 END), units_sold DESC, p.name ASC`;
}

/**
 * A few related products to show after the exact results: from the same categories as the matches,
 * or (when nothing matched exactly) close spellings of the query. Never the whole catalogue.
 */
export async function similarProducts(pool: Pool, q: string, exact: ProductCard[], limit = SIMILAR_LIMIT): Promise<ProductCard[]> {
  const exclude = exact.map(card => card.id);
  if (exact.length) {
    // Same subcategory first, then same main category; nothing from unrelated categories.
    return queryCards(pool,
      `NOT (p.id = ANY($1::uuid[])) AND (p.category_id IN (SELECT category_id FROM products WHERE id = ANY($1::uuid[]) AND category_id IS NOT NULL)
         OR p.subcategory_id IN (SELECT subcategory_id FROM products WHERE id = ANY($1::uuid[]) AND subcategory_id IS NOT NULL))`,
      [exclude],
      `(p.subcategory_id IS NOT NULL AND p.subcategory_id IN (SELECT subcategory_id FROM products WHERE id = ANY($1::uuid[]))) DESC, units_sold DESC, p.name ASC`,
      limit);
  }
  const { full } = searchTerms(q);
  if (full.length < 3) return [];
  // Typo tolerance: word similarity of the query to the product name (pg_trgm).
  return queryCards(pool, `public.word_similarity($1, lower(p.name)) >= 0.45`, [full], `public.word_similarity($1, lower(p.name)) DESC, units_sold DESC`, limit);
}
