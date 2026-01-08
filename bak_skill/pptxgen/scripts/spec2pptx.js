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
    // Prefer a modern Chinese UI font; PowerPoint will fall back if missing.
    fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei' },
    colors: {
      bg: 'FFFFFF', // card/background
      canvas: 'F5F7FB', // slide canvas
      fg: '0B1220',
      muted: '334155',
      subtle: 'D9E2EF', // borders
      accent: '00B894', // teal (underline)
      accent2: '2F80ED', // blue (secondary)
      card: 'FFFFFF',
      danger: 'EF4444',
      warn: 'F97316',
      success: '22C55E'
    }
  },
  modernDark: {
    name: 'modernDark',
    fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei' },
    colors: {
      bg: '0B1220',
      canvas: '070B14',
      fg: 'F8FAFC',
      muted: 'CBD5E1',
      subtle: '1F2937',
      accent: '22C55E',
      accent2: '60A5FA',
      card: '0E1628',
      danger: 'F87171',
      warn: 'FDBA74',
      success: '34D399'
    }
  },
  eduLight: {
    name: 'eduLight',
    fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei' },
    colors: {
      bg: 'FFFFFF',
      canvas: 'F5F7FB',
      fg: '0B1220',
      muted: '334155',
      subtle: 'D9E2EF',
      accent: '00B894',
      accent2: '2F80ED',
      card: 'FFFFFF',
      danger: 'EF4444',
      warn: 'F97316',
      success: '22C55E'
    }
  },
  eduDark: {
    name: 'eduDark',
    fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei' },
    colors: {
      bg: '0B1220',
      canvas: '070B14',
      fg: 'F8FAFC',
      muted: 'CBD5E1',
      subtle: '1F2937',
      accent: '22C55E',
      accent2: '60A5FA',
      card: '0E1628',
      danger: 'F87171',
      warn: 'FDBA74',
      success: '34D399'
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
    fill: { color: theme.colors.canvas || theme.colors.bg },
    line: { color: theme.colors.canvas || theme.colors.bg }
  });
}

function addHeader(slide, size, theme, title, opts = {}) {
  const x = opts.x ?? 0.95;
  const y = opts.y ?? 0.6;
  const w = opts.w ?? size.w - 1.9;

  slide.addText(title || '', {
    x,
    y,
    w,
    h: 0.75,
    fontFace: theme.fonts.head,
    fontSize: opts.fontSize ?? 40,
    bold: true,
    color: theme.colors.fg
  });

  slide.addShape('rect', {
    x,
    y: y + 0.82,
    w: opts.underlineW ?? 0.95,
    h: 0.08,
    fill: { color: theme.colors.accent },
    line: { color: theme.colors.accent }
  });

  if (opts.kicker) {
    slide.addText(String(opts.kicker), {
      x,
      y: y - 0.28,
      w,
      h: 0.25,
      fontFace: theme.fonts.body,
      fontSize: 12,
      color: theme.colors.muted
    });
  }
}

function clampBox(size, box, pad = 0) {
  const x = Math.max(pad, box.x);
  const y = Math.max(pad, box.y);
  const w = Math.max(0.1, Math.min(box.w, size.w - x - pad));
  const h = Math.max(0.1, Math.min(box.h, size.h - y - pad));
  return { x, y, w, h };
}

function getLayout(size) {
  const marginX = 0.9;
  const bodyY = 1.65;
  const marginBottom = 0.55;
  const body = { x: marginX, y: bodyY, w: size.w - marginX * 2, h: size.h - bodyY - marginBottom };
  return {
    marginX,
    marginBottom,
    body,
    gap: 0.5
  };
}

function countPlainChars(s) {
  return String(s || '').replace(/\s+/g, '').length;
}

function estimateCharsPerLine(boxWIn, fontSizePt, indentLevel = 0) {
  // Very rough heuristic: CJK ~ 1em width, Latin ~ 0.55em average.
  // Use a conservative estimate to avoid overflow.
  const base = (boxWIn * 72) / (fontSizePt * 1.05);
  const indentPenalty = indentLevel * 2.4;
  return Math.max(6, Math.floor(base - indentPenalty));
}

function estimateLinesForText(text, boxWIn, fontSizePt, indentLevel = 0) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const cpl = estimateCharsPerLine(boxWIn, fontSizePt, indentLevel);
  // Count CJK and others equally; good enough for overflow prevention.
  const chars = countPlainChars(t);
  return Math.max(1, Math.ceil(chars / cpl));
}

function estimateMaxLines(boxHIn, fontSizePt, lineSpacingMultiple = 1.2) {
  const lineH = fontSizePt * Math.max(1.05, lineSpacingMultiple) * 1.15;
  const max = Math.floor((boxHIn * 72) / lineH);
  return Math.max(3, max);
}

function flattenBulletsWithLevel(bullets) {
  const flat = [];
  flattenBullets(bullets, 0, flat);
  return flat.map((b) => ({ text: String(b.text || ''), level: Math.max(0, b.level || 0) }));
}

function estimateLinesForBullets(bullets, boxWIn, fontSizePt, lineSpacingMultiple = 1.2) {
  const flat = flattenBulletsWithLevel(bullets);
  const per = flat.map((b) => estimateLinesForText(b.text, boxWIn, fontSizePt, b.level));
  // +0.2 line per bullet for bullet glyph + spacing; bias conservative
  const total = per.reduce((a, n) => a + n + 0.2, 0);
  const maxLines = estimateMaxLines(1, fontSizePt, lineSpacingMultiple); // normalized
  return { totalLines: total, perBulletLines: per, maxLinesNorm: maxLines };
}

function splitBulletsToFit(bullets, boxWIn, boxHIn, fontSizePt, lineSpacingMultiple = 1.2) {
  const flat = flattenBulletsWithLevel(bullets);
  if (!flat.length) return [{ bullets, fitFontSize: fontSizePt }];

  let fitFontSize = fontSizePt;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const maxLines = estimateMaxLines(boxHIn, fitFontSize, lineSpacingMultiple);
    const lines = flat.map((b) => estimateLinesForText(b.text, boxWIn, fitFontSize, b.level) + 0.2);
    const total = lines.reduce((a, n) => a + n, 0);
    if (total <= maxLines) return [{ bullets, fitFontSize }];
    fitFontSize -= 1;
    if (fitFontSize <= 12) break;
  }

  // Paginate by estimated lines at the best-fit font size (>=12).
  fitFontSize = Math.max(12, fitFontSize);
  const maxLines = estimateMaxLines(boxHIn, fitFontSize, lineSpacingMultiple);
  const pages = [];
  let current = [];
  let used = 0;

  const pushPage = () => {
    if (!current.length) return;
    pages.push({ bullets: current.map((b) => (b.level ? { text: b.text, level: b.level } : b.text)), fitFontSize });
    current = [];
    used = 0;
  };

  for (const b of flat) {
    const need = estimateLinesForText(b.text, boxWIn, fitFontSize, b.level) + 0.2;
    if (current.length && used + need > maxLines) pushPage();
    current.push(b);
    used += need;
  }
  pushPage();
  return pages.length ? pages : [{ bullets, fitFontSize }];
}

function decideContentVariant(slideSpec, size) {
  const layout = getLayout(size);
  const aside = slideSpec.aside ? ensureObject(slideSpec.aside, 'slide.aside') : null;
  const bullets = slideSpec.bullets || [];
  const hasAsideBullets = !!aside?.bullets;
  const asideTextLen = aside?.text ? countPlainChars(aside.text) : 0;

  const layoutHint = slideSpec.layout;
  const wantsTwoCol = layoutHint === 'twoCol';
  const wantsOneCol = layoutHint === 'oneCol';
  const wantsTiles = layoutHint === 'tiles';

  const canTiles =
    !aside &&
    Array.isArray(bullets) &&
    bullets.length >= 3 &&
    bullets.length <= 6 &&
    bullets.every((b) => typeof b === 'string' && countPlainChars(b) <= 18);

  const isDense = (() => {
    const flat = flattenBulletsWithLevel(bullets);
    if (!flat.length) return false;
    const avg = flat.reduce((a, b) => a + countPlainChars(b.text), 0) / flat.length;
    return avg >= 28 || flat.length >= 6;
  })();

  if (wantsTiles && canTiles) return { variant: 'tiles', layout };
  if (wantsOneCol) return { variant: 'oneCol', layout };
  if (wantsTwoCol) return { variant: 'twoCol', layout };
  if (!aside) return { variant: canTiles ? 'tiles' : 'oneCol', layout };
  if (hasAsideBullets) return { variant: 'twoCol', layout };
  if (asideTextLen <= 22) return { variant: 'oneColCallout', layout };
  if (isDense) return { variant: 'oneColCallout', layout };
  return { variant: 'twoCol', layout };
}

function getContentBoxes(size, slideSpec) {
  const { variant, layout } = decideContentVariant(slideSpec, size);
  const bodyBox = clampBox(size, layout.body);

  const aside = slideSpec.aside ? ensureObject(slideSpec.aside, 'slide.aside') : null;
  const hasAsideBullets = !!aside?.bullets;
  const asideTextLen = aside?.text ? countPlainChars(aside.text) : 0;

  const leftBox = (() => {
    if (variant === 'twoCol') {
      const asideWeight = hasAsideBullets ? 1 : 0;
      const calloutW = Math.min(
        4.6,
        Math.max(3.0, layout.body.w * (0.28 + asideWeight * 0.06 + Math.min(0.12, asideTextLen / 300)))
      );
      return clampBox(size, {
        x: layout.body.x,
        y: layout.body.y,
        w: layout.body.w - calloutW - layout.gap,
        h: layout.body.h
      });
    }
    return bodyBox;
  })();

  const rightBox = (() => {
    if (variant !== 'twoCol') return null;
    const x = leftBox.x + leftBox.w + layout.gap;
    return clampBox(size, { x, y: leftBox.y, w: bodyBox.x + bodyBox.w - x, h: leftBox.h });
  })();

  const bulletsBox = (() => {
    if (variant === 'tiles') return null;
    return { x: leftBox.x + 0.32, y: leftBox.y + 0.28, w: leftBox.w - 0.64, h: leftBox.h - 0.56 };
  })();

  return { variant, layout, bodyBox, leftBox, rightBox, bulletsBox };
}

function paginateContentSlide(slideSpec, size) {
  const { variant, bulletsBox } = getContentBoxes(size, slideSpec);
  if (variant === 'tiles' || !bulletsBox) return [slideSpec];

  const bullets = slideSpec.bullets || [];
  const pages = splitBulletsToFit(bullets, bulletsBox.w, bulletsBox.h, 18, 1.22);
  if (pages.length <= 1) {
    return [
      {
        ...slideSpec,
        style: { ...(slideSpec.style || {}), bulletFontSize: pages[0]?.fitFontSize ?? 18 }
      }
    ];
  }

  return pages.map((p, idx) => ({
    ...slideSpec,
    title: idx === 0 ? slideSpec.title : `${slideSpec.title || ''}（续）`,
    bullets: p.bullets,
    aside: idx === 0 ? slideSpec.aside : null,
    style: { ...(slideSpec.style || {}), bulletFontSize: p.fitFontSize ?? 18 }
  }));
}

function addShadowedCard(slide, theme, box, { accentBarColor, accentBarW } = {}) {
  const b = box;
  // Shadow
  slide.addShape('roundRect', {
    x: b.x + 0.05,
    y: b.y + 0.06,
    w: b.w,
    h: b.h,
    fill: { color: '000000', transparency: theme.name.includes('Dark') ? 78 : 90 },
    line: { color: '000000', transparency: 100 },
    rectRadius: 0.14
  });
  // Card
  slide.addShape('roundRect', {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    fill: { color: theme.colors.card || theme.colors.bg },
    line: { color: theme.colors.subtle, width: 1, transparency: theme.name.includes('Dark') ? 25 : 0 },
    rectRadius: 0.14
  });
  if (accentBarColor) {
    slide.addShape('roundRect', {
      x: b.x,
      y: b.y,
      w: accentBarW ?? 0.12,
      h: b.h,
      fill: { color: accentBarColor },
      line: { color: accentBarColor },
      rectRadius: 0.14
    });
  }
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
        bullet: { indent, characterCode: '2022' },
        breakLine: idx !== flat.length - 1
      }
    });
  });
  return runs;
}

function tokenizeHighlights(text) {
  const s = String(text || '');
  const re = /([0-9]+(?:\\.[0-9]+)?%|[0-9]+(?:\\.[0-9]+)?分|[0-9]+(?:\\.[0-9]+)?|⭐{2,})/g;
  const parts = [];
  let last = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    if (m.index > last) parts.push({ t: s.slice(last, m.index), k: 'n' });
    parts.push({ t: m[0], k: 'h' });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ t: s.slice(last), k: 'n' });
  return parts.length ? parts : [{ t: s, k: 'n' }];
}

function bulletsToRichRuns(bullets, theme, { baseIndentPt = 18, levelIndentPt = 14 } = {}) {
  const flat = flattenBullets(bullets);
  const runs = [];
  flat.forEach((b, idx) => {
    const level = Math.max(0, b.level || 0);
    const indent = baseIndentPt + level * levelIndentPt;
    const chunks = tokenizeHighlights(String(b.text || '').trim());
    chunks.forEach((chunk, cIdx) => {
      const opt = {};
      if (cIdx === 0) opt.bullet = { indent, characterCode: '2022' };
      if (chunk.k === 'h') {
        opt.bold = true;
        opt.color = chunk.t.startsWith('⭐') ? theme.colors.accent2 : theme.colors.accent2;
      }
      if (cIdx === chunks.length - 1) opt.breakLine = idx !== flat.length - 1;
      runs.push({ text: chunk.t, options: opt });
    });
  });
  return runs;
}

function addBullets(slide, theme, box, bullets, style = {}) {
  const runs = bulletsToRichRuns(bullets, theme, {
    baseIndentPt: style.baseIndentPt ?? 20,
    levelIndentPt: style.levelIndentPt ?? 14
  });
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

function parseSectionTitle(title) {
  const s = String(title || '').trim();
  const m = s.match(/^([一二三四五六七八九十0-9]+)[、.\\s]+(.+)$/);
  if (!m) return { num: null, text: s };
  return { num: m[1], text: m[2] };
}

function slideTitle(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);

  // Left accent band + subtle corner shapes
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: 0.28,
    h: size.h,
    fill: { color: theme.colors.accent },
    line: { color: theme.colors.accent }
  });
  slide.addShape('ellipse', {
    x: size.w - 2.9,
    y: -1.2,
    w: 3.4,
    h: 3.4,
    fill: { color: theme.colors.accent2, transparency: theme.name.includes('Dark') ? 86 : 90 },
    line: { color: theme.colors.accent2, transparency: 100 }
  });
  slide.addShape('ellipse', {
    x: -1.4,
    y: size.h - 2.8,
    w: 3.2,
    h: 3.2,
    fill: { color: theme.colors.accent, transparency: theme.name.includes('Dark') ? 86 : 92 },
    line: { color: theme.colors.accent, transparency: 100 }
  });

  slide.addText(slideSpec.title || '', {
    x: 1.05,
    y: 2.15,
    w: size.w - 2.1,
    h: 1.2,
    fontFace: theme.fonts.head,
    fontSize: 46,
    bold: true,
    color: theme.colors.fg
  });
  if (slideSpec.subtitle) {
    slide.addText(slideSpec.subtitle, {
      x: 1.08,
      y: 3.35,
      w: size.w - 2.16,
      h: 0.8,
      fontFace: theme.fonts.body,
      fontSize: 20,
      color: theme.colors.muted
    });
  }
  if (slideSpec.meta) {
    slide.addText(slideSpec.meta, {
      x: 1.08,
      y: 6.95,
      w: size.w - 2.16,
      h: 0.4,
      fontFace: theme.fonts.body,
      fontSize: 12,
      color: theme.colors.muted
    });
  }
}

function slideSection(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);

  // Small top-left label
  slide.addText('SECTION', {
    x: 0.95,
    y: 0.55,
    w: 3.0,
    h: 0.3,
    fontFace: theme.fonts.body,
    fontSize: 12,
    bold: true,
    color: theme.colors.muted
  });
  slide.addShape('rect', {
    x: 0.95,
    y: 0.9,
    w: 0.65,
    h: 0.06,
    fill: { color: theme.colors.accent },
    line: { color: theme.colors.accent }
  });

  slide.addShape('ellipse', {
    x: size.w - 3.8,
    y: size.h - 2.6,
    w: 4.4,
    h: 4.4,
    fill: { color: theme.colors.accent, transparency: theme.name.includes('Dark') ? 86 : 92 },
    line: { color: theme.colors.accent, transparency: 100 }
  });
  slide.addShape('ellipse', {
    x: -2.1,
    y: -1.6,
    w: 4.6,
    h: 4.6,
    fill: { color: theme.colors.accent2, transparency: theme.name.includes('Dark') ? 86 : 92 },
    line: { color: theme.colors.accent2, transparency: 100 }
  });

  const parsed = parseSectionTitle(slideSpec.title || '');
  const num = parsed.num;
  const text = parsed.text;

  if (num) {
    slide.addText(num, {
      x: 1.0,
      y: 2.25,
      w: 1.4,
      h: 1.1,
      fontFace: theme.fonts.head,
      fontSize: 62,
      bold: true,
      color: theme.colors.accent
    });
    slide.addText(text, {
      x: 2.2,
      y: 2.38,
      w: size.w - 3.2,
      h: 1.0,
      fontFace: theme.fonts.head,
      fontSize: 44,
      bold: true,
      color: theme.colors.fg
    });
  } else {
    slide.addText(text, {
      x: 1.0,
      y: 2.4,
      w: size.w - 2.0,
      h: 1.2,
      fontFace: theme.fonts.head,
      fontSize: 46,
      bold: true,
      color: theme.colors.fg
    });
  }
  if (slideSpec.subtitle) {
    slide.addText(String(slideSpec.subtitle), {
      x: 1.05,
      y: 3.55,
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
  addHeader(slide, size, theme, slideSpec.title || '');

  const { variant, bodyBox, leftBox, rightBox, bulletsBox } = getContentBoxes(size, slideSpec);
  const aside = slideSpec.aside ? ensureObject(slideSpec.aside, 'slide.aside') : null;
  const bullets = slideSpec.bullets || [];

  if (variant === 'tiles') {
    addShadowedCard(slide, theme, bodyBox, { accentBarColor: theme.colors.accent2, accentBarW: 0.1 });
    const inner = { x: bodyBox.x + 0.35, y: bodyBox.y + 0.35, w: bodyBox.w - 0.7, h: bodyBox.h - 0.7 };
    const cols = 2;
    const rows = Math.ceil(bullets.length / cols);
    const gapX = 0.45;
    const gapY = 0.35;
    const cardW = (inner.w - gapX) / 2;
    const cardH = Math.min(1.55, (inner.h - gapY * (rows - 1)) / rows);

    bullets.slice(0, 6).forEach((t, idx) => {
      const r = Math.floor(idx / 2);
      const c = idx % 2;
      const b = clampBox(size, {
        x: inner.x + c * (cardW + gapX),
        y: inner.y + r * (cardH + gapY),
        w: cardW,
        h: cardH
      });
      addShadowedCard(slide, theme, b, { accentBarColor: theme.colors.accent, accentBarW: 0.1 });
      slide.addText(String(t), {
        x: b.x + 0.28,
        y: b.y + 0.22,
        w: b.w - 0.56,
        h: b.h - 0.44,
        fontFace: theme.fonts.body,
        fontSize: 18,
        bold: true,
        color: theme.colors.fg,
        valign: 'mid'
      });
    });
    return;
  }

  addShadowedCard(slide, theme, leftBox, { accentBarColor: theme.colors.accent2, accentBarW: 0.1 });

  const fitFontSize = slideSpec.style?.bulletFontSize
    ?? splitBulletsToFit(bullets, bulletsBox.w, bulletsBox.h, 18, 1.22)[0]?.fitFontSize
    ?? 18;

  addBullets(slide, theme, bulletsBox, bullets, {
    fontSize: fitFontSize,
    baseIndentPt: Math.max(14, fitFontSize),
    margin: [0, 0, 0, 0],
    lineSpacingMultiple: 1.22
  });

  if (aside && variant === 'twoCol') {
    const isWarn = !!aside.warning;
    const barColor = isWarn ? theme.colors.warn : theme.colors.accent;
    addShadowedCard(slide, theme, rightBox, { accentBarColor: barColor, accentBarW: 0.12 });

    const inner = { x: rightBox.x + 0.32, y: rightBox.y + 0.35, w: rightBox.w - 0.64, h: rightBox.h - 0.7 };
    const rawText = String(aside.text || '').trim();
    const splitIdx = rawText.indexOf('：');
    const label = splitIdx > 0 && splitIdx < 8 ? rawText.slice(0, splitIdx) : (aside.title || '要点');
    const content = splitIdx > 0 && splitIdx < 8 ? rawText.slice(splitIdx + 1).trim() : rawText;

    // Label pill
    slide.addShape('roundRect', {
      x: inner.x,
      y: inner.y,
      w: Math.min(inner.w, 2.1),
      h: 0.42,
      fill: { color: barColor, transparency: theme.name.includes('Dark') ? 15 : 0 },
      line: { color: barColor },
      rectRadius: 0.18
    });
    slide.addText(String(label || ''), {
      x: inner.x + 0.16,
      y: inner.y + 0.07,
      w: Math.min(inner.w, 2.1) - 0.32,
      h: 0.3,
      fontFace: theme.fonts.head,
      fontSize: 14,
      bold: true,
      color: 'FFFFFF'
    });

    if (aside.bullets) {
      addBullets(
        slide,
        theme,
        { x: inner.x, y: inner.y + 0.55, w: inner.w, h: inner.h - 0.55 },
        aside.bullets,
        { fontSize: 14, baseIndentPt: 16, margin: [0, 0, 0, 0] }
      );
    } else {
      slide.addText(content, {
        x: inner.x,
        y: inner.y + 0.62,
        w: inner.w,
        h: inner.h - 0.62,
        fontFace: theme.fonts.body,
        fontSize: aside.emphasis ? 18 : 16,
        bold: !!aside.emphasis,
        color: isWarn ? theme.colors.warn : theme.colors.fg,
        valign: 'top'
      });
    }
  }

  // One-column callout (prevents empty right column)
  if (aside && variant === 'oneColCallout') {
    const isWarn = !!aside.warning;
    const barColor = isWarn ? theme.colors.warn : theme.colors.accent;
    const rawText = String(aside.text || aside.title || '').trim();
    const splitIdx = rawText.indexOf('：');
    const label = splitIdx > 0 && splitIdx < 8 ? rawText.slice(0, splitIdx) : (aside.title || '要点');
    const content = splitIdx > 0 && splitIdx < 8 ? rawText.slice(splitIdx + 1).trim() : rawText;

    const pillW = Math.min(4.6, Math.max(2.8, (countPlainChars(content) + 4) * 0.22));
    const pill = clampBox(size, {
      x: leftBox.x + leftBox.w - pillW - 0.35,
      y: leftBox.y + 0.25,
      w: pillW,
      h: 0.55
    });
    slide.addShape('roundRect', {
      x: pill.x,
      y: pill.y,
      w: pill.w,
      h: pill.h,
      fill: { color: barColor },
      line: { color: barColor },
      rectRadius: 0.22
    });
    slide.addText(`${label}${label ? ' ' : ''}${content}`.trim(), {
      x: pill.x + 0.2,
      y: pill.y + 0.12,
      w: pill.w - 0.4,
      h: pill.h - 0.2,
      fontFace: theme.fonts.head,
      fontSize: 18,
      bold: true,
      color: 'FFFFFF',
      valign: 'mid'
    });
  }
}

function slideChart(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addHeader(slide, size, theme, slideSpec.title || '');

  const layout = getLayout(size);
  const leftW = Math.min(4.4, Math.max(4.0, layout.body.w * 0.34));
  const leftBox = clampBox(size, { x: layout.body.x, y: layout.body.y, w: leftW, h: layout.body.h });
  const rightBox = clampBox(size, {
    x: leftBox.x + leftBox.w + layout.gap,
    y: layout.body.y,
    w: layout.body.w - leftBox.w - layout.gap,
    h: layout.body.h
  });

  if (slideSpec.bullets && Array.isArray(slideSpec.bullets) && slideSpec.bullets.length) {
    addShadowedCard(slide, theme, leftBox, { accentBarColor: theme.colors.accent2, accentBarW: 0.1 });
    slide.addText('解读要点', {
      x: leftBox.x + 0.28,
      y: leftBox.y + 0.18,
      w: leftBox.w - 0.56,
      h: 0.4,
      fontFace: theme.fonts.head,
      fontSize: 14,
      bold: true,
      color: theme.colors.fg
    });
    const bulletsBox = { x: leftBox.x + 0.28, y: leftBox.y + 0.6, w: leftBox.w - 0.56, h: leftBox.h - 0.85 };
    const fitFontSize = slideSpec.style?.bulletFontSize
      ?? splitBulletsToFit(slideSpec.bullets, bulletsBox.w, bulletsBox.h, 14, 1.18)[0]?.fitFontSize
      ?? 14;
    addBullets(slide, theme, bulletsBox, slideSpec.bullets, { fontSize: fitFontSize, baseIndentPt: 16, margin: [0, 0, 0, 0] });
  }

  addShadowedCard(slide, theme, rightBox, { accentBarColor: theme.colors.accent, accentBarW: 0.12 });

  const chart = ensureObject(slideSpec.chart || {}, 'slide.chart');
  const chartType = chart.type || 'bar';
  const rawData = ensureArray(chart.data || [], 'slide.chart.data');
  const rawOptions = deepNormalizeColors(chart.options || {});
  const { chartArea, x, y, w, h, ...options } = rawOptions || {};

  // Fix common "single category + multi series" data that renders as a narrow chart.
  const data = (() => {
    if (!Array.isArray(rawData) || rawData.length < 2) return rawData;
    const firstLabel = rawData[0]?.labels?.[0];
    const allSingleLabel = rawData.every((s) => Array.isArray(s.labels) && s.labels.length === 1);
    const sameLabel = allSingleLabel && rawData.every((s) => s.labels?.[0] === firstLabel);
    const allSingleValue = rawData.every((s) => Array.isArray(s.values) && s.values.length === 1);
    if (sameLabel && allSingleValue) {
      return [
        {
          name: firstLabel || '指标',
          labels: rawData.map((s) => String(s.name || '')),
          values: rawData.map((s) => Number(s.values?.[0] ?? 0))
        }
      ];
    }
    return rawData;
  })();

  const chartBox = {
    x: rightBox.x + 0.32,
    y: rightBox.y + 0.28,
    w: rightBox.w - 0.64,
    h: rightBox.h - 0.85
  };

  slide.addChart(chartType, data, {
    ...options,
    x: chartBox.x,
    y: chartBox.y,
    w: chartBox.w,
    h: chartBox.h,
    showLegend: options.showLegend ?? false,
    chartColors: options.chartColors ?? [theme.colors.accent2],
    dataLabelPosition: options.dataLabelPosition ?? 'outEnd'
  });

  const caption = chart.caption || options.title || slideSpec.caption;
  if (caption) {
    slide.addText(String(caption), {
      x: rightBox.x + 0.32,
      y: rightBox.y + rightBox.h - 0.48,
      w: rightBox.w - 0.64,
      h: 0.35,
      fontFace: theme.fonts.body,
      fontSize: 12,
      italic: true,
      color: theme.colors.muted
    });
  }
}

function toTableRows(table2d) {
  if (!Array.isArray(table2d)) die('slide.table.rows must be a 2D array');
  return table2d.map((row) => {
    if (!Array.isArray(row)) die('slide.table.rows must be a 2D array');
    return row.map((cell) => ({ text: cell == null ? '' : String(cell) }));
  });
}

function inferHeaderRows(rawRows, explicitHeaderRows) {
  if (Number.isFinite(explicitHeaderRows)) return Math.max(0, Math.floor(explicitHeaderRows));
  if (!Array.isArray(rawRows) || rawRows.length < 2) return 0;
  const first = rawRows[0];
  if (!Array.isArray(first) || !first.length) return 0;

  const joined = first.map((c) => String(c ?? '').trim()).join(' ');
  const headerKeywords = [
    '序号',
    '排序',
    '排名',
    '学校',
    '院校',
    '专业',
    '类别',
    '类型',
    '分数',
    '最低分',
    '最高分',
    '平均分',
    '位次',
    '录取概率',
    '建议',
    '说明',
    '结论',
    '备注'
  ];
  const looksLikeHeader = headerKeywords.some((k) => joined.includes(k));
  if (looksLikeHeader) return 1;

  // If first row contains obvious value-like tokens (numbers/percent/+/stars), treat as data.
  const valueLike = /([0-9]+(?:\\.[0-9]+)?%|\\+[0-9]+\\s*分|[0-9]{2,}|★|⭐)/;
  if (valueLike.test(joined)) return 0;

  return 0;
}

function slideTable(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addHeader(slide, size, theme, slideSpec.title || '');

  const table = ensureObject(slideSpec.table || {}, 'slide.table');
  const rawRows = Array.isArray(table.rows) ? table.rows : [];
  const options = deepNormalizeColors(table.options || {});
  const headerRows = inferHeaderRows(rawRows, table.headerRows ?? options.headerRows);

  const layout = getLayout(size);
  const manualW = typeof options.w === 'number' ? options.w : null;
  const manualY = typeof options.y === 'number' ? options.y : null;
  const box = clampBox(
    size,
    {
      x: manualW ? (size.w - manualW) / 2 : layout.body.x,
      y: manualY ?? layout.body.y,
      w: manualW ?? layout.body.w,
      h: size.h - (manualY ?? layout.body.y) - layout.marginBottom
    },
    0.2
  );

  addShadowedCard(slide, theme, box, { accentBarColor: theme.colors.accent, accentBarW: 0.12 });

  const headerFill = theme.colors.accent;
  const headerTextColor = 'FFFFFF';
  const zebra = theme.name.includes('Dark') ? '0E1628' : 'F8FAFC';

  const styledRows = rawRows.map((row, rIdx) =>
    (Array.isArray(row) ? row : []).map((cell, cIdx) => {
      const text = cell == null ? '' : String(cell);
      const base = {
        fontFace: theme.fonts.body,
        fontSize: 12,
        color: theme.colors.fg,
        valign: 'mid',
        margin: 2
      };
      if (headerRows > 0 && rIdx < headerRows) {
        return {
          text,
          options: {
            ...base,
            bold: true,
            align: 'center',
            color: headerTextColor,
            fill: { color: headerFill }
          }
        };
      }

      const opt = {
        ...base,
        fill: { color: rIdx % 2 === 0 ? zebra : theme.colors.card }
      };

      // Column-level alignment
      if (cIdx === 0) opt.align = 'center';
      if (headerRows === 0 && cIdx === 0) opt.bold = true;

      // Semantic tags coloring (common in admissions tables)
      if (/^(保底|稳妥|适中|冲刺|不建议)$/.test(text)) {
        const palette = {
          保底: { fill: 'DCFCE7', color: '166534' },
          稳妥: { fill: 'DCFCE7', color: '166534' },
          适中: { fill: 'DBEAFE', color: '1D4ED8' },
          冲刺: { fill: 'FFEDD5', color: '9A3412' },
          不建议: { fill: 'FEE2E2', color: '991B1B' }
        };
        const p = palette[text];
        if (p) {
          opt.bold = true;
          opt.align = 'center';
          opt.fill = { color: p.fill };
          opt.color = p.color;
        }
      }

      return { text, options: opt };
    })
  );

  // Strip layout overrides from options; box controls geometry
  const { x, y, w, h, fill, headerRows: _headerRows, ...restOptions } = options || {};

  slide.addTable(styledRows, {
    x: box.x + 0.32,
    y: box.y + 0.32,
    w: box.w - 0.64,
    h: box.h - 0.64,
    border: restOptions.border || { type: 'solid', color: theme.colors.subtle, pt: 1 },
    ...(restOptions || {})
  });
}

function slideImage(slide, size, theme, slideSpec) {
  addBg(slide, size, theme);
  addHeader(slide, size, theme, slideSpec.title || '');

  const img = ensureObject(slideSpec.image || {}, 'slide.image');
  const box = { x: 1.0, y: 1.55, w: size.w - 2.0, h: 5.6 };
  addShadowedCard(slide, theme, box, { accentBarColor: theme.colors.accent2, accentBarW: 0.12 });

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
    fill: { color: theme.colors.accent, transparency: theme.name.includes('Dark') ? 78 : 90 },
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

function isTocLike(slideSpec) {
  const title = String(slideSpec.title || '').trim();
  if (!/^(目录|报告目录|大纲|议程|Agenda)$/i.test(title)) return false;
  if (!Array.isArray(slideSpec.bullets) || slideSpec.bullets.length < 3) return false;
  return slideSpec.bullets.every((b) => typeof b === 'string' && /^(?:[一二三四五六七八九十0-9]+)[、.\\s]+/.test(b.trim()));
}

function slideToc(slide, size, theme, slideSpec, allSlides) {
  addBg(slide, size, theme);
  addHeader(slide, size, theme, slideSpec.title || '目录');

  const items = (() => {
    if (Array.isArray(slideSpec.items) && slideSpec.items.length) return slideSpec.items.map(String);
    if (Array.isArray(slideSpec.bullets) && slideSpec.bullets.length) return slideSpec.bullets.map(String);
    if (Array.isArray(allSlides)) {
      const secs = allSlides.filter((s) => s && typeof s === 'object' && s.type === 'section' && s.title);
      return secs.map((s) => String(s.title));
    }
    return [];
  })();

  const layout = getLayout(size);
  const card = clampBox(size, { x: layout.body.x, y: layout.body.y, w: layout.body.w, h: layout.body.h });
  addShadowedCard(slide, theme, card, { accentBarColor: theme.colors.accent, accentBarW: 0.12 });

  const inner = { x: card.x + 0.42, y: card.y + 0.35, w: card.w - 0.84, h: card.h - 0.7 };
  const cols = items.length > 8 ? 2 : 1;
  const gap = 0.55;
  const colW = cols === 1 ? inner.w : (inner.w - gap) / 2;
  const rowH = cols === 1 ? 0.6 : 0.62;

  items.slice(0, 14).forEach((raw, idx) => {
    const col = cols === 2 ? (idx < Math.ceil(items.length / 2) ? 0 : 1) : 0;
    const row = cols === 2 ? (col === 0 ? idx : idx - Math.ceil(items.length / 2)) : idx;
    const x = inner.x + col * (colW + gap);
    const y = inner.y + row * rowH;

    if (y + rowH > inner.y + inner.h) return;

    const parsed = parseSectionTitle(raw);
    const num = parsed.num || String(idx + 1);
    const text = parsed.text || raw;

    // Number pill
    slide.addShape('roundRect', {
      x,
      y: y + 0.08,
      w: 0.55,
      h: 0.44,
      fill: { color: theme.colors.accent2 },
      line: { color: theme.colors.accent2 },
      rectRadius: 0.2
    });
    slide.addText(num, {
      x,
      y: y + 0.14,
      w: 0.55,
      h: 0.36,
      fontFace: theme.fonts.head,
      fontSize: 16,
      bold: true,
      color: 'FFFFFF',
      align: 'center'
    });

    slide.addText(text, {
      x: x + 0.72,
      y: y + 0.12,
      w: colW - 0.72,
      h: 0.5,
      fontFace: theme.fonts.body,
      fontSize: 18,
      color: theme.colors.fg
    });

    slide.addShape('rect', {
      x,
      y: y + rowH - 0.02,
      w: colW,
      h: 0.01,
      fill: { color: theme.colors.subtle, transparency: theme.name.includes('Dark') ? 40 : 0 },
      line: { color: theme.colors.subtle, transparency: 100 }
    });
  });
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

  const expandedSlides = [];
  for (const slideSpecRaw of slides) {
    const slideSpec = ensureObject(slideSpecRaw, 'slide');
    const t = slideSpec.type || 'content';
    if (t === 'content') expandedSlides.push(...paginateContentSlide(slideSpec, size));
    else expandedSlides.push(slideSpec);
  }

  for (const slideSpecRaw of expandedSlides) {
    const slideSpec = ensureObject(slideSpecRaw, 'slide');
    const slide = pptx.addSlide();

    const t = slideSpec.type || 'content';
    if (t === 'title') slideTitle(slide, size, theme, slideSpec);
    else if (t === 'section') slideSection(slide, size, theme, slideSpec);
    else if (t === 'toc') slideToc(slide, size, theme, slideSpec, slides);
    else if (t === 'content') {
      if (isTocLike(slideSpec)) slideToc(slide, size, theme, slideSpec, slides);
      else slideContent(slide, size, theme, slideSpec);
    }
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
