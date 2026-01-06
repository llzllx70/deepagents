---
name: coze-search
description: Run web searches through the Coze stream_run API and capture results for downstream tasks. Use when tasks require Coze search instead of default web_search/tavily, or when a process mandates logging queries, filters, and source links from Coze results.
---

# Coze Search

## Quick start

1. Run `scripts/coze_search.sh "<query>"` to execute a Coze search.
2. Replace `<query>` with the real keywords.
3. Optional overrides via env vars: `COZE_TOKEN`, `COZE_FLOW_ID`, `COZE_APP_ID`.

## Logging expectations

- Record query, filters, timestamp, source site/platform, and source URL in the task's search log.

## Guardrails

- Do not use `web_search` or `tavily` when this skill is requested.
- If the environment blocks network access, request approval or use offline data and note the limitation in outputs.
