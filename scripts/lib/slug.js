/**
 * Shared kebab-case slug utility
 *
 * Used by sync-tokens.js, generate-tokens.js, and promote-docs.js
 * to guarantee that a given input (Figma collection name, token name, component
 * name, wiki-link target) produces the same on-disk filename, CSS variable, and
 * URL slug across the whole pipeline.
 *
 * Rules:
 *   1. Lowercase
 *   2. Collapse any run of non-alphanumeric characters into a single "-"
 *   3. Trim leading/trailing "-"
 *
 * Examples:
 *   "UI Elements/primary"         → "ui-elements-primary"
 *   "amber/1"                      → "amber-1"
 *   "Mode Toggle"                  → "mode-toggle"
 *   "Focus & Interaction States"   → "focus-interaction-states"
 *   "Product Card v2"              → "product-card-v2"
 */
function kebab(input) {
  if (input == null) return '';
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { kebab };
