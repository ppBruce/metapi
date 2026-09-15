#!/usr/bin/env node
// Download links for GitHub Release bodies and the README header.
// No version is hardcoded — every file name is read from the artifacts
// directory, so tagged releases, nightlies and the READMEs share one script.
//
// Two layouts, picked by --format:
//   md   release body: a two-column table (platform | packages, FlClash shape)
//        with the packages stacked inside the cell. Files that are not a
//        user-facing package are deliberately not listed — the release page
//        already lists every asset in its own Assets section.
//   html README header: a single row of badges whose labels carry the variant
//        (Setup / Portable / ARM / Intel / ...) — the logos already say which
//        OS, so no label text sits next to the badges and nothing can drift
//        out of line. Measured at ~580px, i.e. narrower than the badge row
//        above it, so it stays on one line instead of wrapping mid-group.
//
// Usage:
//   node scripts/release/generateDownloadBadges.mjs --tag v1.7.6 --dir release-assets \
//     --registries --out release-body.md
//   node scripts/release/generateDownloadBadges.mjs --tag v1.7.6 --dir release-assets \
//     --format html --registries --inplace README.md --inplace README_EN.md
//
// Exit codes: 0 = links produced; 1 = usage/IO error; 2 = no asset matched.

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'wyf9661/metapi';
// The image is published under the same owner/repo slug (Docker Hub + ghcr,
// multi-arch manifests for `latest` and the git tag).
const IMAGE = REPO;
const MARKER_START = '<!-- downloads:start -->';
const MARKER_END = '<!-- downloads:end -->';

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
  `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

const isMac = (name) => name.includes('-mac-');
const isArm = (name) => /(arm64|aarch64)/.test(name);
const isZip = (name) => name.endsWith('.zip');

// Simple Icons dropped the Windows glyph (present in v12, 404 in v14), so
// shields' `logo=windows` silently renders the badge without any icon. Inline
// the official glyph as a data URI instead of depending on a removed slug.
// The colour has to be baked in: shields embeds the inlined glyph as an
// <image>, so logoColor=white cannot reach it and it would render black.
const WINDOWS_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAsMEgxMS4zNzdWMTEuMzcySDBaTTEyLjYyMywwSDI0VjExLjM3MkgxMi42MjNaTTAsMTIuNjIzSDExLjM3N1YyNEgwWm0xMi42MjMsMEgyNFYyNEgxMi42MjMiLz48L3N2Zz4=';
const WINDOWS = { logo: WINDOWS_LOGO, color: '0078D4' };
const APPLE = { logo: 'apple', color: '000000' };
const DOCKER = { logo: 'docker', color: '2496ED' };

// Order here is the display order. `label` is used on the labelled (release
// body) layout, `short` on the single README row; `compact: false` marks a
// badge that only belongs in the labelled layout because it would push the
// single row past the reading column.
const GROUPS = [
  {
    title: 'Windows x64',
    badges: [
      { test: (n) => n.endsWith('.exe'), label: 'Setup', short: 'Setup', ...WINDOWS },
      { test: (n) => isZip(n) && n.includes('-win-'), label: 'Portable', short: 'Portable', ...WINDOWS },
    ],
  },
  {
    title: 'macOS Apple Silicon',
    badges: [
      { test: (n) => n.endsWith('.dmg') && isMac(n) && isArm(n), label: 'DMG', short: 'ARM', ...APPLE },
      { test: (n) => isZip(n) && isMac(n) && isArm(n), label: 'ZIP', short: 'ARM ZIP', compact: false, ...APPLE },
    ],
  },
  {
    title: 'macOS Intel',
    badges: [
      { test: (n) => n.endsWith('.dmg') && isMac(n) && !isArm(n), label: 'DMG', short: 'Intel', ...APPLE },
      { test: (n) => isZip(n) && isMac(n) && !isArm(n), label: 'ZIP', short: 'Intel ZIP', compact: false, ...APPLE },
    ],
  },
  {
    title: 'Linux x64',
    badges: [
      { test: (n) => n.endsWith('.AppImage'), label: 'AppImage', short: 'AppImage', logo: 'linux', color: 'FCC624', logoColor: 'black' },
      { test: (n) => n.endsWith('.deb'), label: 'DEB', short: 'DEB', logo: 'debian', color: 'A800D2' },
      { test: (n) => n.endsWith('.rpm'), label: 'RPM', short: 'RPM', logo: 'redhat', color: 'EE0000' },
    ],
  },
  {
    // Nightly only: the per-arch docker image tars (`...-<arch>.tar.gz`).
    title: 'Docker',
    badges: [
      { test: (n) => /-amd64\.tar\.gz$/.test(n), label: 'amd64', ...DOCKER },
      { test: (n) => /-arm64\.tar\.gz$/.test(n), label: 'arm64', ...DOCKER },
      { test: (n) => /-armv7\.tar\.gz$/.test(n), label: 'armv7', ...DOCKER },
    ],
  },
];

// Registry listings are not release assets, so they come from the repo slug.
// Opt-in via --registries: the nightly release only ships image tars and must
// not advertise a nightly image tag.
const REGISTRIES = [
  {
    label: 'Docker Hub',
    short: 'Docker Hub',
    href: `https://hub.docker.com/r/${IMAGE}/tags`,
    ...DOCKER,
  },
  {
    label: 'ghcr.io',
    short: 'ghcr.io',
    href: `https://github.com/${REPO}/pkgs/container/${REPO.split('/')[1]}`,
    logo: 'github',
    color: '181717',
  },
];

const parseArgs = () => {
  const args = {
    tag: '', dir: '', format: 'md', out: '', inplace: [],
    registries: false,
  };
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--tag') args.tag = rest[++i] ?? '';
    else if (arg === '--dir') args.dir = rest[++i] ?? '';
    else if (arg === '--format') args.format = rest[++i] ?? 'md';
    else if (arg === '--out') args.out = rest[++i] ?? '';
    else if (arg === '--inplace') args.inplace.push(rest[++i] ?? '');
    else if (arg === '--registries') args.registries = true;

  }
  return args;
};

const renderBlock = (tag, names, format, options) => {
  const html = format === 'html';
  // Always raw HTML: markdown is not processed inside a <td> (or inside the
  // <p> the README uses), so image syntax there would print as literal text.
  const link = (badge, label, href) =>
    `<a href="${href}"><img alt="${label}" src="${badgeUrl({ ...badge, label })}"></a>`;

  const rows = [];
  const row = [];

  const badgesOf = (group) =>
    html ? group.badges.filter((badge) => badge.compact !== false) : group.badges;

  for (const group of GROUPS) {
    const links = [];
    for (const badge of badgesOf(group)) {
      const assets = names.filter((name) => badge.test(name)).sort();
      if (assets.length === 0) continue;
      const label = (html ? badge.short : badge.label) ?? badge.label;
      const rendered = assets.map((asset) => link(badge, label, assetUrl(tag, asset)));
      if (html) row.push(...rendered);
      else links.push(...rendered);
    }
    if (!html && links.length > 0) rows.push({ title: group.title, links });
  }

  if (options.registries) {
    if (html) {
      for (const registry of REGISTRIES) row.push(link(registry, registry.short, registry.href));
    } else {
      // Registry badges only: the pull command belongs on the registry page
      // the badge opens, not in the release table.
      rows.push({ title: 'Docker', links: REGISTRIES.map((registry) => link(registry, registry.label, registry.href)) });
    }
  }

  if (html ? row.length === 0 : rows.length === 0) return { block: '' };

  const lines = [];
  if (html) {
    lines.push('<p align="center">', row.join(' '), '</p>');
  } else {
    // Platform on the left, packages stacked on the right — the shape FlClash
    // uses, which keeps the arch readable without a label next to each badge.
    // Files that are not a user-facing package (OTA bundle, checksums,
    // blockmaps, updater manifests) get no listing here on purpose: the
    // release page already lists every asset in its Assets section.
    lines.push('**下载 / Download based on your OS:**', '', '<table>', '  <thead>', '    <tr>');
    lines.push('      <th>平台 / OS</th>', '      <th>下载 / Download</th>', '    </tr>', '  </thead>', '  <tbody>');
    for (const entry of rows) {
      lines.push('    <tr>');
      lines.push(`      <td>${entry.title}</td>`);
      // One line per platform: badges sit side by side in the cell, so every
      // row is a single line tall instead of a stack.
      lines.push(`      <td>${entry.links.join(' ')}</td>`);
      lines.push('    </tr>');
    }
    lines.push('  </tbody>', '</table>', '');
  }

  return { block: `${lines.join('\n')}\n` };
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
  const { tag, dir, format, out: outFile, inplace, registries } = parseArgs();
  if (!tag || !dir || !['md', 'html'].includes(format)) {
    console.error('usage: generateDownloadBadges.mjs --tag <tag> --dir <dir> [--format md|html] [--out <file>] [--inplace <file>] [--registries]');
    process.exit(1);
  }

  let names;
  try {
    names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
  } catch (error) {
    console.error(`cannot read ${dir}: ${error.message}`);
    process.exit(1);
  }

  const { block } = renderBlock(tag, names, format, { registries });
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
