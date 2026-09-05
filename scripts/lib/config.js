'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'design-system.config.js');

const DEFAULT_CONFIG = {
  projectName: 'Design System Workspace',
  cssPrefix: '',
  paths: {
    tokens: 'design-system/tokens',
    css: 'design-system/css/tokens.css',
    js: 'design-system/js/tokens.js',
    figmaCache: 'design-system/figma-cache',
    docsSource: 'docs/vault',
    generatedTokens: 'docs/generated/tokens',
    siteDocsRoot: 'docs/site/docs/design-system',
  },
  collectionMap: [
    { match: ['primitives', 'primitive', 'colour', 'color'], file: 'colors.json' },
    { match: ['tokens', 'semantic'], file: 'colors.json' },
    { match: ['spatial', 'spacing', 'layout'], file: 'spacing.json' },
    { match: ['motion', 'animation'], file: 'motion.json' },
    { match: ['typography', 'type'], file: 'typography.json' },
  ],
  stylesTarget: {
    text: 'typography.json',
    paint: 'colors.json',
    effect: 'spacing.json',
    grid: 'spacing.json',
  },
  docs: {
    baseSlug: '/design-system',
    tokensSlugBase: '/design-system/tokens',
    componentsSlugBase: '/design-system/components',
    sourceName: 'Markdown vault',
    recommendedEditor: 'Obsidian',
  },
};

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    paths: { ...base.paths, ...(override.paths || {}) },
    stylesTarget: { ...base.stylesTarget, ...(override.stylesTarget || {}) },
    docs: { ...base.docs, ...(override.docs || {}) },
    collectionMap: override.collectionMap || base.collectionMap,
  };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  return mergeConfig(DEFAULT_CONFIG, require(CONFIG_FILE));
}

function fromRoot(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

function configuredPath(config, key, ...parts) {
  return fromRoot(config.paths[key], ...parts);
}

module.exports = {
  PROJECT_ROOT,
  loadConfig,
  configuredPath,
};
