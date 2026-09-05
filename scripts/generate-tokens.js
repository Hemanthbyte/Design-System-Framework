#!/usr/bin/env node

/**
 * Generate Token Artifacts — from _sync blocks to usable outputs
 *
 * Reads the script-owned `_sync` blocks from all token JSON files and produces:
 *   design-system/css/tokens.css       CSS custom properties on :root
 *   design-system/js/tokens.js         JS module (programmatic access / tooling)
 *   docs/generated/tokens/*.md         Markdown reference tables (per section)
 *
 * The markdown files are meant to be promoted into the docs site or embedded in
 * vault prose docs via `![[filename]]`. They replace the hand-typed value
 * tables that drift from the Figma source of truth.
 *
 * Usage:
 *   node scripts/generate-tokens.js              # generate all artifacts
 *   node scripts/generate-tokens.js --dry-run    # preview counts, no writes
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { kebab } = require('./lib/slug');
const { PROJECT_ROOT, loadConfig, configuredPath } = require('./lib/config');

// ─── Constants ────────────────────────────────────────────────────────────────

const config        = loadConfig();
const TOKENS_DIR    = configuredPath(config, 'tokens');
const CSS_OUT       = configuredPath(config, 'css');
const JS_OUT        = configuredPath(config, 'js');
const MD_OUT_DIR    = configuredPath(config, 'generatedTokens');
const CSS_PREFIX    = config.cssPrefix ? kebab(config.cssPrefix) : '';

const DRY_RUN = process.argv.includes('--dry-run');

// Non-fatal issues surfaced at the end of the run so nothing fails silently.
const warnings = [];
function warn(msg) { warnings.push(msg); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function writeFile(filePath, content) {
  if (DRY_RUN) return 'dry-run';
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return 'unchanged';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return 'written';
}

// token name → CSS custom property name segment
// e.g. "amber/1" → "amber-1",  "UI Elements/primary" → "ui-elements-primary"
// Delegates to the shared slug util so filenames, CSS vars, and URL slugs stay in sync.
const toKebab = kebab;

function cssVar(...parts) {
  return `--${[CSS_PREFIX, ...parts].filter(Boolean).join('-')}`;
}

// ─── Value formatters ─────────────────────────────────────────────────────────

// Spatial: pixel values unless the token is a unitless grid count
function spatialCssValue(name, rawValue) {
  if (typeof rawValue !== 'number') return String(rawValue);
  // grid column counts are unitless integers ≤ 24
  if (name.startsWith('grid/columns') && Number.isInteger(rawValue) && rawValue <= 24) return String(rawValue);
  return `${rawValue}px`;
}

// Motion: durations → ms, easings already cubic-bezier strings
function motionCssValue(name, rawValue) {
  if (name.startsWith('duration/') && typeof rawValue === 'number') return `${rawValue}ms`;
  return String(rawValue);
}

// Figma line-height object → percentage string (round to 1 decimal)
function lineHeightCss(lh) {
  if (!lh || typeof lh !== 'object') return null;
  if (lh.unit === 'PERCENT') return `${Math.round(lh.value)}%`;
  if (lh.unit === 'PIXELS')  return `${lh.value}px`;
  if (lh.unit === 'AUTO')    return 'normal';
  return null;
}

// Figma letter-spacing object → px string
function letterSpacingCss(ls) {
  if (!ls || typeof ls !== 'object') return null;
  if (ls.unit === 'PIXELS') return ls.value === 0 ? '0px' : `${ls.value}px`;
  if (ls.unit === 'PERCENT') return `${ls.value}%`;
  return null;
}

// Effect values (single object or array) → CSS box-shadow string
// syncEffectStyles stores single-effect styles as objects, multi-effect as arrays
function effectCssValue(effects) {
  if (!effects) return 'none';
  const arr = Array.isArray(effects) ? effects : [effects];
  if (!arr.length) return 'none';
  const shadows = arr
    .filter(e => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    .map(e => e.css);
  return shadows.length ? shadows.join(', ') : 'none';
}

// ─── Load all _sync blocks ────────────────────────────────────────────────────

function loadAllSync() {
  const blocks = {}; // { syncKey → { values, activeMode, sourceFile } }
  const files = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  for (const file of files) {
    const data = readJson(path.join(TOKENS_DIR, file));
    if (!data || !data._sync) continue;
    for (const [key, block] of Object.entries(data._sync)) {
      if (!block.values || typeof block.values !== 'object') continue;
      blocks[key] = { values: block.values, activeMode: block.activeMode, sourceFile: file };
    }
  }
  return blocks;
}

// ─── CSS generation ───────────────────────────────────────────────────────────

function buildCss(blocks) {
  const lines = [
    '/* ============================================================',
    ` * ${config.projectName} Design Tokens — CSS Custom Properties`,
    ' * Auto-generated by scripts/generate-tokens.js — do not edit',
    ' * ============================================================ */',
    '',
    ':root {',
  ];

  // ── Primitive colors ──────────────────────────────────────────
  if (blocks.Primitives) {
    lines.push('', '  /* Primitive colors */');
    for (const [name, val] of Object.entries(blocks.Primitives.values)) {
      lines.push(`  ${cssVar('color', toKebab(name))}: ${val};`);
    }
  }

  // ── Semantic colors ───────────────────────────────────────────
  if (blocks.Tokens) {
    const mode = blocks.Tokens.activeMode || 'Light';
    lines.push('', `  /* Semantic colors (mode: ${mode}) */`);
    for (const [name, val] of Object.entries(blocks.Tokens.values)) {
      lines.push(`  ${cssVar('color', toKebab(name))}: ${val};`);
    }
  }

  // ── Paint styles ──────────────────────────────────────────────
  if (blocks.PaintStyles && Object.keys(blocks.PaintStyles.values).length) {
    lines.push('', '  /* Paint styles */');
    for (const [name, val] of Object.entries(blocks.PaintStyles.values)) {
      const paints = Array.isArray(val) ? val : [val];
      const first = paints[0];
      if (first && first.type === 'SOLID' && first.value) {
        lines.push(`  ${cssVar('paint', toKebab(name))}: ${first.value};`);
        if (paints.length > 1) {
          warn(`PaintStyle "${name}" has ${paints.length} fills — only the first SOLID is emitted to CSS.`);
        }
      } else if (first) {
        warn(`PaintStyle "${name}" is type "${first.type || 'unknown'}" — non-SOLID fills are not yet emitted to CSS.`);
        lines.push(`  /* ${cssVar('paint', toKebab(name))}: unsupported (${first.type || 'unknown'}) */`);
      }
    }
  }

  // ── Spatial / spacing ─────────────────────────────────────────
  if (blocks.Spatial) {
    lines.push('', '  /* Spacing & layout */');
    for (const [name, val] of Object.entries(blocks.Spatial.values)) {
      lines.push(`  ${cssVar(toKebab(name))}: ${spatialCssValue(name, val)};`);
    }
  }

  // ── Shadows ───────────────────────────────────────────────────
  if (blocks.EffectStyles && Object.keys(blocks.EffectStyles.values).length) {
    lines.push('', '  /* Elevation & shadows */');
    for (const [name, val] of Object.entries(blocks.EffectStyles.values)) {
      lines.push(`  ${cssVar('shadow', toKebab(name))}: ${effectCssValue(val)};`);
    }
  }

  // ── Motion ────────────────────────────────────────────────────
  if (blocks.Motion) {
    lines.push('', '  /* Motion */');
    for (const [name, val] of Object.entries(blocks.Motion.values)) {
      lines.push(`  ${cssVar('motion', toKebab(name))}: ${motionCssValue(name, val)};`);
    }
  }

  // ── Grid styles ───────────────────────────────────────────────
  if (blocks.GridStyles && Object.keys(blocks.GridStyles.values).length) {
    lines.push('', '  /* Grid styles */');
    for (const [name, grids] of Object.entries(blocks.GridStyles.values)) {
      const g = Array.isArray(grids) ? grids[0] : grids;
      if (!g) continue;
      const k = toKebab(name);
      if (typeof g.count === 'number')      lines.push(`  ${cssVar('grid', k, 'columns')}: ${g.count};`);
      if (typeof g.gutterSize === 'number') lines.push(`  ${cssVar('grid', k, 'gutter')}: ${g.gutterSize}px;`);
      if (typeof g.offset === 'number')     lines.push(`  ${cssVar('grid', k, 'offset')}: ${g.offset}px;`);
      if (typeof g.sectionSize === 'number') lines.push(`  ${cssVar('grid', k, 'section')}: ${g.sectionSize}px;`);
      if (g.alignment)                      lines.push(`  ${cssVar('grid', k, 'alignment')}: ${String(g.alignment).toLowerCase()};`);
    }
  }

  // ── Typography ────────────────────────────────────────────────
  if (blocks.TextStyles && Object.keys(blocks.TextStyles.values).length) {
    lines.push('', '  /* Typography */');
    for (const [name, style] of Object.entries(blocks.TextStyles.values)) {
      const k = toKebab(name);
      if (!style.fontFamily) warn(`TextStyle "${name}" is missing fontFamily.`);
      if (style.fontWeight == null) warn(`TextStyle "${name}" is missing fontWeight.`);
      if (style.fontSize == null) warn(`TextStyle "${name}" is missing fontSize.`);
      lines.push(`  ${cssVar(k, 'family')}: ${style.fontFamily};`);
      lines.push(`  ${cssVar(k, 'weight')}: ${style.fontWeight};`);
      lines.push(`  ${cssVar(k, 'size')}: ${style.fontSize}px;`);
      if (style.lineHeight) {
        const lh = lineHeightCss(style.lineHeight);
        if (lh) lines.push(`  ${cssVar(k, 'line-height')}: ${lh};`);
        else    warn(`TextStyle "${name}" has unrecognized lineHeight unit "${style.lineHeight.unit}".`);
      } else {
        warn(`TextStyle "${name}" is missing lineHeight — no ${cssVar(k, 'line-height')} emitted.`);
      }
      if (style.letterSpacing) {
        const ls = letterSpacingCss(style.letterSpacing);
        if (ls && ls !== '0px') lines.push(`  ${cssVar(k, 'letter-spacing')}: ${ls};`);
      }
    }
  }

  lines.push('}', '');
  return lines.join('\n');
}

// ─── JS generation ───────────────────────────────────────────────────────────

function buildJs(blocks) {
  // Build grouped export matching logical sections
  const output = {
    colorPrimitive: blocks.Primitives?.values  ?? {},
    colorSemantic:  blocks.Tokens?.values      ?? {},
    space:          blocks.Spatial?.values     ?? {},
    motion:         blocks.Motion?.values      ?? {},
    type:           blocks.TextStyles?.values  ?? {},
    shadow:         blocks.EffectStyles?.values ?? {},
    grid:           blocks.GridStyles?.values  ?? {},
  };

  const lines = [
    `// ${config.projectName} Design Tokens — JS module`,
    '// Auto-generated by scripts/generate-tokens.js — do not edit',
    '//',
    '// Usage:',
    '//   const { colorSemantic } = require(\'./tokens\');',
    '//   colorSemantic[\'background/page\']  // → "#FFFFFF"',
    '',
    '/* eslint-disable */',
    '',
  ];

  for (const [section, values] of Object.entries(output)) {
    lines.push(`const ${section} = ${JSON.stringify(values, null, 2)};`);
    lines.push('');
  }

  lines.push('module.exports = {');
  for (const key of Object.keys(output)) {
    lines.push(`  ${key},`);
  }
  lines.push('};', '');

  return lines.join('\n');
}

// ─── Markdown generation ──────────────────────────────────────────────────────

// Render a simple header for generated files
function mdHeader(title, sourceMode) {
  const mode = sourceMode ? ` · mode: **${sourceMode}**` : '';
  const tokensPath = path.relative(PROJECT_ROOT, TOKENS_DIR);
  return [
    `# ${title}`,
    '',
    `> Auto-generated from \`${tokensPath}/\`${mode}. Do not edit — run \`node scripts/generate-tokens.js\` to refresh.`,
    '',
  ].join('\n');
}

function buildColorsMd(blocks) {
  const lines = [mdHeader('Colour Reference', blocks.Tokens?.activeMode)];

  if (blocks.Primitives) {
    lines.push('## Primitive Tokens\n');
    lines.push('Primitive tokens are the raw colour scale. Never apply directly — only semantic tokens are used in designs.\n');

    // Group by hue family (first segment of name)
    const groups = {};
    for (const [name, val] of Object.entries(blocks.Primitives.values)) {
      const family = name.split('/')[0];
      if (!groups[family]) groups[family] = [];
      groups[family].push({ name, val });
    }

    for (const [family, entries] of Object.entries(groups)) {
      lines.push(`### ${family.charAt(0).toUpperCase() + family.slice(1)}\n`);
      lines.push('| Token | CSS Variable | Value |');
      lines.push('|---|---|---|');
      for (const { name, val } of entries) {
        lines.push(`| \`${name}\` | \`${cssVar('color', toKebab(name))}\` | \`${val}\` |`);
      }
      lines.push('');
    }
  }

  if (blocks.Tokens) {
    lines.push('## Semantic Tokens\n');
    lines.push('Semantic tokens map role → primitive. Use these in all designs and code.\n');

    const groups = {};
    for (const [name, val] of Object.entries(blocks.Tokens.values)) {
      const family = name.split('/')[0];
      if (!groups[family]) groups[family] = [];
      groups[family].push({ name, val });
    }

    for (const [family, entries] of Object.entries(groups)) {
      lines.push(`### ${family}\n`);
      lines.push('| Token | CSS Variable | Value |');
      lines.push('|---|---|---|');
      for (const { name, val } of entries) {
        lines.push(`| \`${name}\` | \`${cssVar('color', toKebab(name))}\` | \`${val}\` |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function buildSpacingMd(blocks) {
  const lines = [mdHeader('Spacing & Layout Reference', null)];

  if (blocks.Spatial) {
    // Sub-group by prefix
    const groups = {};
    for (const [name, val] of Object.entries(blocks.Spatial.values)) {
      const family = name.split('/')[0];
      if (!groups[family]) groups[family] = [];
      groups[family].push({ name, val });
    }

    for (const [family, entries] of Object.entries(groups)) {
      lines.push(`## ${family}\n`);
      lines.push('| Token | CSS Variable | Value |');
      lines.push('|---|---|---|');
      for (const { name, val } of entries) {
        lines.push(`| \`${name}\` | \`${cssVar(toKebab(name))}\` | \`${spatialCssValue(name, val)}\` |`);
      }
      lines.push('');
    }
  }

  if (blocks.EffectStyles && Object.keys(blocks.EffectStyles.values).length) {
    lines.push('## Elevation & Shadows\n');
    lines.push('| Token | CSS Variable | Box Shadow |');
    lines.push('|---|---|---|');
    for (const [name, val] of Object.entries(blocks.EffectStyles.values)) {
      const css = effectCssValue(val);
      lines.push(`| \`${name}\` | \`${cssVar('shadow', toKebab(name))}\` | \`${css}\` |`);
    }
    lines.push('');
  }

  if (blocks.GridStyles && Object.keys(blocks.GridStyles.values).length) {
    lines.push('## Grid Styles\n');
    lines.push('| Style | Columns | Gutter | Offset | Alignment |');
    lines.push('|---|---|---|---|---|');
    for (const [name, grids] of Object.entries(blocks.GridStyles.values)) {
      const g = Array.isArray(grids) ? grids[0] : grids;
      if (g) {
        lines.push(`| \`${name}\` | ${g.count ?? '—'} | ${g.gutterSize ?? '—'}px | ${g.offset ?? '—'}px | ${g.alignment ?? '—'} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildMotionMd(blocks) {
  const lines = [mdHeader('Motion Reference', null)];

  if (blocks.Motion) {
    const durations = Object.entries(blocks.Motion.values).filter(([n]) => n.startsWith('duration/'));
    const easings   = Object.entries(blocks.Motion.values).filter(([n]) => n.startsWith('easing/'));

    if (durations.length) {
      lines.push('## Durations\n');
      lines.push('| Token | CSS Variable | Value |');
      lines.push('|---|---|---|');
      for (const [name, val] of durations) {
        lines.push(`| \`${name}\` | \`${cssVar('motion', toKebab(name))}\` | \`${val}ms\` |`);
      }
      lines.push('');
    }

    if (easings.length) {
      lines.push('## Easing Curves\n');
      lines.push('| Token | CSS Variable | Cubic Bezier |');
      lines.push('|---|---|---|');
      for (const [name, val] of easings) {
        lines.push(`| \`${name}\` | \`${cssVar('motion', toKebab(name))}\` | \`${val}\` |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function buildTypographyMd(blocks) {
  const lines = [mdHeader('Typography Reference', null)];

  if (blocks.TextStyles && Object.keys(blocks.TextStyles.values).length) {
    lines.push('## Text Styles\n');
    lines.push('| Style | Family | Weight | Size | Line Height | Letter Spacing |');
    lines.push('|---|---|---|---|---|---|');
    for (const [name, s] of Object.entries(blocks.TextStyles.values)) {
      const lh = lineHeightCss(s.lineHeight) ?? '—';
      const ls = letterSpacingCss(s.letterSpacing) ?? '—';
      lines.push(`| \`${name}\` | ${s.fontFamily} | ${s.fontWeight} | ${s.fontSize}px | ${lh} | ${ls} |`);
    }
    lines.push('');

    lines.push('## CSS Variable Reference\n');
    lines.push('Each text style expands to individual CSS custom properties:\n');
    lines.push('| CSS Variable | Example value |');
    lines.push('|---|---|');
    const sample = Object.entries(blocks.TextStyles.values)[0];
    if (sample) {
      const [name, s] = sample;
      const k = toKebab(name);
      lines.push(`| \`${cssVar(k, 'family')}\` | \`${s.fontFamily}\` |`);
      lines.push(`| \`${cssVar(k, 'weight')}\` | \`${s.fontWeight}\` |`);
      lines.push(`| \`${cssVar(k, 'size')}\` | \`${s.fontSize}px\` |`);
      const lh = lineHeightCss(s.lineHeight);
      if (lh) lines.push(`| \`${cssVar(k, 'line-height')}\` | \`${lh}\` |`);
      const ls = letterSpacingCss(s.letterSpacing);
      if (ls && ls !== '0px') lines.push(`| \`${cssVar(k, 'letter-spacing')}\` | \`${ls}\` |`);
    }
    lines.push('');
  } else {
    lines.push('> No text styles synced yet. Re-export from Figma plugin and run `node scripts/sync-tokens.js`.\n');
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`⚙️  Generating token artifacts${DRY_RUN ? ' (dry run)' : ''}...\n`);

  const blocks = loadAllSync();
  const syncKeys = Object.keys(blocks);

  if (!syncKeys.length) {
    console.error(`❌ No _sync blocks found in ${path.relative(PROJECT_ROOT, TOKENS_DIR)}/. Run sync-tokens.js first.`);
    process.exit(1);
  }

  console.log(`   Loaded sync blocks: ${syncKeys.join(', ')}\n`);

  // ── CSS ───────────────────────────────────────────────────────
  const css = buildCss(blocks);
  const cssLines = css.split('\n').filter(l => l.trim().startsWith('--')).length;
  const cssStatus = writeFile(CSS_OUT, css);
  console.log(`  ${cssStatus === 'unchanged' ? '—' : DRY_RUN ? '—' : '📝'} ${path.relative(PROJECT_ROOT, CSS_OUT)}  (${cssLines} variables)${cssStatus === 'unchanged' ? ' unchanged' : ''}`);

  // ── JS ────────────────────────────────────────────────────────
  const js = buildJs(blocks);
  const jsStatus = writeFile(JS_OUT, js);
  const jsTokens = Object.values({
    a: blocks.Primitives?.values, b: blocks.Tokens?.values, c: blocks.Spatial?.values,
    d: blocks.Motion?.values, e: blocks.TextStyles?.values, f: blocks.EffectStyles?.values,
    g: blocks.GridStyles?.values,
  }).reduce((n, v) => n + (v ? Object.keys(v).length : 0), 0);
  console.log(`  ${jsStatus === 'unchanged' ? '—' : DRY_RUN ? '—' : '📝'} ${path.relative(PROJECT_ROOT, JS_OUT)}    (${jsTokens} tokens across 7 sections)${jsStatus === 'unchanged' ? ' unchanged' : ''}`);

  // ── Markdown ──────────────────────────────────────────────────
  const mdFiles = [
    { name: 'colour-reference.md',   content: buildColorsMd(blocks)    },
    { name: 'spacing-reference.md',  content: buildSpacingMd(blocks)   },
    { name: 'motion-reference.md',   content: buildMotionMd(blocks)    },
    { name: 'typography-reference.md', content: buildTypographyMd(blocks) },
  ];

  console.log('');
  for (const { name, content } of mdFiles) {
    const filePath = path.join(MD_OUT_DIR, name);
    const tableRows = content.split('\n').filter(l => l.startsWith('|')).length;
    const status = writeFile(filePath, content);
    console.log(`  ${status === 'unchanged' ? '—' : DRY_RUN ? '—' : '📝'} ${path.relative(PROJECT_ROOT, filePath)}  (${tableRows} table rows)${status === 'unchanged' ? ' unchanged' : ''}`);
  }

  console.log(DRY_RUN
    ? '\n⚠️  Dry run — no files written. Remove --dry-run to apply.'
    : `\n✅ Done. Artifacts are ready.\n   Engineers: import ${path.relative(PROJECT_ROOT, CSS_OUT)}\n   Docs: promote ${path.relative(PROJECT_ROOT, MD_OUT_DIR)}/ alongside vault prose.`
  );

  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
    for (const w of warnings) console.log(`   · ${w}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\n❌ Unexpected error: ${err.message}`);
  process.exit(1);
}
