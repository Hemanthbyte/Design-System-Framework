# Agent Guidance

This workspace keeps Figma tokens, local token artifacts, and design-system documentation aligned.

## Start Here
- Read `README.md` and `design-system.config.js`.
- Treat Figma as the canonical source for visual token values in v1.
- Treat `docs/vault/` as the editable documentation source. Obsidian is recommended, but any markdown editor works.
- Do not edit generated artifacts directly.

## Ownership
- Scripts own `_sync` blocks inside `design-system/tokens/*.json`.
- Humans own token metadata outside `_sync`.
- Humans own prose in `docs/vault/`.
- Generated CSS, JS, markdown references, and site docs are outputs.

## Workflow
- Figma plugin export writes `variables-export.json`.
- `npm run sync` imports that export into local token JSON.
- `npm run generate` creates CSS, JS, and token reference markdown.
- `npm run promote` publishes vault docs and generated references into the site docs folder.

## Constraints
- Keep project-specific names and paths in `design-system.config.js`.
- Keep user-facing docs generic and reusable.
- AI can help draft and organize documentation, but the workflow must remain usable without AI.
