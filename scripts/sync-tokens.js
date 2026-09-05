#!/usr/bin/env node

/**
 * Sync Design Tokens — Figma ↔ local (two-way)
 *
 * PULL (Figma → local):
 *   Reads variable collections and styles from a plugin-exported JSON file and
 *   writes live values into a script-owned `_sync` block in each token JSON file.
 *
 * PUSH (local → Figma):
 *   Reads all `_sync` blocks from token JSON files and packages them into
 *   variables-import.json. Open the Figma plugin → Import tab → select that file.
 *
 * Usage:
 *   node scripts/sync-tokens.js                        # pull all collections
 *   node scripts/sync-tokens.js --dry-run              # preview pull, no writes
 *   node scripts/sync-tokens.js --collection colour    # pull one collection
 *   node scripts/sync-tokens.js --mode Dark            # pull using a specific mode
 *   node scripts/sync-tokens.js --force                # bypass file key mismatch
 *   node scripts/sync-tokens.js --push                 # package local → import file
 *   node scripts/sync-tokens.js --push --dry-run       # preview push, no file written
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { kebab } = require('./lib/slug');
const { PROJECT_ROOT, loadConfig, configuredPath } = require('./lib/config');

// ─── Constants ────────────────────────────────────────────────────────────────

const config          = loadConfig();
const TOKENS_JSON_DIR = configuredPath(config, 'tokens');
const FIGMA_CACHE_DIR = configuredPath(config, 'figmaCache');
const EXPORT_FILE     = path.join(FIGMA_CACHE_DIR, 'variables-export.json');
const IMPORT_FILE     = path.join(FIGMA_CACHE_DIR, 'variables-import.json');
const STATE_FILE      = path.join(FIGMA_CACHE_DIR, 'state.json');
const AI_LOG_DIR      = path.join(configuredPath(config, 'docsSource'), 'ai-log');

// ─── CLI flags ────────────────────────────────────────────────────────────────

const DRY_RUN         = process.argv.includes('--dry-run');
const FORCE           = process.argv.includes('--force');
const PUSH            = process.argv.includes('--push');
const COLLECTION_FLAG = (() => {
  const idx = process.argv.indexOf('--collection');
  return idx !== -1 ? process.argv[idx + 1]?.toLowerCase() : null;
})();

// --mode accepts two forms:
//   --mode Dark                  → applies "Dark" to all collections
//   --mode Colour=Dark --mode Spacing=Mobile  → per-collection overrides
// MODE_MAP: { collectionName (lowercase) → modeName } | null for global
const MODE_MAP = (() => {
  const args = process.argv;
  const entries = {};
  let hasPerCollection = false;
  let globalMode = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const val = args[i + 1];
      if (val.includes('=')) {
        const eq = val.indexOf('=');
        entries[val.slice(0, eq).trim().toLowerCase()] = val.slice(eq + 1).trim();
        hasPerCollection = true;
      } else {
        globalMode = val;
      }
    }
  }
  if (hasPerCollection) return { perCollection: entries, global: globalMode };
  if (globalMode) return { perCollection: {}, global: globalMode };
  return null;
})();

function resolveMode(col) {
  if (!MODE_MAP) return col.modes[0];
  const colKey = col.name.toLowerCase();
  // Per-collection override: substring match (e.g. "colour" matches "Colour System")
  const perColEntry = Object.entries(MODE_MAP.perCollection).find(([k]) => colKey.includes(k));
  if (perColEntry) {
    const [, modeName] = perColEntry;
    const found = col.modes.find(m => m.name.toLowerCase() === modeName.toLowerCase());
    if (found) return found;
    console.log(`  ⚠️  Mode "${modeName}" not found in "${col.name}" — using default "${col.modes[0]?.name}"`);
    return col.modes[0];
  }
  // Fall back to global --mode; silently use default if not applicable to this collection
  if (MODE_MAP.global) {
    const found = col.modes.find(m => m.name.toLowerCase() === MODE_MAP.global.toLowerCase());
    if (found) return found;
  }
  return col.modes[0];
}

// ─── Collection → output file mapping ────────────────────────────────────────

// Output files for Figma styles
const STYLES_TARGET = config.stylesTarget;

// Maps _sync block keys that represent styles (not variable collections)
const STYLE_SYNC_KEYS = {
  TextStyles:   'text',
  PaintStyles:  'paint',
  EffectStyles: 'effect',
  GridStyles:   'grid',
};

const COLLECTION_MAP = config.collectionMap;

function resolveOutputFile(collectionName) {
  const lower = collectionName.toLowerCase();
  for (const entry of COLLECTION_MAP) {
    if (entry.match.some(m => lower.includes(m))) return path.join(TOKENS_JSON_DIR, entry.file);
  }
  return path.join(TOKENS_JSON_DIR, `unknown-${kebab(lower)}.json`);
}

// ─── Load plugin export ───────────────────────────────────────────────────────

function loadExport() {
  if (!fs.existsSync(EXPORT_FILE)) {
    console.error('❌ variables-export.json not found.');
    console.error('   Run the Design System Token Exporter plugin in Figma, then place the');
    console.error(`   downloaded file at: ${path.relative(PROJECT_ROOT, EXPORT_FILE)}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  } catch (e) {
    console.error(`❌ Failed to parse variables-export.json: ${e.message}`);
    process.exit(1);
  }

  // Schema version check
  const SUPPORTED_SCHEMA = 2;
  if (!parsed.schemaVersion) {
    console.log('  ⚠️  Export has no schemaVersion — re-export from the plugin to ensure compatibility.');
  } else if (parsed.schemaVersion > SUPPORTED_SCHEMA) {
    console.error(`❌ Export schemaVersion ${parsed.schemaVersion} is newer than this script supports (${SUPPORTED_SCHEMA}).`);
    console.error('   Update sync-tokens.js or re-export with an older plugin version.');
    if (!FORCE) process.exit(1);
  }

  // Warn if export is stale
  const exportedAt = parsed.exportedAt ? new Date(parsed.exportedAt) : null;
  if (exportedAt) {
    const ageHours = (Date.now() - exportedAt.getTime()) / 36e5;
    if (ageHours > 24) console.log(`  ⚠️  Export is ${Math.round(ageHours)}h old — consider re-exporting from Figma.`);
  }

  // Validate file key against state.json
  if (parsed.fileKey && fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.fileKey && state.fileKey !== parsed.fileKey) {
        console.error('❌ File key mismatch:');
        console.error(`   Export:  ${parsed.fileKey} (variables-export.json)`);
        console.error(`   Project: ${state.fileKey} (state.json)`);
        console.error('   Pass --force to sync anyway.');
        if (!FORCE) process.exit(1);
        console.log('  ⚠️  --force passed — proceeding despite file key mismatch.');
      }
    } catch (_) { /* state.json unreadable — skip check */ }
  }

  return parsed;
}

// ─── Value extraction ─────────────────────────────────────────────────────────

function figmaColorToHex(c) {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = c.a ?? 1;
  if (a < 1) return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function resolveValue(variable, allVariables, depth = 0) {
  if (depth > 10) return { $alias: variable.name, $error: 'circular or too deep' };
  if (!variable.valuesByMode || typeof variable.valuesByMode !== 'object') return null;
  const modes = Object.values(variable.valuesByMode);
  const value = modes[0];
  if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
    const target = allVariables[value.id];
    if (target) return resolveValue(target, allVariables, depth + 1);
    return { $alias: value.id, $error: 'unresolved alias' };
  }
  switch (variable.resolvedType) {
    case 'COLOR':  return value ? figmaColorToHex(value) : null;
    case 'FLOAT':  return value ?? null;
    case 'STRING': return value ?? null;
    default:       return value ?? null;
  }
}

function resolveValueForMode(variable, modeId, allVariables, depth = 0) {
  if (depth > 10) return { $alias: variable.name, $error: 'circular or too deep' };
  if (!variable.valuesByMode || typeof variable.valuesByMode !== 'object') return null;
  const value = variable.valuesByMode[modeId];
  if (value === undefined) return null;
  if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
    const target = allVariables[value.id];
    if (target) {
      // Preserve the active mode through alias chains; fall back to target's first mode
      const targetModeId = target.valuesByMode[modeId] !== undefined
        ? modeId
        : Object.keys(target.valuesByMode)[0];
      return resolveValueForMode(target, targetModeId, allVariables, depth + 1);
    }
    return { $alias: value.id, $error: 'unresolved alias' };
  }
  switch (variable.resolvedType) {
    case 'COLOR':  return figmaColorToHex(value);
    case 'FLOAT':  return value;
    case 'STRING': return value;
    default:       return value;
  }
}

// ─── JSON file read/write ─────────────────────────────────────────────────────

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return {}; }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  const content = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ─── Diff & quarantine ────────────────────────────────────────────────────────

function diffValues(prev, next) {
  const added    = {};
  const removed  = {};
  const changed  = {};
  const unchanged = {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const inPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const inNext = Object.prototype.hasOwnProperty.call(next, key);
    if (!inPrev)  added[key]     = next[key];
    else if (!inNext) removed[key] = prev[key];
    else if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) changed[key] = { from: prev[key], to: next[key] };
    else unchanged[key] = next[key];
  }
  return { added, removed, changed, unchanged };
}

function printDiff(collectionName, diff, warnings, { selectedMode, allModes }) {
  const SEP = '─'.repeat(50);
  console.log(`\n── ${collectionName} ${SEP.slice(collectionName.length + 4)}`);
  const modeNames = allModes.map(m => m.name);
  const modeLabel = modeNames.map(n => n === selectedMode ? `[${n}]` : n).join(' | ');
  console.log(`   Modes: ${modeLabel}  (bracketed = active)`);
  for (const [k, v] of Object.entries(diff.added))
    console.log(`  ✨ New:     ${k}  →  ${JSON.stringify(v)}`);
  for (const [k, { from, to }] of Object.entries(diff.changed))
    console.log(`  ✅ Changed: ${k}  (${JSON.stringify(from)} → ${JSON.stringify(to)})`);
  for (const k of Object.keys(diff.removed))
    console.log(`  ⚠️  Removed: ${k}`);
  const u = Object.keys(diff.unchanged).length;
  if (u > 0) console.log(`  —  Unchanged: ${u} variable${u !== 1 ? 's' : ''}`);
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
}

// ─── Sync log ─────────────────────────────────────────────────────────────────

function writeLog(results) {
  if (!fs.existsSync(AI_LOG_DIR)) fs.mkdirSync(AI_LOG_DIR, { recursive: true });
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const logFile = path.join(AI_LOG_DIR, `${date}-token-sync.md`);

  const lines = [
    `# Token Sync — ${now.toISOString()}`,
    '',
    DRY_RUN ? '> Dry run — no files were written.' : '',
    '',
    '## Collections synced',
    '',
  ];
  for (const r of results) {
    lines.push(`### ${r.collection} → \`${path.basename(r.file)}\``);
    lines.push(`- Added: ${r.added}  Changed: ${r.changed}  Removed: ${r.removed}  Unchanged: ${r.unchanged}`);
    if (r.warnings.length) lines.push(`- Warnings: ${r.warnings.join('; ')}`);
    lines.push('');
  }
  fs.appendFileSync(logFile, lines.join('\n'));
}

// ─── Text style sync ──────────────────────────────────────────────────────────

function syncTextStyles(styles) {
  const destFile = path.join(TOKENS_JSON_DIR, STYLES_TARGET.text);

  // Build values map: style name → resolved properties (sorted for determinism)
  const newValues = Object.fromEntries(
    styles
      .map(s => [s.name, {
        fontFamily:    s.fontFamily,
        fontWeight:    s.fontWeight,
        fontSize:      s.fontSize,
        lineHeight:    s.lineHeight,
        letterSpacing: s.letterSpacing,
        ...(s.paragraphSpacing                                  ? { paragraphSpacing: s.paragraphSpacing } : {}),
        ...(s.textDecoration && s.textDecoration !== 'NONE'     ? { textDecoration: s.textDecoration }    : {}),
        ...(s.textCase       && s.textCase       !== 'ORIGINAL' ? { textCase: s.textCase }                : {}),
        ...(s.description                                       ? { description: s.description }          : {}),
      }])
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const existing     = readJsonFile(destFile);
  const prevSync     = existing._sync?.TextStyles ?? {};
  const prevValues   = prevSync.values  ?? {};
  const prevRemoved  = prevSync._removed ?? {};

  const diff = diffValues(prevValues, newValues);

  // Quarantine removals; reinstate anything that reappears
  const newRemoved = { ...prevRemoved };
  for (const [k, v] of Object.entries(diff.removed)) newRemoved[k] = v;
  for (const k of Object.keys(newValues)) delete newRemoved[k];

  const hasDiff = Object.keys(diff.added).length || Object.keys(diff.removed).length || Object.keys(diff.changed).length;

  // Print summary
  const SEP = '─'.repeat(50);
  console.log(`\n── Text Styles ${SEP.slice('Text Styles'.length + 4)}`);
  console.log(`   ${styles.length} style${styles.length !== 1 ? 's' : ''} → ${STYLES_TARGET.text}`);
  for (const [k, v] of Object.entries(diff.added))
    console.log(`  ✨ New:     ${k}  →  ${JSON.stringify(v.fontSize)}px`);
  for (const [k, { from, to }] of Object.entries(diff.changed))
    console.log(`  ✅ Changed: ${k}  (${JSON.stringify(from.fontSize)}px → ${JSON.stringify(to.fontSize)}px)`);
  for (const k of Object.keys(diff.removed))
    console.log(`  ⚠️  Removed: ${k}`);
  const u = Object.keys(diff.unchanged).length;
  if (u > 0) console.log(`  —  Unchanged: ${u} style${u !== 1 ? 's' : ''}`);

  if (!DRY_RUN && hasDiff) {
    const updatedSync = {
      ...(existing._sync ?? {}),
      TextStyles: {
        lastSynced: new Date().toISOString(),
        figmaCollection: 'TextStyles',
        values: newValues,
        ...(Object.keys(newRemoved).length ? { _removed: newRemoved } : {}),
      },
    };

    const updated = { _sync: updatedSync };
    for (const [k, v] of Object.entries(existing)) {
      if (k !== '_sync') updated[k] = v;
    }

    writeJsonAtomic(destFile, updated);
    console.log(`  📝 Written: ${path.relative(PROJECT_ROOT, destFile)}`);
  }

  return {
    collection: 'TextStyles',
    file:       destFile,
    added:      Object.keys(diff.added).length,
    changed:    Object.keys(diff.changed).length,
    removed:    Object.keys(diff.removed).length,
    unchanged:  u,
    warnings:   [],
  };
}

// ─── Paint style sync ─────────────────────────────────────────────────────────

function syncPaintStyles(styles) {
  const destFile = path.join(TOKENS_JSON_DIR, STYLES_TARGET.paint);

  // Resolve SOLID fills to hex; keep raw type for complex fills
  const newValues = Object.fromEntries(
    styles
      .map(s => {
        const resolved = s.paints
          .filter(p => p.visible !== false)
          .map(p => {
            if (p.type === 'SOLID') {
              const hex = figmaColorToHex({ ...p.color, a: p.opacity !== undefined ? p.opacity : 1 });
              return { type: 'SOLID', value: hex };
            }
            return { type: p.type };
          });
        return [s.name, resolved.length === 1 ? resolved[0] : resolved];
      })
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const existing    = readJsonFile(destFile);
  const prevSync    = existing._sync?.PaintStyles ?? {};
  const prevValues  = prevSync.values  ?? {};
  const prevRemoved = prevSync._removed ?? {};

  const diff = diffValues(prevValues, newValues);
  const newRemoved = { ...prevRemoved };
  for (const [k, v] of Object.entries(diff.removed)) newRemoved[k] = v;
  for (const k of Object.keys(newValues)) delete newRemoved[k];

  const hasDiff = Object.keys(diff.added).length || Object.keys(diff.removed).length || Object.keys(diff.changed).length;
  const u = Object.keys(diff.unchanged).length;

  const SEP = '─'.repeat(50);
  console.log(`\n── Paint Styles ${SEP.slice('Paint Styles'.length + 4)}`);
  console.log(`   ${styles.length} style${styles.length !== 1 ? 's' : ''} → ${STYLES_TARGET.paint}`);
  for (const [k, v] of Object.entries(diff.added))
    console.log(`  ✨ New:     ${k}  →  ${JSON.stringify(v)}`);
  for (const [k] of Object.entries(diff.changed))
    console.log(`  ✅ Changed: ${k}`);
  for (const k of Object.keys(diff.removed))
    console.log(`  ⚠️  Removed: ${k}`);
  if (u > 0) console.log(`  —  Unchanged: ${u} style${u !== 1 ? 's' : ''}`);

  if (!DRY_RUN && hasDiff) {
    const updatedSync = {
      ...(existing._sync || {}),
      PaintStyles: {
        lastSynced: new Date().toISOString(),
        figmaCollection: 'PaintStyles',
        values: newValues,
        ...(Object.keys(newRemoved).length ? { _removed: newRemoved } : {}),
      },
    };
    const updated = { _sync: updatedSync };
    for (const [k, v] of Object.entries(existing)) {
      if (k !== '_sync') updated[k] = v;
    }
    writeJsonAtomic(destFile, updated);
    console.log(`  📝 Written: ${path.relative(PROJECT_ROOT, destFile)}`);
  }

  return {
    collection: 'PaintStyles',
    file: destFile,
    added: Object.keys(diff.added).length,
    changed: Object.keys(diff.changed).length,
    removed: Object.keys(diff.removed).length,
    unchanged: u,
    warnings: [],
  };
}

// ─── Effect style sync ────────────────────────────────────────────────────────

function syncEffectStyles(styles) {
  const destFile = path.join(TOKENS_JSON_DIR, STYLES_TARGET.effect);

  // Serialize each effect style as a CSS-ready shadow string for drop/inner shadows
  const newValues = Object.fromEntries(
    styles
      .map(s => {
        const resolved = s.effects
          .filter(e => e.visible !== false)
          .map(e => {
            if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
              const color = e.color ? figmaColorToHex(e.color) : 'rgba(0,0,0,0)';
              const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
              return {
                type: e.type,
                css: `${inset}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread || 0}px ${color}`,
                offset: e.offset,
                radius: e.radius,
                spread: e.spread || 0,
                color,
              };
            }
            return { type: e.type };
          });
        return [s.name, resolved.length === 1 ? resolved[0] : resolved];
      })
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const existing    = readJsonFile(destFile);
  const prevSync    = existing._sync?.EffectStyles ?? {};
  const prevValues  = prevSync.values  ?? {};
  const prevRemoved = prevSync._removed ?? {};

  const diff = diffValues(prevValues, newValues);
  const newRemoved = { ...prevRemoved };
  for (const [k, v] of Object.entries(diff.removed)) newRemoved[k] = v;
  for (const k of Object.keys(newValues)) delete newRemoved[k];

  const hasDiff = Object.keys(diff.added).length || Object.keys(diff.removed).length || Object.keys(diff.changed).length;
  const u = Object.keys(diff.unchanged).length;

  const SEP = '─'.repeat(50);
  console.log(`\n── Effect Styles ${SEP.slice('Effect Styles'.length + 4)}`);
  console.log(`   ${styles.length} style${styles.length !== 1 ? 's' : ''} → ${STYLES_TARGET.effect}`);
  for (const [k] of Object.entries(diff.added))   console.log(`  ✨ New:     ${k}`);
  for (const [k] of Object.entries(diff.changed))  console.log(`  ✅ Changed: ${k}`);
  for (const k of Object.keys(diff.removed))       console.log(`  ⚠️  Removed: ${k}`);
  if (u > 0) console.log(`  —  Unchanged: ${u} style${u !== 1 ? 's' : ''}`);

  if (!DRY_RUN && hasDiff) {
    const updatedSync = {
      ...(existing._sync || {}),
      EffectStyles: {
        lastSynced: new Date().toISOString(),
        figmaCollection: 'EffectStyles',
        values: newValues,
        ...(Object.keys(newRemoved).length ? { _removed: newRemoved } : {}),
      },
    };
    const updated = { _sync: updatedSync };
    for (const [k, v] of Object.entries(existing)) {
      if (k !== '_sync') updated[k] = v;
    }
    writeJsonAtomic(destFile, updated);
    console.log(`  📝 Written: ${path.relative(PROJECT_ROOT, destFile)}`);
  }

  return {
    collection: 'EffectStyles',
    file: destFile,
    added: Object.keys(diff.added).length,
    changed: Object.keys(diff.changed).length,
    removed: Object.keys(diff.removed).length,
    unchanged: u,
    warnings: [],
  };
}

// ─── Grid style sync ──────────────────────────────────────────────────────────

function syncGridStyles(styles) {
  const destFile = path.join(TOKENS_JSON_DIR, STYLES_TARGET.grid);

  // Each grid style is keyed by name; value is the layoutGrids array
  const newValues = Object.fromEntries(
    styles
      .map(s => [s.name, s.layoutGrids.map(g => ({
        pattern:     g.pattern,
        count:       g.count,
        sectionSize: g.sectionSize,
        gutterSize:  g.gutterSize,
        offset:      g.offset,
        alignment:   g.alignment,
      }))])
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const existing    = readJsonFile(destFile);
  const prevSync    = existing._sync && existing._sync.GridStyles ? existing._sync.GridStyles : {};
  const prevValues  = prevSync.values   || {};
  const prevRemoved = prevSync._removed || {};

  const diff = diffValues(prevValues, newValues);
  const newRemoved = Object.assign({}, prevRemoved);
  for (const [k, v] of Object.entries(diff.removed)) newRemoved[k] = v;
  for (const k of Object.keys(newValues)) delete newRemoved[k];

  const hasDiff = Object.keys(diff.added).length || Object.keys(diff.removed).length || Object.keys(diff.changed).length;
  const u = Object.keys(diff.unchanged).length;

  const SEP = '─'.repeat(50);
  console.log(`\n── Grid Styles ${SEP.slice('Grid Styles'.length + 4)}`);
  console.log(`   ${styles.length} style${styles.length !== 1 ? 's' : ''} → ${STYLES_TARGET.grid}`);
  for (const [k] of Object.entries(diff.added))   console.log(`  ✨ New:     ${k}`);
  for (const [k] of Object.entries(diff.changed))  console.log(`  ✅ Changed: ${k}`);
  for (const k of Object.keys(diff.removed))       console.log(`  ⚠️  Removed: ${k}`);
  if (u > 0) console.log(`  —  Unchanged: ${u} style${u !== 1 ? 's' : ''}`);

  if (!DRY_RUN && hasDiff) {
    const updatedSync = Object.assign({}, existing._sync || {}, {
      GridStyles: {
        lastSynced: new Date().toISOString(),
        figmaCollection: 'GridStyles',
        values: newValues,
        ...(Object.keys(newRemoved).length ? { _removed: newRemoved } : {}),
      },
    });
    const updated = { _sync: updatedSync };
    for (const [k, v] of Object.entries(existing)) {
      if (k !== '_sync') updated[k] = v;
    }
    writeJsonAtomic(destFile, updated);
    console.log(`  📝 Written: ${path.relative(PROJECT_ROOT, destFile)}`);
  }

  return {
    collection: 'GridStyles',
    file:       destFile,
    added:      Object.keys(diff.added).length,
    changed:    Object.keys(diff.changed).length,
    removed:    Object.keys(diff.removed).length,
    unchanged:  u,
    warnings:   [],
  };
}

// ─── Push (local → Figma import file) ────────────────────────────────────────

function push() {
  console.log(`📦 Building import file${DRY_RUN ? ' (dry run)' : ''}...\n`);

  const variables = {};
  const styles    = { text: {}, paint: {}, effect: {}, grid: {} };
  let totalVars = 0, totalStyles = 0;
  let skipped   = 0;

  const files = fs.readdirSync(TOKENS_JSON_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = readJsonFile(path.join(TOKENS_JSON_DIR, file));
    if (!data || !data._sync) continue;

    for (const [key, block] of Object.entries(data._sync)) {
      if (!block.values || typeof block.values !== 'object') {
        console.log(`  ⏭️  ${file}  →  _sync.${key} has no values — skipped`);
        skipped++;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(STYLE_SYNC_KEYS, key)) {
        const tag   = STYLE_SYNC_KEYS[key];
        const count = Object.keys(block.values).length;
        Object.assign(styles[tag], block.values);
        console.log(`  ${file}  →  styles.${tag}  (${count} entries)`);
        totalStyles += count;
      } else {
        const colName  = block.figmaCollection || key;
        const modeName = block.activeMode || null;
        const count    = Object.keys(block.values).length;
        variables[colName] = { mode: modeName, values: block.values };
        console.log(`  ${file}  →  variables["${colName}"]  mode="${modeName || 'default'}"  (${count} values)`);
        totalVars += count;
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Variable values: ${totalVars}`);
  console.log(`   Style entries:   ${totalStyles}`);
  if (skipped) console.log(`   Skipped blocks:  ${skipped}`);

  if (totalVars === 0 && totalStyles === 0) {
    console.error('\n❌ Nothing to push — no _sync blocks had any values.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n⚠️  Dry run — no file written.');
    return;
  }

  const output = {
    schemaVersion: 2,
    builtAt: new Date().toISOString(),
    variables,
    styles,
  };

  fs.mkdirSync(path.dirname(IMPORT_FILE), { recursive: true });
  fs.writeFileSync(IMPORT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\n✅ Written: design-system/figma-cache/variables-import.json`);
  console.log('   Open the Figma plugin → Import tab → select this file.');
}

// ─── Main sync logic ──────────────────────────────────────────────────────────

function main() {
  console.log(`🔄 Syncing Figma variables → token JSON${DRY_RUN ? ' (dry run)' : ''}...`);
  if (COLLECTION_FLAG) console.log(`   Filtering to collection: "${COLLECTION_FLAG}"`);
  if (MODE_MAP?.global) console.log(`   Global mode override: "${MODE_MAP.global}"`);
  if (MODE_MAP?.perCollection && Object.keys(MODE_MAP.perCollection).length) {
    for (const [col, mode] of Object.entries(MODE_MAP.perCollection))
      console.log(`   Mode override: ${col} → "${mode}"`);
  }

  const response = loadExport();
  if (!response || typeof response !== 'object') {
    console.error('\n❌ Export file is not a JSON object.');
    process.exit(1);
  }
  const meta        = response.meta ?? {};
  const collections = meta.variableCollections ?? {};
  const variables   = meta.variables ?? {};
  const styles      = meta.styles ?? {};

  const hasCollections = Object.keys(collections).length > 0;
  const hasStyles = Object.values(styles).some(v => Array.isArray(v) && v.length > 0);

  if (!hasCollections && !hasStyles) {
    console.error('\n❌ Export contains no variable collections and no styles — nothing to sync.');
    console.error('   If this is unexpected, re-export from the Figma plugin (schemaVersion 2).');
    process.exit(1);
  }

  if (!hasCollections) {
    console.log('\n⚠️  No variable collections found — will sync styles only.');
  }

  // Group variables by collection
  const byCollection = {};
  for (const [colId, col] of Object.entries(collections)) {
    byCollection[colId] = { meta: col, vars: {} };
  }
  for (const [varId, v] of Object.entries(variables)) {
    if (byCollection[v.variableCollectionId]) {
      byCollection[v.variableCollectionId].vars[varId] = v;
    }
  }

  const logResults = [];
  // Track which output files we've touched (to handle multiple collections → same file)
  const touchedFiles = new Set();

  for (const [colId, { meta: col, vars }] of Object.entries(byCollection)) {
    const colName = col.name;

    // Apply --collection filter
    if (COLLECTION_FLAG && !colName.toLowerCase().includes(COLLECTION_FLAG)) continue;

    if (!Object.keys(vars).length) {
      console.log(`\n⚠️  Collection "${colName}" has no variables — skipping.`);
      continue;
    }

    // Resolve mode
    const selectedMode = resolveMode(col);
    const modeId = selectedMode?.modeId;

    // Build new values map (sorted for stable, deterministic output)
    const warnings = [];
    const rawValues = {};
    for (const v of Object.values(vars)) {
      const value = modeId
        ? resolveValueForMode(v, modeId, variables)
        : resolveValue(v, variables);
      if (value !== null) rawValues[v.name] = value;
    }
    const newValues = Object.fromEntries(Object.entries(rawValues).sort(([a], [b]) => a.localeCompare(b)));

    // Resolve output file
    const outFile = resolveOutputFile(colName);
    const isUnknown = !COLLECTION_MAP.some(e => e.match.some(m => colName.toLowerCase().includes(m)));
    if (isUnknown) warnings.push(`Unknown collection "${colName}" — written to ${path.basename(outFile)}`);

    // Read existing file
    const existing = readJsonFile(outFile);

    // Get previous _sync block (there may be multiple if >1 collection → same file)
    // Use colName as the discriminator key inside _sync
    const prevSync   = existing._sync?.[colName] ?? {};
    const prevValues = prevSync.values   ?? {};
    const prevRemoved = prevSync._removed ?? {};

    // Diff
    const diff = diffValues(prevValues, newValues);

    // Quarantine removed variables (merge with existing _removed, so human-cleared ones stay gone)
    const newRemoved = { ...prevRemoved };
    for (const [k, v] of Object.entries(diff.removed)) newRemoved[k] = v;
    // If a previously-removed variable reappears in Figma, move it back to values
    for (const k of Object.keys(newValues)) delete newRemoved[k];

    const hasDiff = Object.keys(diff.added).length || Object.keys(diff.removed).length || Object.keys(diff.changed).length;

    printDiff(colName, diff, warnings, { selectedMode: selectedMode?.name, allModes: col.modes });

    logResults.push({
      collection: colName,
      file: outFile,
      added: Object.keys(diff.added).length,
      changed: Object.keys(diff.changed).length,
      removed: Object.keys(diff.removed).length,
      unchanged: Object.keys(diff.unchanged).length,
      warnings,
    });

    if (!DRY_RUN) {
      // Build updated _sync block (preserve other collections' _sync data if same file)
      const updatedSync = { ...(existing._sync ?? {}) };
      updatedSync[colName] = {
        lastSynced: new Date().toISOString(),
        figmaCollection: colName,
        activeMode: selectedMode?.name ?? null,
        values: newValues,
        ...(Object.keys(newRemoved).length ? { _removed: newRemoved } : {}),
      };

      // Write back — preserving all human keys, only replacing _sync
      const updated = { _sync: updatedSync };
      for (const [k, v] of Object.entries(existing)) {
        if (k !== '_sync') updated[k] = v;
      }

      writeJsonAtomic(outFile, updated);

      if (!touchedFiles.has(outFile)) {
        console.log(hasDiff ? `\n  📝 Written: ${path.relative(PROJECT_ROOT, outFile)}` : `\n  —  Unchanged: ${path.relative(PROJECT_ROOT, outFile)}`);
        touchedFiles.add(outFile);
      }
    }
  }

  // ── Styles (text, paint, effect, grid) ────────────────────────────────────
  // Skip styles when --collection is active: the user scoped the run intentionally.
  if (!COLLECTION_FLAG) {
    const stylesBlock = response.meta && response.meta.styles ? response.meta.styles : {};
    const textStyles   = stylesBlock.text   || [];
    const paintStyles  = stylesBlock.paint  || [];
    const effectStyles = stylesBlock.effect || [];
    const gridStyles   = stylesBlock.grid   || [];

    if (textStyles.length > 0)   logResults.push(syncTextStyles(textStyles));
    if (paintStyles.length > 0)  logResults.push(syncPaintStyles(paintStyles));
    if (effectStyles.length > 0) logResults.push(syncEffectStyles(effectStyles));
    if (gridStyles.length > 0)   logResults.push(syncGridStyles(gridStyles));
  }

  if (!DRY_RUN && logResults.length) writeLog(logResults);

  // Summary
  const totals = logResults.reduce((acc, r) => ({
    added:     acc.added     + r.added,
    changed:   acc.changed   + r.changed,
    removed:   acc.removed   + r.removed,
    unchanged: acc.unchanged + r.unchanged,
  }), { added: 0, changed: 0, removed: 0, unchanged: 0 });

  console.log('\n📊 Results:');
  console.log(`   New:       ${totals.added}`);
  console.log(`   Changed:   ${totals.changed}`);
  console.log(`   Removed:   ${totals.removed} (moved to _removed — review and clear manually)`);
  console.log(`   Unchanged: ${totals.unchanged}`);
  if (DRY_RUN) console.log('\n⚠️  Dry run — no files written. Remove --dry-run to apply.');
  else         console.log('\n✅ Done. Human-authored keys were not touched.');
}

try {
  if (PUSH) push();
  else main();
} catch (err) {
  console.error(`\n❌ Unexpected error: ${err.message}`);
  process.exit(1);
}
