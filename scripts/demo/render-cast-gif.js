// Render an asciinema cast into fixed-size terminal PNG frames, sampled at a
// fixed fps along the cast's real timeline, for ffmpeg GIF assembly.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const castPath = process.argv[2];
const outDir = process.argv[3];
const fps = 5;
const tailHoldSeconds = 2.4;
const cols = 100;
const rows = 18;
const charW = 8.6;
const lineH = 24;
const padX = 18;
const padY = 12;
const headerH = 34;

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapLine(line) {
    const out = [];
    let rest = line;
    while (rest.length > cols) {
        out.push(rest.slice(0, cols));
        rest = '  ' + rest.slice(cols);
    }
    out.push(rest);
    return out;
}

function appendOutput(lines, data) {
    for (const raw of data.replace(/\r/g, '').split('\n')) {
        if (raw.length === 0) continue;
        for (const piece of wrapLine(raw)) lines.push(piece);
    }
}

function renderFrame(allLines, idx) {
    const width = Math.ceil(cols * charW) + padX * 2;
    const height = rows * lineH + padY * 2 + headerH;
    const visible = allLines.slice(-rows);
    const spans = visible.map((line, i) => {
        const isPrompt = line.startsWith('$') || line.startsWith('>');
        const color = isPrompt ? '#7ee787' : line.startsWith('{') ? '#79c0ff' : '#c9d1d9';
        const y = headerH + padY + (i + 1) * lineH - 7;
        return `<text x="${padX}" y="${y}" font-family="Consolas, monospace" font-size="15" fill="${color}">${esc(line)}</text>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="${headerH}" rx="10" fill="#161b22"/>
<rect y="${headerH - 10}" width="${width}" height="10" fill="#161b22"/>
<circle cx="22" cy="${headerH / 2}" r="6" fill="#ff5f56"/><circle cx="42" cy="${headerH / 2}" r="6" fill="#ffbd2e"/><circle cx="62" cy="${headerH / 2}" r="6" fill="#27c93f"/>
<text x="${width / 2}" y="${headerH / 2 + 5}" font-family="Segoe UI, sans-serif" font-size="13" fill="#8b949e" text-anchor="middle">agent &#x00B7; eide-mcp</text>
${spans}
</svg>`;
    return sharp(Buffer.from(svg), { density: 96 }).png().toFile(path.join(outDir, `frame-${String(idx).padStart(3, '0')}.png`));
}

async function main() {
    const lines = fs.readFileSync(castPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = lines.slice(1).map(l => JSON.parse(l)).filter(e => e[1] === 'o');
    const endTime = Math.max(...events.map(e => e[0])) + tailHoldSeconds;
    fs.mkdirSync(outDir, { recursive: true });
    const jobs = [];
    let idx = 0;
    for (let t = 0; t <= endTime; t += 1 / fps) {
        const lines = [];
        for (const [et, , data] of events) {
            if (et <= t) appendOutput(lines, data);
        }
        jobs.push(renderFrame(lines, idx++));
    }
    await Promise.all(jobs);
    console.log(`rendered ${idx} frames at ${fps}fps over ${endTime.toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
