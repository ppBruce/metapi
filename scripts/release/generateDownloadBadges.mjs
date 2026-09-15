#!/usr/bin/env node
// Download links for GitHub Release bodies and the README download blocks.
// FlClash-style: one line per OS, each shields.io badge is itself a direct
// download link. No version is hardcoded — every file name is read from the
// artifacts directory, so tagged releases, nightlies and the READMEs all use
// this one script.
//
// Usage:
//   # release body (markdown, stdout or --out)
//   node scripts/release/generateDownloadBadges.mjs --tag v1.7.6 --dir release-assets \
//     --out release-body.md
//
//   # rewrite the block between the markers in the READMEs (idempotent)
//   node scripts/release/generateDownloadBadges.mjs --tag v1.7.6 --dir release-assets \
//     --format html --inplace README.md --inplace README_EN.md
//
// Exit codes: 0 = links produced; 1 = usage/IO error; 2 = no asset matched.

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'wyf9661/metapi';
const MARKER_START = '<!-- downloads:start -->';
const MARKER_END = '<!-- downloads:end -->';
const RELEASES_URL = `https://github.com/${REPO}/releases`;

const badgeUrl = ({ label, color, logo, logoColor = 'white' }) => {
  // shields.io path encoding: '-' must be escaped as '--', '_' as '__',
  // space as %20. Encoding the label again here would render "DMG%20ARM".
  const text = label.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '%20');
  const query = ['style=flat'];
  if (logo) {
    query.push(`logo=${logo}`, `logoColor=${logoColor}`);
  }
  return `https://img.shields.io/badge/${text}-${color}?${query.join('&')}`;
};

const assetUrl = (tag, name) =>
  `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

const isMac = (name) => name.includes('-mac-');
const isArm = (name) => /(arm64|aarch64)/.test(name);
const isZip = (name) => name.endsWith('.zip');

// Order here is the display order. Each badge matches the asset file names it
// links to; a badge that matches nothing is dropped from the row.
const GROUPS = [
  {
    title: 'Windows x64',
    badges: [
      { test: (n) => n.endsWith('.exe'), label: 'Setup', logo: 'windows', color: '0078D4' },
      { test: (n) => isZip(n) && n.includes('-win-'), label: 'Portable', logo: 'windows', color: '0078D4' },
    ],
  },
  {
    title: 'macOS Apple Silicon',
    badges: [
      { test: (n) => n.endsWith('.dmg') && isMac(n) && isArm(n), label: 'DMG', logo: 'apple', color: '000000' },
      { test: (n) => isZip(n) && isMac(n) && isArm(n), label: 'ZIP', logo: 'apple', color: '000000' },
    ],
  },
  {
    title: 'macOS Intel',
    badges: [
      { test: (n) => n.endsWith('.dmg') && isMac(n) && !isArm(n), label: 'DMG', logo: 'apple', color: '000000' },
      { test: (n) => isZip(n) && isMac(n) && !isArm(n), label: 'ZIP', logo: 'apple', color: '000000' },
    ],
  },
  {
    title: 'Linux x64',
    badges: [
      { test: (n) => n.endsWith('.AppImage'), label: 'AppImage', logo: 'linux', color: 'FCC624', logoColor: 'black' },
      { test: (n) => n.endsWith('.deb'), label: 'DEB', logo: 'debian', color: 'A800D2' },
      { test: (n) => n.endsWith('.rpm'), label: 'RPM', logo: 'redhat', color: 'EE0000' },
    ],
  },
  {
    // Nightly only: the per-arch docker image tars (`...-<arch>.tar.gz`).
    title: 'Docker (docker load)',
    badges: [
      { test: (n) => /-amd64\.tar\.gz$/.test(n), label: 'Docker amd64', logo: 'docker', color: '2496ED' },
      { test: (n) => /-arm64\.tar\.gz$/.test(n), label: 'Docker arm64', logo: 'docker', color: '2496ED' },
      { test: (n) => /-armv7\.tar\.gz$/.test(n), label: 'Docker armv7', logo: 'docker', color: '2496ED' },
    ],
  },
];

const parseArgs = () => {
  const args = { tag: '', dir: '', format: 'md', out: '', inplace: [] };
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--tag') args.tag = rest[++i] ?? '';
    else if (arg === '--dir') args.dir = rest[++i] ?? '';
    else if (arg === '--format') args.format = rest[++i] ?? 'md';
    else if (arg === '--out') args.out = rest[++i] ?? '';
    else if (arg === '--inplace') args.inplace.push(rest[++i] ?? '');
  }
  return args;
};

const renderBlock = (tag, names, format) => {
  const link = (badge, alt, href) =>
    format === 'html'
      ? `<a href="${href}"><img alt="${alt}" src="${badgeUrl(badge)}"></a>`
      : `[![${alt}](${badgeUrl(badge)})](${href})`;

  const rows = [];
  const covered = new Set();

  for (const group of GROUPS) {
    const links = [];
    for (const badge of group.badges) {
      const assets = names.filter((n) => badge.test(n)).sort();
      if (assets.length === 0) continue;
      for (const asset of assets) covered.add(asset);
      links.push(
        assets.map((asset) => link(badge, badge.label, assetUrl(tag, asset))).join(' '),
      );
    }
    if (links.length > 0) rows.push({ title: group.title, links: links.join(' ') });
  }

  if (rows.length === 0) return { block: '', covered };

  const body = format === 'html'
    ? rows.map((row) => `<b>${row.title}</b>: ${row.links}`).join('<br>\n')
    : rows.map((row) => `**${row.title}**: ${row.links}`).join('\n');

  const lines = [];
  if (format === 'html') {
    lines.push('<p align="center">');
    lines.push(body);
    lines.push(`<br><a href="${RELEASES_URL}">全部文件 / All files</a>`);
    lines.push('</p>');
  } else {
    lines.push('**下载 / Download based on your OS:**', '');
    lines.push(body);
  }

  // Everything that is not a user-facing installer (OTAs bundle, checksums,
  // blockmaps, updater manifests) stays one click away instead of cluttering
  // the top of the release body. The READMEs keep the badge block only.
  const rest = format === 'html' ? [] : names.filter((n) => !covered.has(n)).sort();
  if (rest.length > 0) {
    lines.push(
      '',
      '<details>',
      `<summary>其他文件 / Other files（离线包 · 校验 · 自动更新元数据，共 ${rest.length} 个）</summary>`,
      '',
      ...rest.map((name) => `- [${name}](${assetUrl(tag, name)})`),
      '',
      '</details>',
    );
  }

  return { block: `${lines.join('\n')}\n`, covered };
};

const rewriteMarkedBlock = (file, block) => {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(MARKER_START);
  const end = source.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${file}: missing ${MARKER_START} / ${MARKER_END} markers`);
  }
  const next =
    source.slice(0, start + MARKER_START.length) +
    `\n${block}` +
    MARKER_END +
    source.slice(end + MARKER_END.length);
  if (next !== source) writeFileSync(file, next);
  return next !== source;
};

function main() {
  const { tag, dir, format, out: outFile, inplace } = parseArgs();
  if (!tag || !dir || !['md', 'html'].includes(format)) {
    console.error('usage: generateDownloadBadges.mjs --tag <tag> --dir <dir> [--format md|html] [--out <file>] [--inplace <file>]');
    process.exit(1);
  }

  let names;
  try {
    names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
  } catch (error) {
    console.error(`cannot read ${dir}: ${error.message}`);
    process.exit(1);
  }

  const { block } = renderBlock(tag, names, format);
  if (!block) {
    console.error(`no asset in ${dir} matched any download group`);
    process.exit(2);
  }

  if (inplace.length > 0) {
    for (const file of inplace) {
      try {
        const changed = rewriteMarkedBlock(file, block);
        console.log(`${file}: ${changed ? 'updated' : 'unchanged'}`);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    }
    return;
  }

  if (outFile) {
    writeFileSync(outFile, block);
    console.log(`wrote ${outFile}`);
    return;
  }
  process.stdout.write(block);
}

main();
