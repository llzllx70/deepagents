---
name: pptxgen2
description: Convert an inputs.md slide plan into LLM-generated per-slide JSON that matches references/data1.json, render each slide with scripts/template1.js, and merge the results into a final PPTX under workspace/pptxgen2. Use when a user asks to build PPTX pages from markdown using the pptxgen2 template workflow.
---
# PptxGen2 Skill

Provide a structured workflow for the LLM to parse inputs.md into slide JSON files (references/data1.json schema), render each slide with scripts/template1.js, and merge the results into a single PPTX. Keep all generated artifacts in workspace/pptxgen2.

## Process

### Step 1: Prepare workspace and inputs

1. Create `workspace/pptxgen2` if it does not exist.
2. Place `inputs.md` in `workspace/pptxgen2/inputs.md`.
3. Run commands from the repo root so relative paths resolve correctly.
4. Follow the input format described below so each slide can be parsed deterministically.

### Step 2: LLM generates slide JSON (no script conversion)

The LLM must read:

- `workspace/pptxgen2/inputs.md`
- `skills/pptxgen2/references/data1.json` (schema reference)

Then it must split the content into slides and **write JSON files** directly to:

- `workspace/pptxgen2/slide001.json`
- `workspace/pptxgen2/slide002.json`
- ...

**Do not use** `md_to_slide_json.py`. The LLM is responsible for conversion and must output JSON that matches `references/data1.json` exactly (same keys and value types, no extra fields).

LLM output rules:

- Keys must be exactly `meta`, `icons`, `leftItems`, `chart`.
- `meta` must include `title` and `subtitle` (use empty strings if missing).
- `icons` must be an array of objects like `{ "path": "..." }` (use `[]` if none).
- `leftItems` must be an array of `{ "image": "...", "title": "...", "body": "..." }` with at least one item.
- `chart` must include `title` and `data`, where `data` is an array of `{ "name": "...", "labels": [...], "values": [...] }`.
- `labels` and `values` lengths must match, and `values` must be numeric.

### Step 3: Render per-slide PPTX

Run one command per slide:

```bash
node skills/pptxgen2/scripts/template1.js workspace/pptxgen2/slide001.json --out workspace/pptxgen2/slide001.pptx
```

### Step 4: Merge slides into the final deck

Run:

```bash
python skills/pptxgen2/scripts/merge_pptx.py workspace/pptxgen2/slide*.pptx \
  --out workspace/pptxgen2/final.pptx
```

## Input Format (inputs.md)

Use slide blocks separated by `---`. Each block must include:

- A slide title (first `#` heading).
- `Left Items` section with bullet lines formatted as: `- image | title | body`.
- `Chart` section with a `Title:` line and series lines formatted as: `- name | label1, label2 | value1, value2`.
- Provide numeric chart values and keep label/value counts aligned.

Example:

```md
# Template One Overview
Subtitle: Balanced layout with left content, right chart, and top-right icons.
Icons: ../demos/common/images/logo_square.png

## Left Items
- ../demos/common/images/peace4.png | Pilot Launch | Release in two regions with initial onboarding and success metrics tracked weekly.
- ../demos/common/images/png-gradient-hex.png | Market Expansion | Scale to 12 markets with unified pricing, localized assets, and partner enablement.
- ../demos/common/images/fediverse_actpub.png | Retention Ops | Automate lifecycle messaging and dashboards to reduce churn and lift NPS.

## Chart
Title: Quarterly Revenue (USD M)
- 2024 | Q1, Q2, Q3, Q4 | 12, 18, 15, 22
- 2025 | Q1, Q2, Q3, Q4 | 16, 21, 19, 26
---
# Next Slide Title
...
```

## Available Tools

- `skills/pptxgen2/scripts/template1.js`: Render a single slide JSON into PPTX.
- `skills/pptxgen2/scripts/merge_pptx.py`: Merge slide PPTX files into a final deck.

## Best Practices

- Keep the slide JSON schema aligned with `skills/pptxgen2/references/data1.json`.
- Use only `template1.js` and `merge_pptx.py` for rendering/merging; do not introduce other rendering scripts.
- Ensure every slide JSON includes all required keys, even if some values are empty.
- Provide at least one left item and one chart series per slide to avoid template errors.
- Keep labels and values counts aligned within each chart series.
- Store all generated files inside `workspace/pptxgen2` only.
