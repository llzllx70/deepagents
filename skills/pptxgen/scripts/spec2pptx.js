#!/usr/bin/env node
/**
 * Generate a beautiful PPTX from a JSON spec using PptxGenJS.
 *
 * Usage:
 *   node skills/pptxgen/scripts/spec2pptx.js deck.spec.json out.pptx
 *   node skills/pptxgen/scripts/spec2pptx.js --in deck.spec.json --out out.pptx --theme modernLight --layout LAYOUT_16x9
 */
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

const EMU_PER_IN = 914400;

function die(message) {
  console.error(`\n[pptxgen] ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  const absPath = path.resolve(filePath);
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    die(`Failed to read JSON: ${absPath}\n${err.message}`);
  }
}

function ensureObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) die(`${name} must be an object`);
  return value;
}

function ensureArray(value, name) {
  if (!Array.isArray(value)) die(`${name} must be an array`);
  return value;
}

function normalizeHexColor(color) {
  if (color == null) return color;
  if (typeof color !== 'string') die(`Color must be string, got: ${typeof color}`);
  const trimmed = color.trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{6}$/.test(withoutHash)) die(`Invalid hex color (expect RRGGBB): "${color}"`);
  return withoutHash.toUpperCase();
}

function deepNormalizeColors(value) {
  if (Array.isArray(value)) return value.map(deepNormalizeColors);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && /(^#?[0-9a-fA-F]{6}$)/.test(val.trim()) && /color/i.test(key)) {
      out[key] = normalizeHexColor(val);
    } else {
      out[key] = deepNormalizeColors(val);
    }
  }
  return out;
}

function getSlideSizeInches(pptx) {
  if (pptx.presLayout && pptx.presLayout.width && pptx.presLayout.height) {
    return {
      w: pptx.presLayout.width / EMU_PER_IN,
      h: pptx.presLayout.height / EMU_PER_IN
    };
  }
  // Fallback (PptxGenJS wide)
  return { w: 13.333, h: 7.5 };
}

function parseArgs(argv) {
  const args = { in: null, out: null, theme: null, layout: null };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--theme') args.theme = argv[++i];
    else if (a === '--layout') args.layout = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else positional.push(a);
  }

  if (!args.in && positional[0]) args.in = positional[0];
  if (!args.out && positional[1]) args.out = positional[1];
  return args;
}

const THEMES = {
  modernLight: {
    name: 'modernLight',
    fonts: { head: 'Arial', body: 'Arial' },
    colors: {
      bg: 'FFFFFF',
      fg: '0B1220',
      muted: '334155',
      subtle: 'E2E8F0',
      accent: '635BFF',
      accent2: '14B8A6',
      card: 'F8FAFC'
    }
  },
  modernDark: {
    name: 'modernDark',
    fonts: { head: 'Arial', body: 'Arial' },
    colors: {
      bg: '0B1220',
      fg: 'F8FAFC',
      muted: 'CBD5E1',
      subtle: '1F2937',
      accent: 'A78BFA',
      accent2: '22C55E',
      card: '111827'
    }
  }
};

function pickTheme(specThemeName, specTheme) {
  const themeName = specThemeName || specTheme?.name || 'modernLight';
  const base = THEMES[themeName] || THEMES.modernLight;
  const merged = {
    ...base,
    ...specTheme,
    fonts: { ...base.fonts, ...(specTheme?.fonts || {}) },
    colors: { ...base.colors, ...(specTheme?.colors || {}) }
  };
  merged.colors = Object.fromEntries(
    Object.entries(merged.colors).map(([k, v]) => [k, normalizeHexColor(v)])
  );
  return merged;
}

function addBg(slide, size, theme) {
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    fill: { color: theme.colors.bg },
    line: { color: theme.colors.bg }
  });
}

function addTopAccent(slide, size, theme) {
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: size.w,
    h: 0.18,
    fill: { color: theme.colors.accent },
    line: { color: theme.colors.accent }
  });
}

function addTitle(slide, size, theme, text) {
  slide.addText(text || '', {
    x: 1.0,
    y: 0.55,
    w: size.w - 2.0,
    h: 0.6,
    fontFace: theme.fonts.head,
    fontSize: 30,
    bold: true,
    color: theme.colors.fg
  });

  slide.addShape('rect', {
    x: 1.0,
    y: 1.2,
    w: 0.6,
    h: 0.06,
    fill: { color: theme.colors.accent2 },
    line: { color: theme.colors.accent2 }
  });
}

function flattenBullets(bullets, level = 0, out = []) {
  if (!bullets) return out;
  if (typeof bullets === 'string') {
    out.push({ text: bullets, level });
    return out;
  }
  if (Array.isArray(bullets)) {
    for (const item of bullets) {
      if (typeof item === 'string') out.push({ text: item, level });
      else if (item && typeof item === 'object') {
        if (typeof item.text === 'string') out.push({ text: item.text, level: item.level ?? level });
        if (item.items) flattenBullets(item.items, (item.level ?? level) + 1, out);
      }
    }
  }
  return out;
}

function bulletsToRuns(bullets, { baseIndentPt = 18 } = {}) {
  const flat = flattenBullets(bullets);
  const runs = [];
  flat.forEach((b, idx) => {
    const indent = baseIndentPt + Math.max(0, b.level || 0) * 14;
    runs.push({
      text: String(b.text || '').trim(),
      options: {
        bullet: { indent },
        breakLine: idx !== flat.length - 1
      }
    });
  });
  return runs;
}

function addBullets(slide, theme, box, bullets, style = {}) {
  const runs = bulletsToRuns(bullets, { baseIndentPt: style.baseIndentPt ?? 20 });
  slide.addText(runs, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fontFace: style.fontFace || theme.fonts.body,
    fontSize: style.fontSize ?? 18,
    color: style.color || theme.colors.muted,
    valign: 'top',
    margin: style.margin ?? [10, 6, 0, 0],
    lineSpacingMultiple: style.lineSpacingMultiple ?? 1.2
  });
}

function addCard(slide, theme, box) {
  slide.addShape('roundRect', {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fill: { color: theme.colors.card },
    line: { color: theme.colors.subtle, width: 1 },
    rectRadius: 0.15
  });
}

function slideTitle(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addTopAccent(slide, size, theme);
  slide.addShape('ellipse', {
    x: -0.8,
    y: size.h - 2.2,
    w: 2.6,
    h: 2.6,
    fill: { color: theme.colors.accent2, transparency: 85 },
    line: { color: theme.colors.accent2, transparency: 100 }
  });
  slide.addShape('ellipse', {
    x: size.w - 2.3,
    y: -0.9,
    w: 2.8,
    h: 2.8,
    fill: { color: theme.colors.accent, transparency: 88 },
    line: { color: theme.colors.accent, transparency: 100 }
  });

  slide.addText(slideSpec.title || '', {
    x: 1.0,
    y: 2.35,
    w: size.w - 2.0,
    h: 1.1,
    fontFace: theme.fonts.head,
    fontSize: 48,
    bold: true,
    color: theme.colors.fg
  });
  if (slideSpec.subtitle) {
    slide.addText(slideSpec.subtitle, {
      x: 1.05,
      y: 3.55,
      w: size.w - 2.1,
      h: 0.8,
      fontFace: theme.fonts.body,
      fontSize: 20,
      color: theme.colors.muted
    });
  }
  if (slideSpec.meta) {
    slide.addText(slideSpec.meta, {
      x: 1.05,
      y: 6.9,
      w: size.w - 2.1,
      h: 0.4,
      fontFace: theme.fonts.body,
      fontSize: 12,
      color: theme.colors.muted
    });
  }
}

function slideSection(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    fill: { color: theme.colors.accent, transparency: theme.name === 'modernDark' ? 75 : 88 },
    line: { color: theme.colors.accent, transparency: 100 }
  });
  slide.addShape('rect', {
    x: 0,
    y: size.h * 0.55,
    w: size.w,
    h: size.h * 0.45,
    fill: { color: theme.colors.bg },
    line: { color: theme.colors.bg }
  });
  slide.addText(slideSpec.title || '', {
    x: 1.0,
    y: 2.3,
    w: size.w - 2.0,
    h: 1.2,
    fontFace: theme.fonts.head,
    fontSize: 46,
    bold: true,
    color: theme.colors.fg
  });
  if (slideSpec.subtitle) {
    slide.addText(slideSpec.subtitle, {
      x: 1.05,
      y: 3.65,
      w: size.w - 2.1,
      h: 0.6,
      fontFace: theme.fonts.body,
      fontSize: 18,
      color: theme.colors.muted
    });
  }
}

function slideContent(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addTopAccent(slide, size, theme);
  addTitle(slide, size, theme, slideSpec.title);

  const left = { x: 1.05, y: 1.55, w: 6.55, h: 5.6 };
  const right = { x: 7.85, y: 1.55, w: size.w - 8.9, h: 5.6 };

  addBullets(slide, theme, left, slideSpec.bullets || []);

  if (slideSpec.aside) {
    addCard(slide, theme, right);
    const asideTitle = slideSpec.aside.title || '';
    if (asideTitle) {
      slide.addText(asideTitle, {
        x: right.x + 0.35,
        y: right.y + 0.25,
        w: right.w - 0.7,
        h: 0.5,
        fontFace: theme.fonts.head,
        fontSize: 16,
        bold: true,
        color: theme.colors.fg
      });
    }
    if (slideSpec.aside.bullets) {
      addBullets(
        slide,
        theme,
        { x: right.x + 0.25, y: right.y + 0.75, w: right.w - 0.5, h: right.h - 1.0 },
        slideSpec.aside.bullets,
        { fontSize: 14, margin: [8, 6, 0, 0], baseIndentPt: 16 }
      );
    } else if (slideSpec.aside.text) {
      slide.addText(String(slideSpec.aside.text), {
        x: right.x + 0.35,
        y: right.y + 0.75,
        w: right.w - 0.7,
        h: right.h - 1.0,
        fontFace: theme.fonts.body,
        fontSize: 14,
        color: theme.colors.muted,
        valign: 'top'
      });
    }
  }
}

function slideChart(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addTopAccent(slide, size, theme);
  addTitle(slide, size, theme, slideSpec.title);

  const left = { x: 1.05, y: 1.55, w: 5.8, h: 5.6 };
  const right = { x: 7.25, y: 1.55, w: size.w - 8.3, h: 5.6 };

  if (slideSpec.bullets) addBullets(slide, theme, left, slideSpec.bullets);
  addCard(slide, theme, right);

  const chart = ensureObject(slideSpec.chart || {}, 'slide.chart');
  const chartType = chart.type || 'bar';
  const data = ensureArray(chart.data || [], 'slide.chart.data');
  const options = deepNormalizeColors(chart.options || {});

  slide.addChart(chartType, data, {
    x: right.x + 0.25,
    y: right.y + 0.25,
    w: right.w - 0.5,
    h: right.h - 0.5,
    ...(options || {})
  });
}

function toTableRows(table2d) {
  if (!Array.isArray(table2d)) die('slide.table.rows must be a 2D array');
  return table2d.map((row) => {
    if (!Array.isArray(row)) die('slide.table.rows must be a 2D array');
    return row.map((cell) => ({ text: cell == null ? '' : String(cell) }));
  });
}

function slideTable(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addTopAccent(slide, size, theme);
  addTitle(slide, size, theme, slideSpec.title);

  const table = ensureObject(slideSpec.table || {}, 'slide.table');
  const rows = toTableRows(table.rows || []);
  const options = deepNormalizeColors(table.options || {});

  const box = { x: 1.0, y: 1.55, w: size.w - 2.0, h: 5.7 };
  addCard(slide, theme, box);

  slide.addTable(rows, {
    x: box.x + 0.25,
    y: box.y + 0.25,
    w: box.w - 0.5,
    h: box.h - 0.5,
    fontFace: theme.fonts.body,
    fontSize: 12,
    color: theme.colors.fg,
    fill: { color: theme.colors.card },
    border: { type: 'solid', color: theme.colors.subtle, pt: 1 },
    ...(options || {})
  });
}

function slideImage(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addTopAccent(slide, size, theme);
  addTitle(slide, size, theme, slideSpec.title);

  const img = ensureObject(slideSpec.image || {}, 'slide.image');
  const box = { x: 1.0, y: 1.55, w: size.w - 2.0, h: 5.6 };
  addCard(slide, theme, box);

  slide.addImage(
    deepNormalizeColors({
      ...img,
      x: img.x ?? box.x + 0.25,
      y: img.y ?? box.y + 0.25,
      w: img.w ?? box.w - 0.5,
      h: img.h ?? box.h - 0.75
    })
  );

  if (slideSpec.caption) {
    slide.addText(String(slideSpec.caption), {
      x: box.x + 0.25,
      y: box.y + box.h - 0.45,
      w: box.w - 0.5,
      h: 0.35,
      fontFace: theme.fonts.body,
      fontSize: 12,
      italic: true,
      color: theme.colors.muted
    });
  }
}

function slideQuote(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    fill: { color: theme.colors.accent, transparency: theme.name === 'modernDark' ? 78 : 90 },
    line: { color: theme.colors.accent, transparency: 100 }
  });
  slide.addShape('roundRect', {
    x: 1.1,
    y: 1.35,
    w: size.w - 2.2,
    h: size.h - 2.7,
    fill: { color: theme.colors.bg },
    line: { color: theme.colors.subtle, transparency: 40 },
    rectRadius: 0.2
  });
  slide.addText(slideSpec.quote || '', {
    x: 1.65,
    y: 2.05,
    w: size.w - 3.3,
    h: 3.4,
    fontFace: theme.fonts.head,
    fontSize: 28,
    italic: true,
    color: theme.colors.fg,
    valign: 'top'
  });
  if (slideSpec.author) {
    slide.addText(`— ${slideSpec.author}`, {
      x: 1.65,
      y: 5.55,
      w: size.w - 3.3,
      h: 0.5,
      fontFace: theme.fonts.body,
      fontSize: 14,
      color: theme.colors.muted,
      align: 'right'
    });
  }
}

function addRawElements(pptx, slide, slideSpec) {
  const elements = slideSpec.elements;
  if (!elements) return;
  if (!Array.isArray(elements)) die('slide.elements must be an array');

  for (const el of elements) {
    if (!el || typeof el !== 'object') die('slide.elements item must be an object');
    const type = el.type;
    if (!type) die('slide.elements item missing "type"');

    if (type === 'text') {
      slide.addText(el.text ?? '', deepNormalizeColors(el.options || {}));
    } else if (type === 'shape') {
      slide.addShape(el.shape || 'rect', deepNormalizeColors(el.options || {}));
    } else if (type === 'image') {
      slide.addImage(deepNormalizeColors(el.options || {}));
    } else if (type === 'media') {
      slide.addMedia(deepNormalizeColors(el.options || {}));
    } else if (type === 'chart') {
      slide.addChart(el.chartType || 'bar', el.data || [], deepNormalizeColors(el.options || {}));
    } else if (type === 'table') {
      slide.addTable(toTableRows(el.rows || []), deepNormalizeColors(el.options || {}));
    } else {
      die(`Unknown element type: "${type}"`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.in || !args.out) {
    console.log(
      [
        'Usage:',
        '  node skills/pptxgen/scripts/spec2pptx.js deck.spec.json out.pptx',
        '  node skills/pptxgen/scripts/spec2pptx.js --in deck.spec.json --out out.pptx --theme modernLight --layout LAYOUT_16x9',
        '',
        'Themes:',
        `  ${Object.keys(THEMES).join(', ')}`
      ].join('\n')
    );
    process.exit(args.help ? 0 : 1);
  }

  const spec = ensureObject(readJson(args.in), 'spec');
  const meta = ensureObject(spec.meta || {}, 'spec.meta');
  const slides = ensureArray(spec.slides || [], 'spec.slides');

  const pptx = new pptxgen();
  pptx.layout = args.layout || meta.layout || 'LAYOUT_16x9';

  const theme = pickTheme(args.theme || meta.theme, spec.theme);
  pptx.theme = { headFontFace: theme.fonts.head, bodyFontFace: theme.fonts.body };

  if (meta.author) pptx.author = String(meta.author);
  if (meta.company) pptx.company = String(meta.company);
  if (meta.subject) pptx.subject = String(meta.subject);
  if (meta.title) pptx.title = String(meta.title);

  const size = getSlideSizeInches(pptx);

  for (const slideSpecRaw of slides) {
    const slideSpec = ensureObject(slideSpecRaw, 'slide');
    const slide = pptx.addSlide();

    const t = slideSpec.type || 'content';
    if (t === 'title') slideTitle(slide, size, theme, slideSpec);
    else if (t === 'section') slideSection(slide, size, theme, slideSpec);
    else if (t === 'content') slideContent(slide, size, theme, slideSpec);
    else if (t === 'chart') slideChart(slide, size, theme, slideSpec);
    else if (t === 'table') slideTable(slide, size, theme, slideSpec);
    else if (t === 'image') slideImage(slide, size, theme, slideSpec);
    else if (t === 'quote') slideQuote(slide, size, theme, slideSpec);
    else if (t === 'blank') addBg(slide, size, theme);
    else die(`Unknown slide.type: "${t}"`);

    addRawElements(pptx, slide, slideSpec);
    if (slideSpec.notes) slide.addNotes(String(slideSpec.notes));
  }

  const outPath = path.resolve(args.out);
  await pptx.writeFile({ fileName: outPath });
  console.log(`[pptxgen] Wrote ${outPath}`);
}

main().catch((err) => die(err.stack || err.message || String(err)));
