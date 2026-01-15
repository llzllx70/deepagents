const fs = require("node:fs");
const path = require("node:path");
const pptxgen = require("pptxgenjs");

const EMU_PER_INCH = 914400;

function parseArgs(argv) {
	let input = null;
	let output = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--out" || arg === "-o") {
			output = argv[i + 1];
			i += 1;
			continue;
		}
		if (!input) {
			input = arg;
		}
	}
	return { input, output };
}

function resolveAssetPath(assetPath, baseDir) {
	if (!assetPath) return null;
	if (/^https?:\/\//i.test(assetPath)) return assetPath;
	if (path.isAbsolute(assetPath)) return assetPath;
	return path.resolve(baseDir, assetPath);
}

function getSlideSize(pptx) {
	const layout = pptx.presLayout || {};
	if (layout.width && layout.height) {
		return {
			w: layout.width / EMU_PER_INCH,
			h: layout.height / EMU_PER_INCH,
		};
	}
	return { w: 13.333, h: 7.5 };
}

function buildChartData(chart) {
	const series = chart.series || chart.data || [];
	return series.map((serie) => ({
		name: serie.name,
		labels: serie.labels,
		values: serie.values,
	}));
}

function buildChartOptions(theme, area, seriesCount) {
	const options = {
		x: area.x,
		y: area.y,
		w: area.w,
		h: area.h,
		showLegend: theme.chartShowLegend ?? seriesCount > 1,
		showValue: !!theme.chartShowValue,
		showTitle: false,
		chartColors: theme.chartColors,
		catAxisLabelColor: theme.mutedColor,
		valAxisLabelColor: theme.mutedColor,
		catAxisLineShow: false,
		valAxisLineShow: false,
		valGridLine: theme.chartGridColor ? { color: theme.chartGridColor, style: "solid" } : undefined,
		dataLabelColor: theme.bodyColor,
		dataLabelFontFace: theme.bodyFont,
		dataLabelFontSize: theme.itemBodySize,
	};

	if (theme.chartType === "bar") options.barDir = "bar";
	if (theme.chartType === "column") options.barDir = "col";

	Object.keys(options).forEach((key) => {
		if (options[key] === undefined) delete options[key];
	});

	return options;
}

function renderTemplate(pptx, data, baseDir) {
	const defaults = {
		layout: "LAYOUT_WIDE",
		background: "FFFFFF",
		titleFont: "Calibri",
		bodyFont: "Calibri",
		titleColor: "1F2937",
		bodyColor: "4B5563",
		mutedColor: "6B7280",
		accentColor: "2563EB",
		chartGridColor: "E5E7EB",
		titleSize: 30,
		itemTitleSize: 16,
		itemBodySize: 11,
		chartTitleSize: 12,
		chartType: "column",
		chartColors: ["4F81BD", "9BBB59"],
		chartShowLegend: true,
		chartShowValue: false,
		marginX: 0.6,
		marginY: 0.45,
		columnGap: 0.45,
		contentTop: 1.2,
		contentBottom: 0.6,
		itemGap: 0.32,
		itemImageSize: 1.0,
		itemTextGap: 0.3,
		itemTitleHeight: 0.35,
		itemLineSpacingMultiple: 1.2,
		iconSize: 0.35,
		iconGap: 0.12,
		titleHeight: 0.6,
	};

	const theme = defaults;
	pptx.layout = theme.layout;

	const slide = pptx.addSlide();
	slide.bkgd = theme.background;

	const slideSize = getSlideSize(pptx);
	const marginX = Number(theme.marginX);
	const marginY = Number(theme.marginY);
	const columnGap = Number(theme.columnGap);
	const usableW = slideSize.w - marginX * 2;
	const leftW = theme.leftWidth ? Number(theme.leftWidth) : Number((usableW * 0.46).toFixed(2));
	const rightW = usableW - leftW - columnGap;
	const leftX = marginX;
	const rightX = leftX + leftW + columnGap;

	const titleY = theme.titleY !== undefined ? Number(theme.titleY) : marginY;
	const titleH = Number(theme.titleHeight);
	const contentTop = Number(theme.contentTop);
	const contentBottom = Number(theme.contentBottom);

	if (data.meta && data.meta.title) {
		slide.addText(data.meta.title, {
			x: leftX,
			y: titleY,
			w: leftW,
			h: titleH,
			fontFace: theme.titleFont,
			fontSize: theme.titleSize,
			color: theme.titleColor,
			bold: true,
			valign: "top",
			align: "left",
		});
	}

	if (data.meta && data.meta.subtitle) {
		slide.addText(data.meta.subtitle, {
			x: leftX,
			y: titleY + titleH - 0.1,
			w: leftW,
			h: 0.35,
			fontFace: theme.bodyFont,
			fontSize: theme.itemBodySize,
			color: theme.mutedColor,
			valign: "bottom",
			align: "left",
		});
	}

	const icons = Array.isArray(data.icons) ? data.icons : [];
	if (icons.length) {
		const iconGap = Number(theme.iconGap);
		const iconSize = Number(theme.iconSize);
		const iconSizes = icons.map((icon) => ({
			w: Number(icon.w) || iconSize,
			h: Number(icon.h) || iconSize,
		}));
		const totalW = iconSizes.reduce((sum, size) => sum + size.w, 0) + iconGap * (icons.length - 1);
		const maxH = iconSizes.reduce((max, size) => Math.max(max, size.h), 0);
		const iconY = theme.iconY !== undefined ? Number(theme.iconY) : titleY + (titleH - maxH) / 2;
		let iconX = slideSize.w - marginX - totalW;

		icons.forEach((icon, idx) => {
			const size = iconSizes[idx];
			const iconPath = resolveAssetPath(icon.path, baseDir);
			if (iconPath) {
				slide.addImage({ path: iconPath, x: iconX, y: iconY, w: size.w, h: size.h });
			}
			iconX += size.w + iconGap;
		});
	}

	const items = Array.isArray(data.leftItems) ? data.leftItems : Array.isArray(data.items) ? data.items : [];
	if (items.length) {
		const contentH = slideSize.h - contentTop - contentBottom;
		const itemGap = Number(theme.itemGap);
		const itemH = (contentH - itemGap * (items.length - 1)) / items.length;
		const imageSizeDefault = Number(theme.itemImageSize);
		const textGap = Number(theme.itemTextGap);
		const titleBlockH = Math.min(Number(theme.itemTitleHeight), itemH * 0.45);

		items.forEach((item, index) => {
			const itemY = contentTop + index * (itemH + itemGap);
			const imageSize = Number(item.imageSize) || imageSizeDefault;
			const imageY = itemY + (itemH - imageSize) / 2;
			const imagePath = resolveAssetPath(item.image, baseDir);

			if (imagePath) {
				slide.addImage({ path: imagePath, x: leftX, y: imageY, w: imageSize, h: imageSize });
			}

			const textX = leftX + imageSize + textGap;
			const textW = leftW - imageSize - textGap;

			slide.addText(item.title || "", {
				x: textX,
				y: itemY,
				w: textW,
				h: titleBlockH,
				fontFace: theme.bodyFont,
				fontSize: theme.itemTitleSize,
				color: theme.titleColor,
				bold: true,
				valign: "top",
				align: "left",
			});

			slide.addText(item.body || "", {
				x: textX,
				y: itemY + titleBlockH,
				w: textW,
				h: itemH - titleBlockH,
				fontFace: theme.bodyFont,
				fontSize: theme.itemBodySize,
				color: theme.bodyColor,
				valign: "top",
				align: "left",
				lineSpacingMultiple: Number(theme.itemLineSpacingMultiple),
			});
		});
	}

	const chart = data.chart || null;
	if (chart && (chart.data || chart.series)) {
		const chartTitle = chart.title || "";
		let chartY = contentTop;
		let chartH = slideSize.h - contentTop - contentBottom;

		if (chartTitle) {
			slide.addText(chartTitle, {
				x: rightX,
				y: chartY,
				w: rightW,
				h: 0.3,
				fontFace: theme.bodyFont,
				fontSize: theme.chartTitleSize,
				color: theme.mutedColor,
				valign: "top",
				align: "left",
			});
			const chartTitleGap = Number(theme.chartTitleGap ?? 0.15);
			chartY += 0.3 + chartTitleGap;
			chartH = slideSize.h - chartY - contentBottom;
		}

		const chartData = buildChartData(chart);
		const chartTypeMap = {
			bar: pptx.charts.BAR,
			column: pptx.charts.BAR,
			line: pptx.charts.LINE,
			area: pptx.charts.AREA,
			pie: pptx.charts.PIE,
			doughnut: pptx.charts.DOUGHNUT,
			scatter: pptx.charts.SCATTER,
		};
		const chartType = chartTypeMap[theme.chartType] || pptx.charts.BAR;
		const chartOptions = buildChartOptions(theme, { x: rightX, y: chartY, w: rightW, h: chartH }, chartData.length);

		slide.addChart(chartType, chartData, chartOptions);
	}
}

async function main() {
	const { input, output } = parseArgs(process.argv.slice(2));
	if (!input) {
		console.error("Usage: node template1.js slide.json --out slide.pptx");
		process.exit(1);
	}

	const inputPath = path.resolve(process.cwd(), input);
	if (!fs.existsSync(inputPath)) {
		console.error(`Input JSON not found: ${inputPath}`);
		process.exit(1);
	}

	let data;
	try {
		data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
	} catch (err) {
		console.error(`Failed to parse JSON: ${err.message}`);
		process.exit(1);
	}

	const pptx = new pptxgen();
	renderTemplate(pptx, data, path.dirname(inputPath));

	const outputName = output || "template1.pptx";
	try {
		await pptx.writeFile({ fileName: outputName });
	} catch (err) {
		console.error(`Failed to write PPTX: ${err}`);
		process.exit(1);
	}
}

main();
