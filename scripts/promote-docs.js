#!/usr/bin/env node

/**
 * Promote Design System Docs
 *
 * Copies reviewed content from the local markdown vault to the published docs site.
 * Covers three content layers: Foundations, Tokens, and Components.
 *
 * Transformations applied:
 *   1. Strips <!-- sync:* --> / <!-- /sync:* --> comment markers (MDX-incompatible)
 *   2. Replaces source frontmatter with clean site frontmatter + explicit slug
 *   3. Injects frontmatter into files that have none (token files, Foundations, Guidelines)
 *   4. Converts [[wiki-links]] to markdown links (Token Index only)
 *   5. Skips incomplete skeleton stubs and _orphaned/ quarantine files
 *
 * Usage: node scripts/promote-docs.js [--dry-run]
 *
 * --dry-run  Preview what would be copied without writing any files.
 */

const fs = require('fs');
const path = require('path');
const { kebab } = require('./lib/slug');
const { PROJECT_ROOT, loadConfig, configuredPath } = require('./lib/config');

const config          = loadConfig();
const SOURCE_ROOT     = configuredPath(config, 'docsSource');
const SOURCE_TOKENS   = path.join(SOURCE_ROOT, 'tokens');
const SOURCE_COMPONENTS = path.join(SOURCE_ROOT, 'components');
const GENERATED_TOKENS = configuredPath(config, 'generatedTokens');
const SITE_DS_ROOT    = configuredPath(config, 'siteDocsRoot');
const SITE_TOKENS     = path.join(SITE_DS_ROOT, 'tokens');
const SITE_TOKEN_REF  = path.join(SITE_TOKENS, 'reference');
const SITE_COMPONENTS = path.join(SITE_DS_ROOT, 'components');
const BASE_SLUG       = config.docs.baseSlug;
const TOKENS_SLUG     = config.docs.tokensSlugBase;
const COMPONENTS_SLUG = config.docs.componentsSlugBase;

const DRY_RUN = process.argv.includes('--dry-run');

// A spec is considered a stub only when the Purpose section is still the
// template placeholder. Partial enrichment of other sections (e.g. missing
// variant tables or token maps) should NOT block promotion — those placeholders
// are sometimes kept while the component is being filled in.
const STUB_PURPOSE_MARKER = '(Add component purpose';

// Directories inside the source components folder that must NEVER be promoted.
// `_orphaned/` holds quarantined specs; `ai-log/` is not a child of components/
// but is listed here as defence-in-depth in case the hierarchy changes.
const IGNORED_DIRS = new Set(['_orphaned', 'ai-log']);

// Token files in display order, with site metadata
const TOKEN_FILES = [
  { file: 'Token Index.md',                label: 'Token Index',                position: 1, slug: `${TOKENS_SLUG}/token-index` },
  { file: 'Colour System.md',              label: 'Colour System',              position: 2, slug: `${TOKENS_SLUG}/colour-system` },
  { file: 'Type System.md',                label: 'Type System',                position: 3, slug: `${TOKENS_SLUG}/type-system` },
  { file: 'Spacing & Layout.md',           label: 'Spacing & Layout',           position: 4, slug: `${TOKENS_SLUG}/spacing-layout` },
  { file: 'Motion System.md',              label: 'Motion System',              position: 5, slug: `${TOKENS_SLUG}/motion-system` },
  { file: 'Elevation & Shadow.md',         label: 'Elevation & Shadow',         position: 6, slug: `${TOKENS_SLUG}/elevation-shadow` },
  { file: 'Focus & Interaction States.md', label: 'Focus & Interaction States', position: 7, slug: `${TOKENS_SLUG}/focus-interaction-states` },
];

// Generated token reference files — auto-built by generate-tokens.js
const GENERATED_TOKEN_FILES = [
  { file: 'colour-reference.md',    label: 'Colour Reference',    position: 1, slug: `${TOKENS_SLUG}/reference/colour` },
  { file: 'spacing-reference.md',   label: 'Spacing Reference',   position: 2, slug: `${TOKENS_SLUG}/reference/spacing` },
  { file: 'motion-reference.md',    label: 'Motion Reference',    position: 3, slug: `${TOKENS_SLUG}/reference/motion` },
  { file: 'typography-reference.md',label: 'Typography Reference',position: 4, slug: `${TOKENS_SLUG}/reference/typography` },
];

// Foundations files in display order
const FOUNDATION_FILES = [
  { file: 'Foundations.md', label: 'Foundations', position: 1, slug: `${BASE_SLUG}/foundations` },
  { file: 'Guidelines.md',  label: 'Guidelines',  position: 2, slug: `${BASE_SLUG}/guidelines`  },
];

// ─── Transformations ──────────────────────────────────────────────────────────

function stripSyncMarkers(content) {
  return content.replace(/^<!-- \/?sync:[a-zA-Z:]+ -->\n?/gm, '');
}

// Replace or inject site frontmatter with explicit slug.
// Slug is derived as /design-system/components/<kebab-name> for predictable, stable URLs.
function convertFrontmatter(content, componentName) {
  const slug = COMPONENTS_SLUG + '/' + kebab(componentName);
  const newFm = ['---', `sidebar_label: "${componentName}"`, `slug: ${slug}`, '---'].join('\n');
  const lines = content.split('\n');
  if (lines[0] !== '---') return newFm + '\n' + content;
  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) return newFm + '\n' + content;
  return newFm + '\n' + lines.slice(closeIdx + 1).join('\n');
}

// Prepend site frontmatter to files that have none (token files, foundations).
// Guard prevents double-injection on subsequent runs.
function injectFrontmatter(content, label, position, slug) {
  if (content.startsWith('---')) return content;
  const fm = ['---', `sidebar_label: "${label}"`, `sidebar_position: ${position}`, `slug: ${slug}`, '---', ''].join('\n');
  return fm + content;
}

// Lookup table mapping wiki-link targets to site URLs.
const WIKI_LINK_MAP = {
  'Guidelines':                 BASE_SLUG + '/guidelines',
  'Foundations':                BASE_SLUG + '/foundations',
  'Token Index':                TOKENS_SLUG + '/token-index',
  'Colour System':              TOKENS_SLUG + '/colour-system',
  'Type System':                TOKENS_SLUG + '/type-system',
  'Spacing & Layout':           TOKENS_SLUG + '/spacing-layout',
  'Motion System':              TOKENS_SLUG + '/motion-system',
  'Elevation & Shadow':         TOKENS_SLUG + '/elevation-shadow',
  'Focus & Interaction States': TOKENS_SLUG + '/focus-interaction-states',
};

// Convert [[wiki-links]] to markdown links using configured slug bases.
function convertWikiLinks(content) {
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const trimmed = target.trim();
    const url = WIKI_LINK_MAP[trimmed] || ('#' + kebab(trimmed));
    return `[${(alias || trimmed).trim()}](${url})`;
  });
}

// Full pipeline for component specs
function transformComponent(content, componentName) {
  return convertFrontmatter(stripSyncMarkers(content), componentName);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isIncomplete(content) {
  return content.includes(STUB_PURPOSE_MARKER);
}

function extractComponentName(content, fileName) {
  const match = content.match(/^figmaName:\s*"?([^"\n]+)"?/m);
  return match ? match[1].trim() : path.basename(fileName, '.md');
}

function fileChanged(destPath, newContent) {
  if (!fs.existsSync(destPath)) return true;
  return fs.readFileSync(destPath, 'utf8') !== newContent;
}

// ─── Promotion functions ──────────────────────────────────────────────────────

// Generic: promote a fixed list of files (foundations, tokens)
function promoteFiles(files, srcDir, destDir, stats, { convertLinks = false } = {}) {
  if (!DRY_RUN) fs.mkdirSync(destDir, { recursive: true });
  for (const { file, label, position, slug } of files) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    if (!fs.existsSync(srcPath)) { console.log(`  ⚠️  Missing: ${file}`); continue; }

    let content = fs.readFileSync(srcPath, 'utf8');
    content = injectFrontmatter(content, label, position, slug);
    if (convertLinks) content = convertWikiLinks(content);

    const isNew = !fs.existsSync(destPath);
    if (!fileChanged(destPath, content)) {
      console.log(`  —  Unchanged: ${file}`);
      stats.unchanged++;
      continue;
    }
    if (!DRY_RUN) fs.writeFileSync(destPath, content);
    console.log(isNew ? `  ✨ New: ${file}` : `  ✅ Updated: ${file}`);
    isNew ? stats.promoted++ : stats.updated++;
  }
}

// Recursive: promote component specs directory (skips stubs and IGNORED_DIRS)
function processDir(src, dest, stats) {
  if (!fs.existsSync(src)) return;
  for (const file of fs.readdirSync(src)) {
    if (IGNORED_DIRS.has(file)) continue;
    if (file.startsWith('_') && file.endsWith('.md')) continue;  // e.g. _README, _category_ markers
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    if (fs.statSync(srcPath).isDirectory()) {
      if (!DRY_RUN) fs.mkdirSync(destPath, { recursive: true });
      processDir(srcPath, destPath, stats);
      continue;
    }
    if (!file.endsWith('.md')) continue;

    const raw = fs.readFileSync(srcPath, 'utf8');
    if (isIncomplete(raw)) {
      console.log(`  ⏭️  Skipped (incomplete): ${file}`);
      stats.skipped++;
      continue;
    }

    const componentName = extractComponentName(raw, file);
    const transformed = transformComponent(raw, componentName);
    const isNew = !fs.existsSync(destPath);

    if (!fileChanged(destPath, transformed)) {
      console.log(`  —  Unchanged: ${file}`);
      stats.unchanged++;
      continue;
    }
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, transformed);
    }
    console.log(isNew ? `  ✨ New: ${file}` : `  ✅ Updated: ${file}`);
    isNew ? stats.promoted++ : stats.updated++;
  }
}

// Promote auto-generated token reference tables (from generate-tokens.js output).
// These files already have a `#` heading; inject site frontmatter and copy.
function promoteGeneratedTokens(stats) {
  if (!fs.existsSync(GENERATED_TOKENS)) {
    console.log(`  ⚠️  ${path.relative(PROJECT_ROOT, GENERATED_TOKENS)}/ not found — run generate-tokens.js first.`);
    return;
  }

  // Write _category_.json for the reference sub-folder
  const categoryPath = path.join(SITE_TOKEN_REF, '_category_.json');
  const categoryJson = JSON.stringify({ label: 'Token Reference', position: 8 }, null, 2) + '\n';
  if (!DRY_RUN) {
    fs.mkdirSync(SITE_TOKEN_REF, { recursive: true });
    fs.writeFileSync(categoryPath, categoryJson);
  }

  for (const { file, label, position, slug } of GENERATED_TOKEN_FILES) {
    const srcPath  = path.join(GENERATED_TOKENS, file);
    const destPath = path.join(SITE_TOKEN_REF, file);

    if (!fs.existsSync(srcPath)) {
      console.log(`  ⚠️  Missing generated file: ${file}`);
      continue;
    }

    // Generated files start with `# Heading` — inject frontmatter above it
    let content = fs.readFileSync(srcPath, 'utf8');
    content = injectFrontmatter(content, label, position, slug);

    const isNew = !fs.existsSync(destPath);
    if (!fileChanged(destPath, content)) {
      console.log(`  —  Unchanged: ${file}`);
      stats.unchanged++;
      continue;
    }

    if (!DRY_RUN) fs.writeFileSync(destPath, content);
    console.log(isNew ? `  ✨ New: ${file}` : `  ✅ Updated: ${file}`);
    isNew ? stats.promoted++ : stats.updated++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function promote() {
  console.log(`📋 Promoting design system docs${DRY_RUN ? ' (dry run)' : ''}...\n`);

  const stats = { promoted: 0, updated: 0, skipped: 0, unchanged: 0 };

  console.log('── Foundations ──────────────────────────────────────────────────');
  promoteFiles(FOUNDATION_FILES, SOURCE_ROOT, SITE_DS_ROOT, stats);

  console.log('\n── Tokens ───────────────────────────────────────────────────────');
  promoteFiles(TOKEN_FILES, SOURCE_TOKENS, SITE_TOKENS, stats, { convertLinks: true });

  console.log('\n── Token Reference (generated) ──────────────────────────────────');
  promoteGeneratedTokens(stats);

  console.log('\n── Components ───────────────────────────────────────────────────');
  processDir(SOURCE_COMPONENTS, SITE_COMPONENTS, stats);

  console.log('\n📊 Results:');
  console.log(`   New:       ${stats.promoted}`);
  console.log(`   Updated:   ${stats.updated}`);
  console.log(`   Unchanged: ${stats.unchanged}`);
  console.log(`   Skipped:   ${stats.skipped} (incomplete stubs)`);

  if (DRY_RUN) {
    console.log('\n⚠️  Dry run — no files written. Remove --dry-run to apply.\n');
  } else {
    console.log(`\n👉 Next: build the docs site from ${path.relative(PROJECT_ROOT, path.dirname(SITE_DS_ROOT))}\n`);
  }
}

promote();
