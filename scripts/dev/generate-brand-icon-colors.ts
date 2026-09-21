/**
 * Generate the badge-colour table for every brand icon key.
 *
 * Badge colours used to be hand-written per brand (`color:` in modelBrand.ts)
 * and drifted from the mark they sit next to: 61 of 72 hand-written values
 * disagreed with what lobehub declares for the same icon (OpenAI is `#000`
 * there, not the green we had written by hand).
 *
 * This script reads lobehub twice, so nothing is invented:
 *   1. the PNG the badge actually renders, sampled for its dominant saturated
 *      colour — used whenever the mark has a hue of its own;
 *   2. the icon package's declared COLOR_PRIMARY (es/toc.json) — used for marks
 *      whose PNG is monochrome but that still have an official brand colour
 *      (Groq #F55036, IBM #0F62FE …);
 *   3. marks where lobehub itself declares only black/white get no colour at
 *      all — they are listed in MONO_ICON_KEYS and the badge renders them from
 *      the theme ink plus the per-name hash instead of an invented hue.
 *
 * Output: src/server/shared/brandIconColors.ts — committed, reviewed, and read
 * by the web bundle at build time (no runtime fetch, no extra request).
 *
 * Usage: npm run brand:colors
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { getAllBrandIconKeys } from '../../src/server/shared/modelBrand.js';
import { BRAND_ICON_CDN_BASE, BRAND_ICON_VERSION } from '../../src/server/services/iconProxyService.js';

const OUTPUT = resolve(process.cwd(), 'src/server/shared/brandIconColors.ts');
const ICONS_PACKAGE = '@lobehub/icons@5.18.0';
const DECLARED_URL = `https://registry.npmmirror.com/@lobehub/icons/5.18.0/files/es/toc.json`;

/** Pixels below this alpha are anti-aliasing fringe and would wash the hue out. */
const ALPHA_FLOOR = 140;
/** Chroma (max-min channel) below this is grey: it carries no brand hue. */
const CHROMA_FLOOR = 32;
/** Bucket size when counting colours; coarse enough to group gradients. */
const BUCKET = 24;
/** A declared colour only counts as a brand hue inside this chroma/luma window. */
const DECLARED_CHROMA_FLOOR = 0.25;
const DECLARED_LUMA_WINDOW: [number, number] = [0.1, 0.92];

type Sample = { hex: string; share: number; saturation: number };

/**
 * Dominant saturated colour of one PNG, weighted by pixel count and biased
 * towards the most saturated bucket so a coloured mark does not lose to its own
 * black outline (many lobehub marks are a coloured glyph with dark edges).
 */
async function dominantColor(url: string): Promise<Sample | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let visible = 0;

  for (let i = 0; i < data.length; i += channels) {
    const alpha = channels === 4 ? data[i + 3]! : 255;
    if (alpha < ALPHA_FLOOR) continue;
    visible += 1;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) < CHROMA_FLOOR) continue;
    const key = `${Math.floor(r / BUCKET)}-${Math.floor(g / BUCKET)}-${Math.floor(b / BUCKET)}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  if (visible === 0 || buckets.size === 0) return null;

  let best: { hex: string; count: number; saturation: number } | null = null;
  for (const bucket of buckets.values()) {
    const r = Math.round(bucket.r / bucket.count);
    const g = Math.round(bucket.g / bucket.count);
    const b = Math.round(bucket.b / bucket.count);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Saturation scaled by coverage: a big pale area should not beat a compact
    // vivid glyph, but a barely-present speck should not win either.
    const saturation = ((max - min) / max) * Math.min(1, bucket.count / (visible * 0.05));
    if (!best || saturation > best.saturation) {
      best = { hex: `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`, count: bucket.count, saturation };
    }
  }
  if (!best) return null;
  return { hex: best.hex, share: Number((best.count / visible).toFixed(3)), saturation: Number(best.saturation.toFixed(3)) };
}

/** Hue/luminance of a hex colour, for deciding whether a declared colour is a brand hue at all. */
function analyse(hex: string): { chroma: number; luma: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return {
    chroma: max === 0 ? 0 : (max - min) / max,
    luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
  };
}

/** lobehub's declared COLOR_PRIMARY per icon, keyed by the same style as our icon keys. */
async function declaredColors(): Promise<Map<string, string>> {
  try {
    const response = await fetch(DECLARED_URL);
    if (!response.ok) return new Map();
    const toc = (await response.json()) as { id?: string; docsUrl?: string; title?: string; color?: string }[];
    const byName = new Map<string, string>();
    for (const entry of toc) {
      if (!entry.color) continue;
      for (const candidate of [entry.id, entry.docsUrl, entry.title]) {
        const name = String(candidate || '').toLowerCase();
        if (!name) continue;
        byName.set(name, entry.color);
        byName.set(name.replace(/-/g, ''), entry.color);
      }
    }
    return byName;
  } catch {
    return new Map();
  }
}

function declaredFor(key: string, lookup: Map<string, string>): string | null {
  const lower = key.toLowerCase();
  const base = lower.replace(/-(color|brand|text)$/, '');
  const hit = lookup.get(lower) ?? lookup.get(base)
    ?? lookup.get(lower.replace(/-/g, '')) ?? lookup.get(base.replace(/-/g, ''));
  if (!hit) return null;
  const { chroma, luma } = analyse(hit);
  if (chroma < DECLARED_CHROMA_FLOOR) return null;
  if (luma < DECLARED_LUMA_WINDOW[0] || luma > DECLARED_LUMA_WINDOW[1]) return null;
  return hit;
}

async function main(): Promise<void> {
  const keys = getAllBrandIconKeys();
  const declared = await declaredColors();
  const entries: { key: string; hex: string; source: 'icon' | 'declared' }[] = [];
  const mono: string[] = [];
  const failed: string[] = [];

  for (const key of keys) {
    const url = `${BRAND_ICON_CDN_BASE}/light/${key}.png`;
    let sampled: Sample | null = null;
    try {
      sampled = await dominantColor(url);
    } catch {
      failed.push(key);
      continue;
    }
    if (sampled) {
      entries.push({ key, hex: sampled.hex, source: 'icon' });
      continue;
    }
    // Mono PNG: fall back to lobehub's declared brand colour, if it is a hue.
    const brand = declaredFor(key, declared);
    if (brand) {
      entries.push({ key, hex: brand, source: 'declared' });
      continue;
    }
    // lobehub itself only declares black/white here: no hue exists to use.
    mono.push(key);
  }

  const lines = entries.map((entry) => `  '${entry.key}': '${entry.hex}',`).join('\n');
  const content = `/**
 * GENERATED FILE — do not edit by hand. Run \`npm run brand:colors\`.
 *
 * The colour a badge is tinted with, per brand icon key. Two sources, both
 * lobehub's, so nothing here is invented:
 *   - 'icon': the dominant saturated colour of the PNG the badge renders
 *     (${BRAND_ICON_VERSION}, light theme) — the chip matches the glyph.
 *   - 'declared': the mark itself is monochrome, but ${ICONS_PACKAGE}
 *     declares a brand colour for it (Groq #F55036, IBM #0F62FE, …).
 * Keys listed in \`MONO_ICON_KEYS\` have neither (lobehub declares black/white
 * only, e.g. OpenAI #000, xAI #fff): their badge uses the theme ink plus the
 * per-name hash, never a made-up hue.
 */
export const BRAND_ICON_COLORS: Record<string, string> = {
${lines}
};

/** Icons with no brand hue anywhere in lobehub (mono black/white marks). */
export const MONO_ICON_KEYS: readonly string[] = [
${mono.map((key) => `  '${key}',`).join('\n')}
];
`;

  writeFileSync(OUTPUT, content, 'utf8');
  const byIcon = entries.filter((e) => e.source === 'icon').length;
  const byDeclared = entries.length - byIcon;
  console.log(`brand:colors -> ${entries.length} coloured (${byIcon} icon, ${byDeclared} declared), ${mono.length} mono, ${failed.length} failed`);
  if (failed.length > 0) console.log(`  failed: ${failed.join(', ')}`);
}

await main();
