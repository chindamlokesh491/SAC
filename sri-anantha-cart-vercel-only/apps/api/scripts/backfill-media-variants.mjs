// Creates the 720 px "-md" size for images uploaded before it existed. Only ADDS files; never changes or
// deletes an original. Dry run by default:
//   node scripts/backfill-media-variants.mjs [--apply]     (reads MEDIA_DIR, default var/media)
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const apply = process.argv.includes('--apply');
const dir = process.env.MEDIA_DIR ?? 'var/media';
const MAIN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/;
const files = new Set(await readdir(dir));
let created = 0;
let skipped = 0;
for (const file of files) {
  const match = MAIN.exec(file);
  if (!match) continue;
  const target = `${match[1]}-md.webp`;
  if (files.has(target)) { skipped++; continue; }
  if (apply) {
    const data = await sharp(join(dir, file)).resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, alphaQuality: 88 }).toBuffer();
    await writeFile(join(dir, target), data, { flag: 'wx', mode: 0o644 });
    const before = (await stat(join(dir, file))).size;
    console.log(`${target}: ${Math.round(before / 1024)} KB -> ${Math.round(data.length / 1024)} KB`);
  }
  created++;
}
console.log(`${apply ? 'Created' : 'Would create'} ${created} medium images; ${skipped} already present.${apply ? '' : ' Re-run with --apply to write them.'}`);
