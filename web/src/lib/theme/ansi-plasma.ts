// Ports ascii-screensaver's MIT-licensed plasma.rs (8684dd3924a949ad661b4c600d8e5da9ab3e5056).
// See web/static/licenses/ascii-screensaver.txt for attribution and the original license.
const GLYPHS = ' .:-=+*#%@';
const COLORS = [
	[18, 22, 58],
	[20, 210, 176],
	[255, 188, 62],
] as const;

export const PLASMA_CELL_WIDTH = 7;
export const PLASMA_CELL_HEIGHT = 11;
const MAX_COLUMNS = 120;
const MAX_ROWS = 45;
const PALETTE_SIZE = 128;

export interface PlasmaScene {
	readonly phase: readonly [number, number, number, number];
	readonly speed: number;
}

export function createPlasmaScene(random: () => number = Math.random): PlasmaScene {
	return {
		phase: [random(), random(), random(), random()],
		speed: 0.45 + random() * 0.6,
	};
}

export function plasmaGrid(width: number, height: number) {
	const scale = Math.max(
		1,
		width / (MAX_COLUMNS * PLASMA_CELL_WIDTH),
		height / (MAX_ROWS * PLASMA_CELL_HEIGHT),
	);
	return {
		columns: Math.max(1, Math.min(MAX_COLUMNS, Math.ceil(width / (PLASMA_CELL_WIDTH * scale)))),
		rows: Math.max(1, Math.min(MAX_ROWS, Math.ceil(height / (PLASMA_CELL_HEIGHT * scale)))),
	};
}

export function plasmaValue(nx: number, ny: number, seconds: number, scene: PlasmaScene): number {
	const time = seconds * scene.speed;
	const wave =
		Math.sin(nx * 8 + time + scene.phase[0] * 6) +
		Math.sin(ny * 9 - time * 1.3 + scene.phase[1] * 6) +
		Math.sin((nx + ny) * 6 + time * 0.7 + scene.phase[2] * 6) +
		Math.sin(Math.hypot(nx, ny) * 14 - time * 1.8 + scene.phase[3] * 6);
	return Math.max(0, Math.min(1, wave / 8 + 0.5));
}

export function plasmaCell(value: number) {
	const bounded = Math.max(0, Math.min(0.999999, value));
	const segment = bounded < 0.5 ? 0 : 1;
	const amount = bounded * 2 - segment;
	const rgb = COLORS[segment].map((channel, index) =>
		Math.trunc(channel + (COLORS[segment + 1][index] - channel) * amount),
	);
	return { glyph: GLYPHS[Math.floor(bounded * GLYPHS.length)], color: `rgb(${rgb.join(',')})` };
}

// Quantization bounds paint styles without changing the source's waves or density ramp.
const PALETTE = Array.from({ length: PALETTE_SIZE }, (_, index) =>
	plasmaCell(index / (PALETTE_SIZE - 1)),
);

export function drawPlasma(
	context: CanvasRenderingContext2D,
	columns: number,
	rows: number,
	seconds: number,
	scene: PlasmaScene,
): void {
	context.clearRect(0, 0, columns * PLASMA_CELL_WIDTH, rows * PLASMA_CELL_HEIGHT);
	let previousColor = '';
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < columns; x++) {
			const value = plasmaValue((x / columns) * 2 - 1, (y / rows) * 2 - 1, seconds, scene);
			const cell = PALETTE[Math.round(value * (PALETTE.length - 1))];
			if (cell.color !== previousColor) {
				context.fillStyle = cell.color;
				previousColor = cell.color;
			}
			context.fillText(cell.glyph, x * PLASMA_CELL_WIDTH, y * PLASMA_CELL_HEIGHT);
		}
	}
}
