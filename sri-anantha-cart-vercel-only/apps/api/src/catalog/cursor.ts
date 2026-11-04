/**
 * Keyset ("cursor") pagination for product listings. Instead of OFFSET n, which reads and discards n rows,
 * the next page starts strictly after the last row's sort key. Every sort ends with p.id, so keys are unique.
 */
export type ListSort = 'popular' | 'newest' | 'price_asc' | 'price_desc' | 'name_asc';

type Key = { expr: string; dir: 'ASC' | 'DESC'; cast: 'integer' | 'boolean' | 'text' | 'uuid' | 'timestamptz'; field: string };

const PRICE = 'COALESCE(v.min_price, p.price_paise)';
// Cursor values travel through JSON, which keeps milliseconds only; compare at that precision.
const CREATED = "date_trunc('milliseconds', p.created_at)";

const KEYS: Record<ListSort, Key[]> = {
  popular: [
    { expr: 'COALESCE(s.units_90d, 0)', dir: 'DESC', cast: 'integer', field: 'units_sold' },
    { expr: 'p.is_featured', dir: 'DESC', cast: 'boolean', field: 'is_featured' },
    { expr: 'p.name', dir: 'ASC', cast: 'text', field: 'name' },
    { expr: 'p.id', dir: 'ASC', cast: 'uuid', field: 'id' },
  ],
  newest: [
    { expr: CREATED, dir: 'DESC', cast: 'timestamptz', field: 'created_at' },
    { expr: 'p.name', dir: 'ASC', cast: 'text', field: 'name' },
    { expr: 'p.id', dir: 'ASC', cast: 'uuid', field: 'id' },
  ],
  price_asc: [
    { expr: PRICE, dir: 'ASC', cast: 'integer', field: 'price_paise' },
    { expr: 'p.name', dir: 'ASC', cast: 'text', field: 'name' },
    { expr: 'p.id', dir: 'ASC', cast: 'uuid', field: 'id' },
  ],
  price_desc: [
    { expr: PRICE, dir: 'DESC', cast: 'integer', field: 'price_paise' },
    { expr: 'p.name', dir: 'ASC', cast: 'text', field: 'name' },
    { expr: 'p.id', dir: 'ASC', cast: 'uuid', field: 'id' },
  ],
  name_asc: [
    { expr: 'p.name', dir: 'ASC', cast: 'text', field: 'name' },
    { expr: 'p.id', dir: 'ASC', cast: 'uuid', field: 'id' },
  ],
};

export function sortOrder(sort: ListSort): string {
  return KEYS[sort].map(key => `${key.expr} ${key.dir}`).join(', ');
}

export class InvalidCursorError extends Error {}

/** Decodes a cursor and returns the SQL condition "row comes after the cursor", appending its values. */
export function afterCursor(sort: ListSort, cursor: string, values: unknown[]): string {
  const keys = KEYS[sort];
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new InvalidCursorError(); }
  if (!Array.isArray(decoded) || decoded.length !== keys.length + 1 || decoded[0] !== sort) throw new InvalidCursorError();
  const params = keys.map((key, index) => {
    const value = decoded[index + 1];
    const valid = key.cast === 'integer' ? Number.isSafeInteger(value)
      : key.cast === 'boolean' ? typeof value === 'boolean'
        : key.cast === 'uuid' ? typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
          : key.cast === 'timestamptz' ? typeof value === 'string' && !Number.isNaN(Date.parse(value))
            : typeof value === 'string' && value.length <= 300;
    if (!valid) throw new InvalidCursorError();
    values.push(value);
    return `$${values.length}::${key.cast}`;
  });
  // (k1 after v1) OR (k1 = v1 AND k2 after v2) OR ...
  const branches = keys.map((key, index) => {
    const equal = keys.slice(0, index).map((previous, j) => `${previous.expr} = ${params[j]}`);
    return `(${[...equal, `${key.expr} ${key.dir === 'DESC' ? '<' : '>'} ${params[index]}`].join(' AND ')})`;
  });
  return `(${branches.join(' OR ')})`;
}

export function cursorFor(sort: ListSort, row: Record<string, unknown>): string {
  const values = KEYS[sort].map(key => {
    const value = row[key.field];
    return value instanceof Date ? value.toISOString() : value;
  });
  return Buffer.from(JSON.stringify([sort, ...values]), 'utf8').toString('base64url');
}
