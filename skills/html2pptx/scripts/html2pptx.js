#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const pptxgen = require('pptxgenjs');
const { chromium } = require('playwright');

const PX_PER_IN = 96;
const PT_PER_PX = 0.75;
const EMU_PER_IN = 914400;
const DEFAULT_MAX_SLIDE_HEIGHT_IN = 7.5;

function usage() {
  console.log(`Usage:
  node skills/html2pptx/scripts/html2pptx.js --in input.html --out output.pptx [options]

Options:
  --scale <n>                 Scale output before slicing (default 1)
  --max-slide-height-in <n>   Max slide height in inches before splitting (default ${DEFAULT_MAX_SLIDE_HEIGHT_IN})
  --split                     Split long pages into multiple slides (default)
  --no-split                  Keep a single slide and auto-scale to max height if needed
  --tmp-dir <dir>             Temp dir for background images (default $TMPDIR or /tmp)
  --debug                     Keep temp background images
  -h, --help                  Show help
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    scale: null,
    maxSlideHeightIn: DEFAULT_MAX_SLIDE_HEIGHT_IN,
    tmpDir: process.env.TMPDIR || '/tmp',
    debug: false,
    split: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }

    if (arg === '--in' || arg === '-i') {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--out' || arg === '-o') {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--scale') {
      args.scale = parseFloat(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--max-slide-height-in') {
      args.maxSlideHeightIn = parseFloat(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--split') {
      args.split = true;
      continue;
    }

    if (arg === '--no-split') {
      args.split = false;
      continue;
    }

    if (arg === '--tmp-dir') {
      args.tmpDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--debug') {
      args.debug = true;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }

  if (!args.input || !args.output) {
    usage();
    process.exit(1);
  }

  return args;
}

function defineLayout(pptx, widthIn, heightIn) {
  const layoutName = `HTML_${Math.round(widthIn * 100)}x${Math.round(heightIn * 100)}`;
  pptx.defineLayout({ name: layoutName, width: widthIn, height: heightIn });
  pptx.layout = layoutName;
}

function normalizeImagePath(src) {
  if (!src) return src;
  let cleaned = src;

  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.replace('file://', '');
    if (process.platform === 'win32' && cleaned.startsWith('/')) {
      cleaned = cleaned.slice(1);
    }
  }

  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (err) {
    // Ignore URI decoding errors.
  }

  return cleaned;
}

async function getPageDimensions(page) {
  return await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const width = Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth);
    const height = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight);
    return { width, height };
  });
}

async function captureGradientBackgrounds(page, tmpDir) {
  const targets = await page.evaluate(() => {
    const gradientTargets = [];

    document.querySelectorAll('*').forEach((el) => {
      const computed = window.getComputedStyle(el);
      const bgImage = computed.backgroundImage || '';
      if (!bgImage.includes('gradient')) return;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const id = `bg-${gradientTargets.length}`;
      el.setAttribute('data-pptx-bg-id', id);
      gradientTargets.push({ id });
    });

    return gradientTargets;
  });

  if (targets.length === 0) {
    return { bgMap: {}, bgIds: [] };
  }

  const ids = targets.map((target) => target.id);

  await page.evaluate((bgIds) => {
    bgIds.forEach((id) => {
      const el = document.querySelector(`[data-pptx-bg-id="${id}"]`);
      if (!el) return;

      el.querySelectorAll('*').forEach((child) => {
        child.dataset.pptxPrevVisibility = child.style.visibility || '';
        child.style.visibility = 'hidden';
      });

      el.dataset.pptxPrevColor = el.style.color || '';
      el.style.color = 'transparent';
    });
  }, ids);

  const bgMap = {};

  for (const id of ids) {
    const handle = await page.$(`[data-pptx-bg-id="${id}"]`);
    if (!handle) continue;
    const fileName = path.join(tmpDir, `html2pptx-bg-${id}.png`);
    await handle.screenshot({ path: fileName, type: 'png' });
    bgMap[id] = fileName;
  }

  await page.evaluate((bgIds) => {
    bgIds.forEach((id) => {
      const el = document.querySelector(`[data-pptx-bg-id="${id}"]`);
      if (!el) return;

      el.querySelectorAll('*').forEach((child) => {
        if (child.dataset.pptxPrevVisibility !== undefined) {
          child.style.visibility = child.dataset.pptxPrevVisibility;
          delete child.dataset.pptxPrevVisibility;
        } else {
          child.style.visibility = '';
        }
      });

      if (el.dataset.pptxPrevColor !== undefined) {
        el.style.color = el.dataset.pptxPrevColor;
        delete el.dataset.pptxPrevColor;
      } else {
        el.style.color = '';
      }
    });
  }, ids);

  return { bgMap, bgIds: ids };
}

async function extractSlideData(page, options) {
  return await page.evaluate(({ scale, bgIds }) => {
    const PT_PER_PX = 0.75;
    const PX_PER_IN = 96;
    const scaleFactor = scale || 1;

    const pxToInch = (px) => (px / PX_PER_IN) * scaleFactor;
    const pxToPoints = (pxStr) => parseFloat(pxStr) * PT_PER_PX * scaleFactor;
    const isTransparent = (rgbStr) => rgbStr === 'rgba(0, 0, 0, 0)' || rgbStr === 'transparent';

    const rgbToHex = (rgbStr) => {
      if (rgbStr === 'rgba(0, 0, 0, 0)' || rgbStr === 'transparent') return 'FFFFFF';
      const match = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return 'FFFFFF';
      return match.slice(1).map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
    };

    const extractAlpha = (rgbStr) => {
      const match = rgbStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
      if (!match || !match[4]) return null;
      const alpha = parseFloat(match[4]);
      return Math.round((1 - alpha) * 100);
    };

    const applyTextTransform = (text, textTransform) => {
      if (textTransform === 'uppercase') return text.toUpperCase();
      if (textTransform === 'lowercase') return text.toLowerCase();
      if (textTransform === 'capitalize') return text.replace(/\b\w/g, (c) => c.toUpperCase());
      return text;
    };

    const SINGLE_WEIGHT_FONTS = ['impact'];
    const GENERIC_FONT_FALLBACKS = {
      '-apple-system': 'Arial',
      'blinkmacsystemfont': 'Arial',
      'system-ui': 'Arial',
      'sans-serif': 'Arial',
      'serif': 'Times New Roman',
      'monospace': 'Courier New'
    };
    const BOLD_FONT_VARIANTS = {
      'pingfang sc': ['PingFang SC Semibold', 'PingFang SC Medium'],
      'microsoft yahei': ['Microsoft YaHei Bold'],
      'microsoft yahei ui': ['Microsoft YaHei UI Bold']
    };
    const fontFamilyCache = new Map();

    const normalizeFontName = (name) => name.replace(/['"]/g, '').trim();

    const resolveFontFamily = (fontFamily) => {
      if (!fontFamily) return fontFamily;
      if (fontFamilyCache.has(fontFamily)) return fontFamilyCache.get(fontFamily);

      const candidates = fontFamily.split(',')
        .map(normalizeFontName)
        .filter(Boolean)
        .map((candidate) => {
          const normalized = candidate.toLowerCase();
          return GENERIC_FONT_FALLBACKS[normalized] || candidate;
        });

      let resolved = candidates[0] || fontFamily;
      if (document.fonts && typeof document.fonts.check === 'function') {
        for (const candidate of candidates) {
          if (!candidate) continue;
          try {
            if (document.fonts.check(`12px "${candidate}"`)) {
              resolved = candidate;
              break;
            }
          } catch (err) {
            // Ignore font check errors.
          }
        }
      }

      fontFamilyCache.set(fontFamily, resolved);
      return resolved;
    };

    const shouldSkipBold = (fontFace) => {
      if (!fontFace) return false;
      const normalizedFont = normalizeFontName(fontFace).toLowerCase();
      return SINGLE_WEIGHT_FONTS.includes(normalizedFont);
    };

    const resolveBoldFontFace = (fontFace) => {
      if (!fontFace) return { fontFace, bold: true };
      const normalized = normalizeFontName(fontFace).toLowerCase();
      const candidates = BOLD_FONT_VARIANTS[normalized];
      if (candidates && candidates.length > 0) {
        if (document.fonts && typeof document.fonts.check === 'function') {
          for (const candidate of candidates) {
            try {
              if (document.fonts.check(`12px "${candidate}"`)) {
                return { fontFace: candidate, bold: false };
              }
            } catch (err) {
              // Ignore font check errors.
            }
          }
        } else {
          return { fontFace: candidates[0], bold: false };
        }
      }

      if (shouldSkipBold(fontFace)) return { fontFace, bold: false };
      return { fontFace, bold: true };
    };

    const resolveFontStyle = (fontFamily, isBold) => {
      const baseFace = resolveFontFamily(fontFamily);
      if (!isBold) return { fontFace: baseFace, bold: false };
      return resolveBoldFontFace(baseFace);
    };

    const getRotation = (transform, writingMode) => {
      let angle = 0;
      if (writingMode === 'vertical-rl') {
        angle = 90;
      } else if (writingMode === 'vertical-lr') {
        angle = 270;
      }

      if (transform && transform !== 'none') {
        const rotateMatch = transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
        if (rotateMatch) {
          angle += parseFloat(rotateMatch[1]);
        } else {
          const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
          if (matrixMatch) {
            const values = matrixMatch[1].split(',').map(parseFloat);
            const matrixAngle = Math.atan2(values[1], values[0]) * (180 / Math.PI);
            angle += Math.round(matrixAngle);
          }
        }
      }

      angle = angle % 360;
      if (angle < 0) angle += 360;
      return angle === 0 ? null : angle;
    };

    const getPositionAndSize = (el, rect, rotation) => {
      if (rotation === null) {
        return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      }

      const isVertical = rotation === 90 || rotation === 270;
      if (isVertical) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return {
          x: centerX - rect.height / 2,
          y: centerY - rect.width / 2,
          w: rect.height,
          h: rect.width
        };
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return {
        x: centerX - el.offsetWidth / 2,
        y: centerY - el.offsetHeight / 2,
        w: el.offsetWidth,
        h: el.offsetHeight
      };
    };

    const parseBoxShadow = (boxShadow) => {
      if (!boxShadow || boxShadow === 'none') return null;

      if (boxShadow.match(/inset/)) return null;

      const colorMatch = boxShadow.match(/rgba?\([^)]+\)/);
      const parts = boxShadow.match(/([-\d.]+)(px|pt)/g);
      if (!parts || parts.length < 2) return null;

      const offsetX = parseFloat(parts[0]);
      const offsetY = parseFloat(parts[1]);
      const blur = parts.length > 2 ? parseFloat(parts[2]) : 0;

      let angle = 0;
      if (offsetX !== 0 || offsetY !== 0) {
        angle = Math.atan2(offsetY, offsetX) * (180 / Math.PI);
        if (angle < 0) angle += 360;
      }

      const offset = Math.sqrt(offsetX * offsetX + offsetY * offsetY) * PT_PER_PX * scaleFactor;

      let opacity = 0.5;
      if (colorMatch) {
        const opacityMatch = colorMatch[0].match(/[\d.]+\)$/);
        if (opacityMatch) {
          opacity = parseFloat(opacityMatch[0].replace(')', ''));
        }
      }

      return {
        type: 'outer',
        angle: Math.round(angle),
        blur: blur * 0.75 * scaleFactor,
        color: colorMatch ? rgbToHex(colorMatch[0]) : '000000',
        offset,
        opacity
      };
    };

    const parseInlineFormatting = (element, baseOptions = {}, runs = [], baseTextTransform = (x) => x, skipNode = () => false) => {
      let prevNodeIsText = false;

      element.childNodes.forEach((node) => {
        if (skipNode(node)) {
          prevNodeIsText = false;
          return;
        }

        let textTransform = baseTextTransform;
        const isText = node.nodeType === Node.TEXT_NODE || node.tagName === 'BR';
        if (isText) {
          const text = node.tagName === 'BR'
            ? '\n'
            : textTransform(node.textContent.replace(/\s+/g, ' '));
          const prevRun = runs[runs.length - 1];
          if (prevNodeIsText && prevRun) {
            prevRun.text += text;
          } else {
            runs.push({ text, options: { ...baseOptions } });
          }
        } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
          if (skipNode(node)) {
            prevNodeIsText = false;
            return;
          }

          const options = { ...baseOptions };
          const computed = window.getComputedStyle(node);

          if (
            node.tagName === 'SPAN' ||
            node.tagName === 'B' ||
            node.tagName === 'STRONG' ||
            node.tagName === 'I' ||
            node.tagName === 'EM' ||
            node.tagName === 'U' ||
            node.tagName === 'A' ||
            node.tagName === 'CODE' ||
            node.tagName === 'SMALL' ||
            node.tagName === 'SUP' ||
            node.tagName === 'SUB'
          ) {
            const resolvedFontFace = resolveFontFamily(computed.fontFamily);
            if (resolvedFontFace) options.fontFace = resolvedFontFace;

            const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight, 10) >= 600;
            if (isBold) {
              const boldStyle = resolveBoldFontFace(resolvedFontFace);
              if (boldStyle.fontFace) options.fontFace = boldStyle.fontFace;
              if (boldStyle.bold) options.bold = true;
            }
            if (computed.fontStyle === 'italic') options.italic = true;
            if (computed.textDecoration && computed.textDecoration.includes('underline')) options.underline = true;
            if (computed.color && computed.color !== 'rgb(0, 0, 0)') {
              options.color = rgbToHex(computed.color);
              const transparency = extractAlpha(computed.color);
              if (transparency !== null) options.transparency = transparency;
            }
            if (computed.fontSize) options.fontSize = pxToPoints(computed.fontSize);

            if (computed.textTransform && computed.textTransform !== 'none') {
              const transformStr = computed.textTransform;
              textTransform = (text) => applyTextTransform(text, transformStr);
            }

            parseInlineFormatting(node, options, runs, textTransform, skipNode);
          }
        }

        prevNodeIsText = isText;
      });

      if (runs.length > 0) {
        runs[0].text = runs[0].text.replace(/^\s+/, '');
        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
      }

      return runs.filter((run) => run.text.length > 0);
    };

    const normalizeMarkerContent = (content) => {
      if (!content || content === 'none' || content === 'normal') return '';
      let cleaned = content;
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
      cleaned = cleaned.replace(/\\a/gi, '\n');
      return cleaned;
    };

    const toAlpha = (num, upper) => {
      let n = num;
      if (!n || n <= 0) return '';
      let result = '';
      while (n > 0) {
        n -= 1;
        const base = upper ? 65 : 97;
        result = String.fromCharCode((n % 26) + base) + result;
        n = Math.floor(n / 26);
      }
      return result;
    };

    const toRoman = (num, upper) => {
      let n = num;
      if (!n || n <= 0) return '';
      const map = [
        { value: 1000, symbol: 'M' },
        { value: 900, symbol: 'CM' },
        { value: 500, symbol: 'D' },
        { value: 400, symbol: 'CD' },
        { value: 100, symbol: 'C' },
        { value: 90, symbol: 'XC' },
        { value: 50, symbol: 'L' },
        { value: 40, symbol: 'XL' },
        { value: 10, symbol: 'X' },
        { value: 9, symbol: 'IX' },
        { value: 5, symbol: 'V' },
        { value: 4, symbol: 'IV' },
        { value: 1, symbol: 'I' }
      ];
      let result = '';
      map.forEach((entry) => {
        while (n >= entry.value) {
          result += entry.symbol;
          n -= entry.value;
        }
      });
      return upper ? result : result.toLowerCase();
    };

    const formatOrderedMarker = (listStyleType, index) => {
      const style = listStyleType || 'decimal';
      switch (style) {
        case 'none':
          return '';
        case 'decimal-leading-zero':
          return `${index < 10 ? `0${index}` : index}.`;
        case 'lower-alpha':
        case 'lower-latin':
          return `${toAlpha(index, false)}.`;
        case 'upper-alpha':
        case 'upper-latin':
          return `${toAlpha(index, true)}.`;
        case 'lower-roman':
          return `${toRoman(index, false)}.`;
        case 'upper-roman':
          return `${toRoman(index, true)}.`;
        case 'decimal':
        default:
          return `${index}.`;
      }
    };

    const formatUnorderedMarker = (listStyleType) => {
      const style = listStyleType || 'disc';
      switch (style) {
        case 'circle':
          return '○';
        case 'square':
          return '▪';
        case 'none':
          return '';
        case 'disc':
        default:
          return '•';
      }
    };

    const measureTextWidth = (() => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      return (text, computed) => {
        if (!ctx) return 0;
        const font = computed.font || [
          computed.fontStyle,
          computed.fontVariant,
          computed.fontWeight,
          computed.fontSize,
          computed.fontFamily
        ].filter(Boolean).join(' ');
        ctx.font = font;
        return ctx.measureText(text).width;
      };
    })();

    const getListItemValue = (listEl, listItem) => {
      const items = Array.from(listEl.children).filter((child) => child.tagName === 'LI');
      let currentValue = parseInt(listEl.getAttribute('start'), 10);
      if (Number.isNaN(currentValue)) currentValue = 1;

      for (const item of items) {
        const valueAttr = parseInt(item.getAttribute('value'), 10);
        const itemValue = Number.isNaN(valueAttr) ? currentValue : valueAttr;
        if (item === listItem) {
          return itemValue;
        }
        currentValue = itemValue + 1;
      }
      return currentValue;
    };

    const getRectRadius = (computed, rect) => {
      const radius = computed.borderRadius;
      const radiusValue = parseFloat(radius);
      if (!radiusValue) return 0;

      if (radius.includes('%')) {
        if (radiusValue >= 50) return 1;
        const minDim = Math.min(rect.width, rect.height);
        return (radiusValue / 100) * pxToInch(minDim);
      }

      if (radius.includes('pt')) return (radiusValue / 72) * scaleFactor;
      return pxToInch(radiusValue);
    };

    const getEffectiveBackground = (element) => {
      let current = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (style && style.backgroundColor && !isTransparent(style.backgroundColor)) {
          return style.backgroundColor;
        }
        if (current.tagName === 'TABLE') break;
        current = current.parentElement;
      }
      return 'rgba(0, 0, 0, 0)';
    };

    const domOrderMap = new WeakMap();
    let domOrderIndex = 0;
    const domWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (domWalker.nextNode()) {
      domOrderMap.set(domWalker.currentNode, domOrderIndex);
      domOrderIndex += 1;
    }

    const sectionIdMap = new WeakMap();
    let currentSectionId = null;
    let sectionIndex = 0;
    const sectionWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (sectionWalker.nextNode()) {
      const node = sectionWalker.currentNode;
      if (/^H[1-6]$/.test(node.tagName)) {
        currentSectionId = `section-${sectionIndex}`;
        sectionIndex += 1;
      }
      if (currentSectionId) {
        sectionIdMap.set(node, currentSectionId);
      }
    }

    const tableIdMap = new WeakMap();
    let tableIndex = 0;
    document.querySelectorAll('table').forEach((table) => {
      tableIdMap.set(table, `table-${tableIndex}`);
      tableIndex += 1;
    });

    const getElementMeta = (element) => {
      if (!element || !element.tagName) return null;
      const tagName = element.tagName.toLowerCase();
      const sectionId = sectionIdMap.get(element) || null;
      const tableEl = element.closest('table');
      const tableId = tableEl ? tableIdMap.get(tableEl) || null : null;
      const domOrder = domOrderMap.has(element) ? domOrderMap.get(element) : null;
      const isHeading = /^h[1-6]$/.test(tagName);
      return {
        tagName,
        sectionId,
        tableId,
        domOrder,
        isHeading
      };
    };

    const errors = [];
    const elements = [];
    const placeholders = [];
    const processed = new Set();
    const textTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI'];
    const pushElement = (element, data) => {
      elements.push({ ...data, meta: getElementMeta(element) });
    };

    const body = document.body;
    const bodyStyle = window.getComputedStyle(body);
    const bgImage = bodyStyle.backgroundImage;
    const bgColor = bodyStyle.backgroundColor;

    let background;
    if (bgImage && bgImage !== 'none' && !bgImage.includes('gradient')) {
      const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (urlMatch) {
        background = { type: 'image', path: urlMatch[1] };
      } else {
        background = { type: 'color', value: rgbToHex(bgColor) };
      }
    } else {
      background = { type: 'color', value: rgbToHex(bgColor) };
    }

    const isBadgeElement = (node) => {
      if (!node || node.tagName !== 'SPAN') return false;
      const computed = window.getComputedStyle(node);
      const bg = computed.backgroundColor;
      if (isTransparent(bg)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const isBadgeSpan = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
      if (node.tagName !== 'SPAN') return false;
      const computed = window.getComputedStyle(node);
      return !isTransparent(computed.backgroundColor);
    };

    document.querySelectorAll('*').forEach((el) => {
      if (processed.has(el)) return;

      if (el.hasAttribute('data-pptx-bg-id')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pushElement(el, {
            type: 'bg-image',
            id: el.getAttribute('data-pptx-bg-id'),
            position: {
              x: pxToInch(rect.left),
              y: pxToInch(rect.top),
              w: pxToInch(rect.width),
              h: pxToInch(rect.height)
            }
          });
        }
        processed.add(el);
        return;
      }

      if (el.tagName === 'IMG') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pushElement(el, {
            type: 'image',
            src: el.src,
            position: {
              x: pxToInch(rect.left),
              y: pxToInch(rect.top),
              w: pxToInch(rect.width),
              h: pxToInch(rect.height)
            }
          });
          processed.add(el);
          return;
        }
      }

      if (isBadgeElement(el)) {
        const rect = el.getBoundingClientRect();
        const computed = window.getComputedStyle(el);
        const rectRadius = getRectRadius(computed, rect);
        const hasBorder = parseFloat(computed.borderWidth) > 0;

        pushElement(el, {
          type: 'shape',
          text: '',
          position: {
            x: pxToInch(rect.left),
            y: pxToInch(rect.top),
            w: pxToInch(rect.width),
            h: pxToInch(rect.height)
          },
          shape: {
            fill: rgbToHex(computed.backgroundColor),
            transparency: extractAlpha(computed.backgroundColor),
            line: hasBorder
              ? { color: rgbToHex(computed.borderColor), width: pxToPoints(computed.borderWidth) }
              : null,
            rectRadius
          }
        });

        const text = applyTextTransform(el.textContent.trim(), computed.textTransform);
        if (text) {
          const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight, 10) >= 600;
          const fontStyle = resolveFontStyle(computed.fontFamily, isBold);
          const baseStyle = {
            fontSize: pxToPoints(computed.fontSize),
            fontFace: fontStyle.fontFace,
            color: rgbToHex(computed.color),
            align: 'center',
            valign: 'mid',
            lineSpacing: computed.lineHeight && computed.lineHeight !== 'normal'
              ? pxToPoints(computed.lineHeight)
              : null,
            margin: [0, 0, 0, 0]
          };

          const transparency = extractAlpha(computed.color);
          if (transparency !== null) baseStyle.transparency = transparency;

          pushElement(el, {
            type: 'badge',
            text,
            position: {
              x: pxToInch(rect.left),
              y: pxToInch(rect.top),
              w: pxToInch(rect.width),
              h: pxToInch(rect.height)
            },
            style: {
              ...baseStyle,
              bold: fontStyle.bold,
              italic: computed.fontStyle === 'italic',
              underline: computed.textDecoration.includes('underline')
            }
          });
        }

        processed.add(el);
        return;
      }

      if (el.tagName === 'TABLE') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const computed = window.getComputedStyle(el);
          const hasBg = !isTransparent(computed.backgroundColor);
          const shadow = parseBoxShadow(computed.boxShadow);

          if (hasBg || shadow) {
            pushElement(el, {
              type: 'shape',
              text: '',
              position: {
                x: pxToInch(rect.left),
                y: pxToInch(rect.top),
                w: pxToInch(rect.width),
                h: pxToInch(rect.height)
              },
              shape: {
                fill: hasBg ? rgbToHex(computed.backgroundColor) : null,
                transparency: hasBg ? extractAlpha(computed.backgroundColor) : null,
                line: null,
                rectRadius: getRectRadius(computed, rect),
                shadow
              }
            });
          }
        }
        processed.add(el);
        return;
      }

      if (el.tagName === 'TD' || el.tagName === 'TH') {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          processed.add(el);
          return;
        }

        const computed = window.getComputedStyle(el);
        const bgColorEffective = getEffectiveBackground(el);
        const hasBg = !isTransparent(bgColorEffective);
        const borderTop = parseFloat(computed.borderTopWidth) || 0;
        const borderRight = parseFloat(computed.borderRightWidth) || 0;
        const borderBottom = parseFloat(computed.borderBottomWidth) || 0;
        const borderLeft = parseFloat(computed.borderLeftWidth) || 0;

        const x = pxToInch(rect.left);
        const y = pxToInch(rect.top);
        const w = pxToInch(rect.width);
        const h = pxToInch(rect.height);

        if (hasBg) {
          pushElement(el, {
            type: 'shape',
            text: '',
            position: { x, y, w, h },
            shape: {
              fill: rgbToHex(bgColorEffective),
              transparency: extractAlpha(bgColorEffective),
              line: null,
              rectRadius: 0
            }
          });
        }

        const addBorderLine = (widthPx, color, x1, y1, x2, y2) => {
          if (widthPx <= 0) return;
          const widthPt = pxToPoints(`${widthPx}px`);
          if (widthPt <= 0) return;
          pushElement(el, {
            type: 'line',
            x1,
            y1,
            x2,
            y2,
            width: widthPt,
            color: rgbToHex(color)
          });
        };

        if (borderTop > 0) {
          const widthPt = pxToPoints(computed.borderTopWidth);
          const inset = (widthPt / 72) / 2;
          addBorderLine(borderTop, computed.borderTopColor, x, y + inset, x + w, y + inset);
        }
        if (borderRight > 0) {
          const widthPt = pxToPoints(computed.borderRightWidth);
          const inset = (widthPt / 72) / 2;
          addBorderLine(borderRight, computed.borderRightColor, x + w - inset, y, x + w - inset, y + h);
        }
        if (borderBottom > 0) {
          const widthPt = pxToPoints(computed.borderBottomWidth);
          const inset = (widthPt / 72) / 2;
          addBorderLine(borderBottom, computed.borderBottomColor, x, y + h - inset, x + w, y + h - inset);
        }
        if (borderLeft > 0) {
          const widthPt = pxToPoints(computed.borderLeftWidth);
          const inset = (widthPt / 72) / 2;
          addBorderLine(borderLeft, computed.borderLeftColor, x + inset, y, x + inset, y + h);
        }

        const rawText = el.textContent.trim();
        if (rawText) {
          const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight, 10) >= 600;
          const fontStyle = resolveFontStyle(computed.fontFamily, isBold);
          const baseStyle = {
            fontSize: pxToPoints(computed.fontSize),
            fontFace: fontStyle.fontFace,
            color: rgbToHex(computed.color),
            align: computed.textAlign === 'start' ? 'left' : computed.textAlign,
            lineSpacing: computed.lineHeight && computed.lineHeight !== 'normal'
              ? pxToPoints(computed.lineHeight)
              : null,
            paraSpaceBefore: 0,
            paraSpaceAfter: 0,
            margin: [
              pxToPoints(computed.paddingLeft),
              pxToPoints(computed.paddingRight),
              pxToPoints(computed.paddingBottom),
              pxToPoints(computed.paddingTop)
            ],
            valign: computed.verticalAlign === 'middle'
              ? 'mid'
              : computed.verticalAlign === 'bottom'
                ? 'bottom'
                : 'top',
            bold: fontStyle.bold
          };

          const transparency = extractAlpha(computed.color);
          if (transparency !== null) baseStyle.transparency = transparency;

          const hasFormatting = el.querySelector('b, i, u, strong, em, span, br');

          if (hasFormatting) {
            const transformStr = computed.textTransform;
            const runs = parseInlineFormatting(
              el,
              {},
              [],
              (text) => applyTextTransform(text, transformStr),
              (node) => isBadgeSpan(node)
            );

            if (runs.length > 0) {
              const adjustedStyle = { ...baseStyle };
              if (adjustedStyle.lineSpacing) {
                const maxFontSize = Math.max(
                  adjustedStyle.fontSize,
                  ...runs.map((run) => run.options?.fontSize || 0)
                );
                if (maxFontSize > adjustedStyle.fontSize) {
                  const lineHeightMultiplier = adjustedStyle.lineSpacing / adjustedStyle.fontSize;
                  adjustedStyle.lineSpacing = maxFontSize * lineHeightMultiplier;
                }
              }

              pushElement(el, {
                type: 'cell',
                text: runs,
                position: { x, y, w, h },
                style: adjustedStyle
              });
            }
          } else {
            const transformedText = applyTextTransform(rawText, computed.textTransform);

            pushElement(el, {
              type: 'cell',
              text: transformedText,
              position: { x, y, w, h },
              style: {
                ...baseStyle,
                italic: computed.fontStyle === 'italic',
                underline: computed.textDecoration.includes('underline')
              }
            });
          }
        }

        processed.add(el);
        return;
      }

      if (el.tagName === 'LI') {
        if (el.closest('td, th')) {
          processed.add(el);
          return;
        }

        const parentList = el.parentElement && (el.parentElement.tagName === 'UL' || el.parentElement.tagName === 'OL')
          ? el.parentElement
          : el.closest('ul, ol');

        if (!parentList) {
          processed.add(el);
          return;
        }

        const liRect = el.getBoundingClientRect();
        if (liRect.width === 0 || liRect.height === 0) {
          processed.add(el);
          return;
        }

        const liComputed = window.getComputedStyle(el);
        const listStyleType = liComputed.listStyleType;
        const listStylePosition = liComputed.listStylePosition || 'outside';
        const isOrdered = parentList.tagName === 'OL';

        const listIndex = getListItemValue(parentList, el);
        const markerContent = normalizeMarkerContent(window.getComputedStyle(el, '::marker').content);
        let markerText = markerContent;
        if (!markerText) {
          markerText = isOrdered ? formatOrderedMarker(listStyleType, listIndex) : formatUnorderedMarker(listStyleType);
        }

        const nestedList = el.querySelector('ul, ol');
        const skipNested = (node) => {
          const elementNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
          if (!elementNode) return false;
          const listAncestor = elementNode.closest('ul, ol');
          return listAncestor && listAncestor !== parentList;
        };

        const transformStr = liComputed.textTransform;
        const runs = parseInlineFormatting(el, {}, [], (text) => applyTextTransform(text, transformStr), skipNested);
        if (runs.length === 0) {
          processed.add(el);
          return;
        }

        let labelRect = null;
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          if (nestedList) range.setEndBefore(nestedList);
          const rect = range.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) labelRect = rect;
        } catch (err) {
          labelRect = null;
        }

        const lineHeightPx = liComputed.lineHeight && liComputed.lineHeight !== 'normal'
          ? parseFloat(liComputed.lineHeight)
          : parseFloat(liComputed.fontSize) * 1.2;

        const labelTop = labelRect && labelRect.height > 0 ? labelRect.top : liRect.top;
        const labelHeight = labelRect && labelRect.height > 0 ? labelRect.height : lineHeightPx;
        const labelLeft = labelRect && labelRect.width > 0 ? labelRect.left : liRect.left;
        const contentRight = liRect.right;

        const isBold = liComputed.fontWeight === 'bold' || parseInt(liComputed.fontWeight, 10) >= 600;
        const fontStyle = resolveFontStyle(liComputed.fontFamily, isBold);
        const baseStyle = {
          fontSize: pxToPoints(liComputed.fontSize),
          fontFace: fontStyle.fontFace,
          color: rgbToHex(liComputed.color),
          align: liComputed.textAlign === 'start' ? 'left' : liComputed.textAlign,
          lineSpacing: liComputed.lineHeight && liComputed.lineHeight !== 'normal'
            ? pxToPoints(liComputed.lineHeight)
            : null,
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          margin: [
            pxToPoints(liComputed.paddingLeft),
            pxToPoints(liComputed.paddingRight),
            pxToPoints(liComputed.paddingBottom),
            pxToPoints(liComputed.paddingTop)
          ],
          valign: 'top',
          bold: fontStyle.bold
        };

        const transparency = extractAlpha(liComputed.color);
        if (transparency !== null) baseStyle.transparency = transparency;

        const adjustedStyle = { ...baseStyle };
        if (adjustedStyle.lineSpacing) {
          const maxFontSize = Math.max(
            adjustedStyle.fontSize,
            ...runs.map((run) => run.options?.fontSize || 0)
          );
          if (maxFontSize > adjustedStyle.fontSize) {
            const lineHeightMultiplier = adjustedStyle.lineSpacing / adjustedStyle.fontSize;
            adjustedStyle.lineSpacing = maxFontSize * lineHeightMultiplier;
          }
        }

        const markerGap = Math.max(0, labelLeft - liRect.left);
        const useSeparateMarker = markerText && markerGap > 1 && listStylePosition !== 'inside';

        if (useSeparateMarker) {
          const markerWidth = markerGap > 1 ? markerGap : measureTextWidth(markerText, liComputed);
          const markerStyle = {
            ...baseStyle,
            align: 'right'
          };

          if (markerText) {
            pushElement(el, {
              type: 'list-marker',
              text: markerText,
              position: {
                x: pxToInch(liRect.left),
                y: pxToInch(labelTop),
                w: pxToInch(markerWidth),
                h: pxToInch(labelHeight)
              },
              style: markerStyle
            });
          }

          pushElement(el, {
            type: 'list-item',
            text: runs,
            position: {
              x: pxToInch(labelLeft),
              y: pxToInch(labelTop),
              w: pxToInch(Math.max(1, liRect.right - labelLeft)),
              h: pxToInch(labelHeight)
            },
            style: adjustedStyle
          });
        } else {
          if (markerText) {
            runs.unshift({ text: `${markerText} `, options: {} });
          }
          pushElement(el, {
            type: 'list-item',
            text: runs,
            position: {
              x: pxToInch(labelLeft),
              y: pxToInch(labelTop),
              w: pxToInch(Math.max(1, contentRight - labelLeft)),
              h: pxToInch(labelHeight)
            },
            style: adjustedStyle
          });
        }

        processed.add(el);
        return;
      }

      if (textTags.includes(el.tagName)) {
        const computed = window.getComputedStyle(el);
        const hasBg = computed.backgroundColor && !isTransparent(computed.backgroundColor);
        const hasBorder = (computed.borderWidth && parseFloat(computed.borderWidth) > 0)
          || (computed.borderTopWidth && parseFloat(computed.borderTopWidth) > 0)
          || (computed.borderRightWidth && parseFloat(computed.borderRightWidth) > 0)
          || (computed.borderBottomWidth && parseFloat(computed.borderBottomWidth) > 0)
          || (computed.borderLeftWidth && parseFloat(computed.borderLeftWidth) > 0);
        const hasShadow = computed.boxShadow && computed.boxShadow !== 'none';

        if (hasBg || hasBorder || hasShadow) {
          errors.push(
            `Text element <${el.tagName.toLowerCase()}> has ${hasBg ? 'background' : hasBorder ? 'border' : 'shadow'}. ` +
            'Backgrounds, borders, and shadows are only supported on <div> elements, not text elements.'
          );
        }
      }

      const isContainer = el.tagName === 'DIV' && !textTags.includes(el.tagName);
      if (isContainer) {
        const computed = window.getComputedStyle(el);
        const hasBg = computed.backgroundColor && !isTransparent(computed.backgroundColor);
        const hasBlockDescendant = el.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,li,table,thead,tbody,tr,td,th,div');
        const hasInlineText = el.textContent && el.textContent.trim().length > 0;

        if (hasInlineText && hasBlockDescendant) {
          const textPreview = el.textContent.trim().substring(0, 50);
          errors.push(
            `DIV element contains mixed inline text "${textPreview}${el.textContent.length > 50 ? '...' : ''}". ` +
            'Inline text will be skipped when block-level descendants exist.'
          );
        }

        const bgImageLocal = computed.backgroundImage;
        if (bgImageLocal && bgImageLocal !== 'none') {
          errors.push(
            'Background images on DIV elements are not supported. ' +
            'Use solid colors or remove background images on DIV elements.'
          );
        }

        const borderTop = computed.borderTopWidth;
        const borderRight = computed.borderRightWidth;
        const borderBottom = computed.borderBottomWidth;
        const borderLeft = computed.borderLeftWidth;
        const borders = [borderTop, borderRight, borderBottom, borderLeft].map((b) => parseFloat(b) || 0);
        const hasBorder = borders.some((b) => b > 0);
        const hasUniformBorder = hasBorder && borders.every((b) => b === borders[0]);
        const borderLines = [];

        if (hasBorder && !hasUniformBorder) {
          const rect = el.getBoundingClientRect();
          const x = pxToInch(rect.left);
          const y = pxToInch(rect.top);
          const w = pxToInch(rect.width);
          const h = pxToInch(rect.height);

          if (parseFloat(borderTop) > 0) {
            const widthPt = pxToPoints(borderTop);
            const inset = (widthPt / 72) / 2;
            borderLines.push({
              type: 'line',
              x1: x,
              y1: y + inset,
              x2: x + w,
              y2: y + inset,
              width: widthPt,
              color: rgbToHex(computed.borderTopColor)
            });
          }
          if (parseFloat(borderRight) > 0) {
            const widthPt = pxToPoints(borderRight);
            const inset = (widthPt / 72) / 2;
            borderLines.push({
              type: 'line',
              x1: x + w - inset,
              y1: y,
              x2: x + w - inset,
              y2: y + h,
              width: widthPt,
              color: rgbToHex(computed.borderRightColor)
            });
          }
          if (parseFloat(borderBottom) > 0) {
            const widthPt = pxToPoints(borderBottom);
            const inset = (widthPt / 72) / 2;
            borderLines.push({
              type: 'line',
              x1: x,
              y1: y + h - inset,
              x2: x + w,
              y2: y + h - inset,
              width: widthPt,
              color: rgbToHex(computed.borderBottomColor)
            });
          }
          if (parseFloat(borderLeft) > 0) {
            const widthPt = pxToPoints(borderLeft);
            const inset = (widthPt / 72) / 2;
            borderLines.push({
              type: 'line',
              x1: x + inset,
              y1: y,
              x2: x + inset,
              y2: y + h,
              width: widthPt,
              color: rgbToHex(computed.borderLeftColor)
            });
          }
        }

        if (hasBg || hasBorder) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const shadow = parseBoxShadow(computed.boxShadow);

            if (hasBg || hasUniformBorder) {
              pushElement(el, {
                type: 'shape',
                text: '',
                position: {
                  x: pxToInch(rect.left),
                  y: pxToInch(rect.top),
                  w: pxToInch(rect.width),
                  h: pxToInch(rect.height)
                },
                shape: {
                  fill: hasBg ? rgbToHex(computed.backgroundColor) : null,
                  transparency: hasBg ? extractAlpha(computed.backgroundColor) : null,
                  line: hasUniformBorder
                    ? { color: rgbToHex(computed.borderColor), width: pxToPoints(computed.borderWidth) }
                    : null,
                  rectRadius: getRectRadius(computed, rect),
                  shadow
                }
              });
            }

            borderLines.forEach((line) => {
              pushElement(el, line);
            });
          }
        }

        if (hasInlineText && !hasBlockDescendant) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const rotation = getRotation(computed.transform, computed.writingMode);
            const { x, y, w, h } = getPositionAndSize(el, rect, rotation);

            const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight, 10) >= 600;
            const fontStyle = resolveFontStyle(computed.fontFamily, isBold);
            const baseStyle = {
              fontSize: pxToPoints(computed.fontSize),
              fontFace: fontStyle.fontFace,
              color: rgbToHex(computed.color),
              align: computed.textAlign === 'start' ? 'left' : computed.textAlign,
              lineSpacing: computed.lineHeight && computed.lineHeight !== 'normal'
                ? pxToPoints(computed.lineHeight)
                : null,
              paraSpaceBefore: 0,
              paraSpaceAfter: 0,
              margin: [
                pxToPoints(computed.paddingLeft),
                pxToPoints(computed.paddingRight),
                pxToPoints(computed.paddingBottom),
                pxToPoints(computed.paddingTop)
              ],
              valign: 'top',
              bold: fontStyle.bold
            };

            const transparency = extractAlpha(computed.color);
            if (transparency !== null) baseStyle.transparency = transparency;
            if (rotation !== null) baseStyle.rotate = rotation;

            const transformStr = computed.textTransform;
            const runs = parseInlineFormatting(el, {}, [], (text) => applyTextTransform(text, transformStr));
            if (runs.length > 0) {
              const adjustedStyle = { ...baseStyle };
              if (adjustedStyle.lineSpacing) {
                const maxFontSize = Math.max(
                  adjustedStyle.fontSize,
                  ...runs.map((run) => run.options?.fontSize || 0)
                );
                if (maxFontSize > adjustedStyle.fontSize) {
                  const lineHeightMultiplier = adjustedStyle.lineSpacing / adjustedStyle.fontSize;
                  adjustedStyle.lineSpacing = maxFontSize * lineHeightMultiplier;
                }
              }

              pushElement(el, {
                type: 'div-text',
                text: runs,
                position: { x: pxToInch(x), y: pxToInch(y), w: pxToInch(w), h: pxToInch(h) },
                style: adjustedStyle
              });
            }
          }
        }

        processed.add(el);
        return;
      }

      if (el.tagName === 'UL' || el.tagName === 'OL') {
        processed.add(el);
        return;
      }

      if (!textTags.includes(el.tagName)) return;

      const rect = el.getBoundingClientRect();
      const text = el.textContent.trim();
      if (rect.width === 0 || rect.height === 0 || !text) return;

      if (el.tagName !== 'LI' && /^[•\-\*▪▸○●◆◇■□]\s/.test(text.trimStart())) {
        errors.push(
          `Text element <${el.tagName.toLowerCase()}> starts with bullet symbol "${text.substring(0, 20)}...". ` +
          'Use <ul> or <ol> lists instead of manual bullet symbols.'
        );
        return;
      }

      const computed = window.getComputedStyle(el);
      const rotation = getRotation(computed.transform, computed.writingMode);
      const { x, y, w, h } = getPositionAndSize(el, rect, rotation);

      const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight, 10) >= 600;
      const fontStyle = resolveFontStyle(computed.fontFamily, isBold);
      const baseStyle = {
        fontSize: pxToPoints(computed.fontSize),
        fontFace: fontStyle.fontFace,
        color: rgbToHex(computed.color),
        align: computed.textAlign === 'start' ? 'left' : computed.textAlign,
        lineSpacing: pxToPoints(computed.lineHeight),
        paraSpaceBefore: pxToPoints(computed.marginTop),
        paraSpaceAfter: pxToPoints(computed.marginBottom),
        margin: [
          pxToPoints(computed.paddingLeft),
          pxToPoints(computed.paddingRight),
          pxToPoints(computed.paddingBottom),
          pxToPoints(computed.paddingTop)
        ],
        bold: fontStyle.bold
      };

      const transparency = extractAlpha(computed.color);
      if (transparency !== null) baseStyle.transparency = transparency;
      if (rotation !== null) baseStyle.rotate = rotation;

      const hasFormatting = el.querySelector('b, i, u, strong, em, span, br');

      if (hasFormatting) {
        const transformStr = computed.textTransform;
        const runs = parseInlineFormatting(el, {}, [], (text) => applyTextTransform(text, transformStr));

        const adjustedStyle = { ...baseStyle };
        if (adjustedStyle.lineSpacing) {
          const maxFontSize = Math.max(
            adjustedStyle.fontSize,
            ...runs.map((run) => run.options?.fontSize || 0)
          );
          if (maxFontSize > adjustedStyle.fontSize) {
            const lineHeightMultiplier = adjustedStyle.lineSpacing / adjustedStyle.fontSize;
            adjustedStyle.lineSpacing = maxFontSize * lineHeightMultiplier;
          }
        }

        pushElement(el, {
          type: el.tagName.toLowerCase(),
          text: runs,
          position: {
            x: pxToInch(x),
            y: pxToInch(y),
            w: pxToInch(w),
            h: pxToInch(h)
          },
          style: adjustedStyle
        });
      } else {
        const transformedText = applyTextTransform(text, computed.textTransform);

        pushElement(el, {
          type: el.tagName.toLowerCase(),
          text: transformedText,
          position: {
            x: pxToInch(x),
            y: pxToInch(y),
            w: pxToInch(w),
            h: pxToInch(h)
          },
          style: {
            ...baseStyle,
            italic: computed.fontStyle === 'italic',
            underline: computed.textDecoration.includes('underline')
          }
        });
      }

      processed.add(el);
    });

    return { background, elements, placeholders, errors };
  }, options);
}

function addBackground(slideData, targetSlide) {
  if (!slideData || !slideData.background) return;

  if (slideData.background.type === 'image' && slideData.background.path) {
    const imagePath = normalizeImagePath(slideData.background.path);
    targetSlide.background = { path: imagePath };
  } else if (slideData.background.type === 'color' && slideData.background.value) {
    targetSlide.background = { color: slideData.background.value };
  }
}

function addElements(slideData, targetSlide, pres) {
  for (const el of slideData.elements) {
    if (el.type === 'image') {
      const imagePath = normalizeImagePath(el.src);
      targetSlide.addImage({
        path: imagePath,
        x: el.position.x,
        y: el.position.y,
        w: el.position.w,
        h: el.position.h
      });
      continue;
    }

    if (el.type === 'line') {
      const x = Math.min(el.x1, el.x2);
      const y = Math.min(el.y1, el.y2);
      const w = Math.max(0.01, Math.abs(el.x2 - el.x1));
      const h = Math.max(0.01, Math.abs(el.y2 - el.y1));
      targetSlide.addShape(pres.ShapeType.line, {
        x,
        y,
        w,
        h,
        line: { color: el.color, width: el.width }
      });
      continue;
    }

    if (el.type === 'shape') {
      const shapeOptions = {
        x: el.position.x,
        y: el.position.y,
        w: el.position.w,
        h: el.position.h,
        shape: el.shape.rectRadius > 0 ? pres.ShapeType.roundRect : pres.ShapeType.rect
      };

      if (el.shape.fill) {
        shapeOptions.fill = { color: el.shape.fill };
        if (el.shape.transparency != null) shapeOptions.fill.transparency = el.shape.transparency;
      }
      if (el.shape.line) shapeOptions.line = el.shape.line;
      if (el.shape.rectRadius > 0) shapeOptions.rectRadius = el.shape.rectRadius;
      if (el.shape.shadow) shapeOptions.shadow = el.shape.shadow;

      targetSlide.addText(el.text || '', shapeOptions);
      continue;
    }

    if (el.type === 'list') {
      const listOptions = {
        x: el.position.x,
        y: el.position.y,
        w: el.position.w,
        h: el.position.h,
        fontSize: el.style.fontSize,
        fontFace: el.style.fontFace,
        color: el.style.color,
        align: el.style.align,
        valign: 'top',
        lineSpacing: el.style.lineSpacing,
        paraSpaceBefore: el.style.paraSpaceBefore,
        paraSpaceAfter: el.style.paraSpaceAfter,
        margin: el.style.margin
      };
      if (el.style.margin) listOptions.margin = el.style.margin;
      targetSlide.addText(el.items, listOptions);
      continue;
    }

    const lineHeight = el.style.lineSpacing || el.style.fontSize * 1.2;
    const isSingleLine = el.position.h <= lineHeight * 1.5;

    let adjustedX = el.position.x;
    let adjustedW = el.position.w;

    if (isSingleLine) {
      const widthIncrease = el.position.w * 0.02;
      const align = el.style.align;

      if (align === 'center') {
        adjustedX = el.position.x - (widthIncrease / 2);
        adjustedW = el.position.w + widthIncrease;
      } else if (align === 'right') {
        adjustedX = el.position.x - widthIncrease;
        adjustedW = el.position.w + widthIncrease;
      } else {
        adjustedW = el.position.w + widthIncrease;
      }
    }

    const textOptions = {
      x: adjustedX,
      y: el.position.y,
      w: adjustedW,
      h: el.position.h,
      fontSize: el.style.fontSize,
      fontFace: el.style.fontFace,
      color: el.style.color,
      bold: el.style.bold,
      italic: el.style.italic,
      underline: el.style.underline,
      valign: el.style.valign || 'top',
      lineSpacing: el.style.lineSpacing,
      paraSpaceBefore: el.style.paraSpaceBefore,
      paraSpaceAfter: el.style.paraSpaceAfter,
      inset: 0
    };

    if (el.style.align) textOptions.align = el.style.align;
    if (el.style.margin) textOptions.margin = el.style.margin;
    if (el.style.rotate !== undefined) textOptions.rotate = el.style.rotate;
    if (el.style.transparency !== null && el.style.transparency !== undefined) {
      textOptions.transparency = el.style.transparency;
    }

    targetSlide.addText(el.text, textOptions);
  }
}

function getElementVerticalBounds(el) {
  if (el.type === 'line') {
    const top = Math.min(el.y1, el.y2);
    const bottom = Math.max(el.y1, el.y2);
    return { top, bottom };
  }

  if (el.position) {
    return { top: el.position.y, bottom: el.position.y + el.position.h };
  }

  return null;
}

function offsetElementForSlice(el, offsetIn) {
  if (el.type === 'line') {
    return { ...el, y1: el.y1 - offsetIn, y2: el.y2 - offsetIn };
  }

  if (!el.position) return el;
  return {
    ...el,
    position: {
      ...el.position,
      y: el.position.y - offsetIn
    }
  };
}

function collectSectionBounds(elements) {
  const sectionBounds = new Map();

  elements.forEach((el, index) => {
    const bounds = getElementVerticalBounds(el);
    if (!bounds) return;
    const sectionId = el.meta && el.meta.sectionId ? el.meta.sectionId : null;
    if (!sectionId) return;

    const existing = sectionBounds.get(sectionId);
    if (!existing) {
      sectionBounds.set(sectionId, {
        sectionId,
        top: bounds.top,
        bottom: bounds.bottom,
        domOrder: el.meta && Number.isFinite(el.meta.domOrder) ? el.meta.domOrder : index
      });
      return;
    }

    existing.top = Math.min(existing.top, bounds.top);
    existing.bottom = Math.max(existing.bottom, bounds.bottom);
    if (Number.isFinite(el.meta && el.meta.domOrder)) {
      existing.domOrder = Math.min(existing.domOrder, el.meta.domOrder);
    }
  });

  return sectionBounds;
}

function buildBlocks(elements, slideHeightIn) {
  const sectionBounds = collectSectionBounds(elements);
  const keepTogetherSections = new Set();

  sectionBounds.forEach((section) => {
    if (section.bottom - section.top <= slideHeightIn) {
      keepTogetherSections.add(section.sectionId);
    }
  });

  const groups = new Map();

  elements.forEach((el, index) => {
    const bounds = getElementVerticalBounds(el);
    if (!bounds) return;

    const meta = el.meta || {};
    const sectionId = meta.sectionId || null;
    const sectionKept = sectionId && keepTogetherSections.has(sectionId);
    const tableId = meta.tableId || null;

    let groupKey;
    if (sectionKept) {
      groupKey = `section:${sectionId}`;
    } else if (tableId) {
      groupKey = `table:${tableId}`;
    } else if (el.type === 'image') {
      groupKey = `image:${index}`;
    } else {
      groupKey = `el:${index}`;
    }

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        top: bounds.top,
        bottom: bounds.bottom,
        domOrder: Number.isFinite(meta.domOrder) ? meta.domOrder : index,
        sectionId: sectionId,
        keepWithNext: false,
        elementIndices: []
      };
      groups.set(groupKey, group);
    }

    group.elementIndices.push(index);
    group.top = Math.min(group.top, bounds.top);
    group.bottom = Math.max(group.bottom, bounds.bottom);

    if (Number.isFinite(meta.domOrder)) {
      group.domOrder = Math.min(group.domOrder, meta.domOrder);
    }

    if (sectionId && group.sectionId && group.sectionId !== sectionId) {
      group.sectionId = null;
    }

    if (meta.isHeading && !sectionKept) {
      group.keepWithNext = true;
    }
  });

  const blocks = Array.from(groups.values()).sort((a, b) => {
    if (a.top !== b.top) return a.top - b.top;
    if (a.domOrder !== b.domOrder) return a.domOrder - b.domOrder;
    return a.bottom - b.bottom;
  });

  return blocks;
}

function mergeBlocks(first, second) {
  return {
    key: `${first.key}+${second.key}`,
    top: Math.min(first.top, second.top),
    bottom: Math.max(first.bottom, second.bottom),
    domOrder: Math.min(first.domOrder, second.domOrder),
    sectionId: first.sectionId === second.sectionId ? first.sectionId : null,
    keepWithNext: second.keepWithNext,
    elementIndices: [...first.elementIndices, ...second.elementIndices]
  };
}

function mergeKeepWithNext(blocks, slideHeightIn) {
  const merged = [];

  for (let i = 0; i < blocks.length; i += 1) {
    let current = blocks[i];

    while (current.keepWithNext && i + 1 < blocks.length) {
      const next = blocks[i + 1];
      if (!current.sectionId || current.sectionId !== next.sectionId) break;

      const mergedHeight = Math.max(current.bottom, next.bottom) - Math.min(current.top, next.top);
      if (mergedHeight > slideHeightIn) break;

      current = mergeBlocks(current, next);
      i += 1;
    }

    merged.push(current);
  }

  return merged;
}

function paginateSlideData(slideData, slideHeightIn) {
  const blocks = mergeKeepWithNext(buildBlocks(slideData.elements, slideHeightIn), slideHeightIn);
  const slides = [];
  const oversizedBlocks = [];

  if (blocks.length === 0) {
    return { slides: [{ offsetIn: 0, elements: [] }], oversizedBlocks };
  }

  blocks.forEach((block) => {
    const blockHeight = block.bottom - block.top;
    if (blockHeight > slideHeightIn) {
      oversizedBlocks.push(block);
    }
  });

  let currentSlide = null;

  blocks.forEach((block) => {
    if (!currentSlide) {
      currentSlide = { top: block.top, blocks: [block] };
      return;
    }

    const heightWithBlock = block.bottom - currentSlide.top;
    if (heightWithBlock <= slideHeightIn || currentSlide.blocks.length === 0) {
      currentSlide.blocks.push(block);
      return;
    }

    slides.push(currentSlide);
    currentSlide = { top: block.top, blocks: [block] };
  });

  if (currentSlide) slides.push(currentSlide);

  const elementToSlide = new Array(slideData.elements.length).fill(null);
  slides.forEach((slide, slideIndex) => {
    slide.blocks.forEach((block) => {
      block.elementIndices.forEach((elementIndex) => {
        elementToSlide[elementIndex] = slideIndex;
      });
    });
  });

  const slideElements = slides.map((slide) => ({ offsetIn: slide.top, elements: [] }));
  slideData.elements.forEach((el, index) => {
    const slideIndex = elementToSlide[index];
    if (slideIndex === null || slideIndex === undefined) return;
    slideElements[slideIndex].elements.push(offsetElementForSlice(el, slideElements[slideIndex].offsetIn));
  });

  return { slides: slideElements, oversizedBlocks };
}

async function buildPptx(inputPath, outputPath, options) {
  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  if (!fs.existsSync(absInput)) {
    throw new Error(`Input HTML not found: ${absInput}`);
  }

  const launchOptions = { env: { TMPDIR: options.tmpDir } };
  if (process.platform === 'darwin') {
    launchOptions.channel = 'chrome';
  }

  const browser = await chromium.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(absInput).href, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (err) {
      // Ignore font readiness errors.
    }

    let dims = await getPageDimensions(page);
    await page.setViewportSize({
      width: Math.ceil(dims.width),
      height: Math.ceil(dims.height)
    });

    dims = await getPageDimensions(page);

    const { bgMap, bgIds } = await captureGradientBackgrounds(page, options.tmpDir);

    const widthIn = dims.width / PX_PER_IN;
    const heightIn = dims.height / PX_PER_IN;
    const scaleProvided = Number.isFinite(options.scale);
    let scale = scaleProvided ? options.scale : 1;

    if (!scaleProvided && !options.split && heightIn > options.maxSlideHeightIn) {
      scale = options.maxSlideHeightIn / heightIn;
      console.warn(
        `Slide height ${heightIn.toFixed(2)}" exceeds ${options.maxSlideHeightIn}". ` +
        `Auto-scaling to ${(scale * 100).toFixed(1)}%.`
      );
    }

    const slideWidthIn = widthIn * scale;
    const scaledHeightIn = heightIn * scale;

    let slideHeightIn = scaledHeightIn;
    if (options.split && scaledHeightIn > options.maxSlideHeightIn) {
      slideHeightIn = options.maxSlideHeightIn;
    }

    const slideData = await extractSlideData(page, { scale, bgIds });

    if (slideData.errors && slideData.errors.length > 0) {
      console.warn('Conversion warnings:');
      slideData.errors.forEach((err) => console.warn(`- ${err}`));
    }

    slideData.elements = slideData.elements.map((el) => {
      if (el.type === 'bg-image') {
        const pathForBg = bgMap[el.id];
        if (!pathForBg) return null;
        return {
          type: 'image',
          src: pathForBg,
          position: el.position,
          meta: el.meta || null
        };
      }
      return el;
    }).filter(Boolean);

    let slides = [{ offsetIn: 0, elements: slideData.elements }];
    let oversizedBlocks = [];
    if (options.split) {
      const pagination = paginateSlideData(slideData, slideHeightIn);
      slides = pagination.slides;
      oversizedBlocks = pagination.oversizedBlocks;

      if (slides.length > 1) {
        console.warn(
          `Slide height ${scaledHeightIn.toFixed(2)}" exceeds ${slideHeightIn}". ` +
          `Splitting into ${slides.length} slides (content-aware).`
        );
      }
      if (oversizedBlocks.length > 0) {
        console.warn(
          `${oversizedBlocks.length} block(s) exceed slide height ${slideHeightIn}". ` +
          'Consider --scale or increasing --max-slide-height-in to avoid clipping.'
        );
      }
    }

    const pptx = new pptxgen();
    defineLayout(pptx, slideWidthIn, slideHeightIn);

    slides.forEach((slideInfo) => {
      const slide = pptx.addSlide();
      addBackground(slideData, slide);
      addElements({ ...slideData, elements: slideInfo.elements }, slide, pptx);
    });

    await pptx.writeFile({ fileName: absOutput });

    if (!options.debug) {
      Object.values(bgMap).forEach((filePath) => {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          // Ignore cleanup errors.
        }
      });
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await buildPptx(args.input, args.output, args);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
