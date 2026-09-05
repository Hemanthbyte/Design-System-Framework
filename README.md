# Design System Framework

A complete, local-first framework that provides two-way synchronization between Figma and your code artifacts without requiring a Figma Organization plan.

## What problem does it solve?
Maintaining a design system usually means that Figma (the design source of truth) and code quickly drift apart. Bounding these together via automation typically requires the **Figma Variables REST API**, which is locked behind the expensive Figma Organization Tier ($45/editor/month).

This framework solves that by cleverly leveraging the free Figma Plugin API to export variables locally, and then running a local Node.js pipeline to sync those tokens perfectly into CSS variables, JS modules, and automated Docusaurus reference tables.

## Who is it for?
Design System engineers, solo developers, and agile teams who want enterprise-grade token synchronization and documentation pipelines, but do not want to pay for Enterprise-grade pricing.

## What does it do?
- **Two-way Sync:** Reads a JSON export from our custom Figma Plugin and cleverly injects only the semantic variables into local JSON files via `_sync` blocks.
- **Code Generation:** Flattens your tokens into consumable CSS custom properties and JS configurations.
- **Documentation Engine:** Extracts Markdown component specifications (written comfortably in an Obsidian-friendly vault) and auto-promotes them to a Docusaurus static site.

---

## Metrics & Savings (How is this useful?)

- **Cost Effectiveness:** Provides REST API-like programmatic token synchronization—a feature typically restricted to the Figma Organization plan ($45/editor/month)—by using the free Figma Plugin API.
  
- **Time Savings:** Replaces an estimated **10+ hours per month** of manual designer-to-developer token handoff, transcription, PRs, and CSS updates with a single 2-second `npm run sync` command.
  
- **AI Token Efficiency (MCP Optimization):** Directly querying the Figma API via an AI MCP tool returns deeply nested payloads that can easily exceed **150,000+ context tokens** for a full design system (costing ~$3+ in API fees per read and frequently maxing out context windows). By extracting and flattening Figma Node IDs and metadata into our local JSON registry, the context load is reduced to roughly **~2,000 tokens** per agentic read. This **~98% reduction in context window consumption** prevents API throttling, slashes latency, and allows autonomous AI agents to parse the entire design system instantly and cheaply.

---

## Features
- Two-way Figma Plugin sync (Pull from Figma, push to Figma)
- Automated Token Artifact Generation (CSS, JS)
- Component Markdown Vault (Obsidian-friendly)
- Auto-generation of Markdown Component Stubs from Figma Component Sets
- One-command Docusaurus Docs Promotion
- Agent-Agnostic Governance (`AGENTS.md`)

## Installation

1. **Clone the scaffold:**
   ```bash
   npx degit your-org/design-system-framework my-design-system
   cd my-design-system
   ```

2. **Run the universal setup script:**
   ```bash
   npm run setup
   ```
   *This automatically installs the root dependencies and initializes the Docusaurus documentation site.*

3. **Configure Environment:**
   Copy `.env.example` to `.env` and configure any specific absolute paths required for cross-OS setups.

4. **Install the Figma Plugin (Figma Desktop Required):**
   To sync your tokens, you must install the bundled local Figma plugin:
   - Open the **Figma Desktop App** (Local plugins do not work in the browser).
   - Open your Design System file.
   - Go to **Plugins > Development > Import plugin from manifest...**
   - Select the `figma-plugin/manifest.json` file inside your cloned repository.
   - The plugin is now available in your Development plugins list. Use it to Export your variables!

## Usage

The framework operates on a linear, three-step pipeline:

### 1. Sync Figma Tokens
After exporting your variables from the local Figma Plugin:
```bash
npm run sync
```
This script reads the exported variables and writes them into `_sync` blocks inside your `design-system/tokens/` JSON files.

### 2. Generate Artifacts
```bash
npm run generate
```
This reads your local tokens and auto-generates your framework-agnostic CSS variables and JS constants.

### 3. Promote Documentation
```bash
npm run promote
```
This grabs your handwritten markdown from `docs/vault/`, strips the `_sync` frontmatter, injects auto-generated token tables, and pushes the final polished Markdown to the `docs/site/` Docusaurus engine.

### 4. View the Site
```bash
npm run docs:start
```
Launch the live, white-labeled documentation site locally on `localhost:3000`.

### 5. Sync Figma Components (Optional)
To automatically generate Markdown specification stubs in your Obsidian vault for every Component Set in your Figma file:
```bash
npm run sync:components
```

### 6. Two-Way Sync: Pushing to Figma (Optional)
If a developer alters a token value locally in the JSON files, you can push that change back into Figma:
```bash
npm run sync:push
```
Then open the local Figma Plugin, switch to the **Import** tab, and load the generated `variables-import.json` file to instantly update your Figma file!

## Technical Architecture
The framework enforces a strict boundary between **Script-owned data** and **Human-owned data**. 
- Script-owned data is stored in `_sync` JSON blocks or Markdown Frontmatter. It is automatically overwritten by the pipeline.
- Human-owned data is the surrounding prose and structure. It is never overwritten by the pipeline.

## Limitations
- **Figma is Canonical:** For v1, Figma remains the canonical editor for adding or deleting tokens.
- **Manual Export Required:** Because we leverage the free Plugin API (to save costs) instead of the REST API, token syncing requires manually clicking "Export" in the local Figma plugin rather than running a headless cron job.

## Roadmap
- Support for composite design patterns and recipes.
- Automated Design Decision Records (ADRs) tracking inside the markdown vault.

## License
MIT License
