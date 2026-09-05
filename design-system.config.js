module.exports = {
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
