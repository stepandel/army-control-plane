/**
 * Generate raster assets from the existing favicon.svg (Agent Army logo):
 * - Apple touch icon (180x180)
 * - Favicon ICO (16x16 + 32x32)
 * - Favicon PNG (32x32)
 * - Android icon (192x192)
 * - OG image (1200x630) — clean design with integration flow
 *
 * Requires: npm install canvas sharp png-to-ico
 * Fonts: download Inter to /tmp/fonts/extras/ttf/ (see README)
 */
import { createCanvas, loadImage, registerFont } from "canvas";
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "website", "public");

// Register Inter font if available
const fontDir = "/tmp/fonts/extras/ttf";
if (existsSync(join(fontDir, "Inter-Regular.ttf"))) {
  registerFont(join(fontDir, "Inter-Regular.ttf"), { family: "Inter", weight: "400" });
  registerFont(join(fontDir, "Inter-Medium.ttf"), { family: "Inter", weight: "500" });
  registerFont(join(fontDir, "Inter-SemiBold.ttf"), { family: "Inter", weight: "600" });
  registerFont(join(fontDir, "Inter-Bold.ttf"), { family: "Inter", weight: "700" });
}

const c = {
  bg: "#0a0a0f",
  bgCard: "#14141e",
  primary: "#6c5ce7",
  primaryLight: "#a29bfe",
  accent: "#00d2ff",
  text: "#f0f0f5",
  textMuted: "#8888a0",
  border: "#252535",
  slack: "#E01E5A",
  slackGreen: "#2EB67D",
  slackBlue: "#36C5F0",
  slackYellow: "#ECB22E",
  linear: "#5E6AD2",
  github: "#e6edf3",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawCircle(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

function drawSlackIcon(ctx, cx, cy, size) {
  const s = size * 0.35;
  const g = s * 0.25;
  const r = s * 0.22;
  drawCircle(ctx, cx - g, cy - g - s * 0.15, r); ctx.fillStyle = c.slackBlue; ctx.fill();
  drawCircle(ctx, cx + g + s * 0.15, cy - g, r); ctx.fillStyle = c.slackGreen; ctx.fill();
  drawCircle(ctx, cx - g - s * 0.15, cy + g, r); ctx.fillStyle = c.slackYellow; ctx.fill();
  drawCircle(ctx, cx + g, cy + g + s * 0.15, r); ctx.fillStyle = c.slack; ctx.fill();
  ctx.lineCap = "round"; ctx.lineWidth = r * 1.4;
  ctx.strokeStyle = c.slackBlue; ctx.beginPath(); ctx.moveTo(cx - g, cy - g - s * 0.15); ctx.lineTo(cx - g, cy + g); ctx.stroke();
  ctx.strokeStyle = c.slackGreen; ctx.beginPath(); ctx.moveTo(cx + g + s * 0.15, cy - g); ctx.lineTo(cx - g, cy - g); ctx.stroke();
  ctx.strokeStyle = c.slack; ctx.beginPath(); ctx.moveTo(cx + g, cy + g + s * 0.15); ctx.lineTo(cx + g, cy - g); ctx.stroke();
  ctx.strokeStyle = c.slackYellow; ctx.beginPath(); ctx.moveTo(cx - g - s * 0.15, cy + g); ctx.lineTo(cx + g, cy + g); ctx.stroke();
}

function drawLinearIcon(ctx, cx, cy, size) {
  const r = size * 0.32;
  ctx.save();
  drawCircle(ctx, cx, cy, r); ctx.clip();
  ctx.strokeStyle = c.linear; ctx.lineWidth = 2.5; ctx.lineCap = "round";
  for (let i = -6; i <= 6; i++) {
    const offset = i * (r * 0.3);
    ctx.beginPath(); ctx.moveTo(cx + offset - r, cy + r); ctx.lineTo(cx + offset + r, cy - r); ctx.stroke();
  }
  ctx.restore();
  drawCircle(ctx, cx, cy, r); ctx.strokeStyle = c.linear; ctx.lineWidth = 2; ctx.stroke();
}

function drawGitHubIcon(ctx, cx, cy, size) {
  const r = size * 0.32;
  drawCircle(ctx, cx, cy, r); ctx.fillStyle = c.github; ctx.fill();
  ctx.fillStyle = c.bgCard;
  const s = r * 0.55;
  drawCircle(ctx, cx, cy - s * 0.15, s * 0.7); ctx.fill();
  roundRect(ctx, cx - s * 0.5, cy + s * 0.1, s, s * 0.7, s * 0.15); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - s * 0.55, cy - s * 0.55); ctx.lineTo(cx - s * 0.15, cy - s * 0.55); ctx.lineTo(cx - s * 0.45, cy - s * 0.9); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx + s * 0.55, cy - s * 0.55); ctx.lineTo(cx + s * 0.15, cy - s * 0.55); ctx.lineTo(cx + s * 0.45, cy - s * 0.9); ctx.closePath(); ctx.fill();
}

function drawConnection(ctx, x1, y1, x2, y2, color) {
  ctx.save(); ctx.strokeStyle = color || c.border; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
}

function drawArrow(ctx, x, y, color) {
  ctx.save(); ctx.fillStyle = color || c.textMuted;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 5); ctx.closePath(); ctx.fill(); ctx.restore();
}

// ─── Rasterize SVG ──────────────────────────────────────────────────────
async function rasterizeSvg(svgPath, size) {
  return sharp(readFileSync(svgPath)).resize(size, size).png().toBuffer();
}

// ─── OG Image ───────────────────────────────────────────────────────────
async function generateOGImage(svgBuf) {
  const W = 1200, H = 630;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background + glow
  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(780, 300, 0, 780, 300, 350);
  glow.addColorStop(0, "rgba(108,92,231,0.08)"); glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Top accent
  const topLine = ctx.createLinearGradient(0, 0, W, 0);
  topLine.addColorStop(0, "rgba(108,92,231,0)"); topLine.addColorStop(0.3, c.primary);
  topLine.addColorStop(0.7, c.accent); topLine.addColorStop(1, "rgba(0,210,255,0)");
  ctx.fillStyle = topLine; ctx.fillRect(0, 0, W, 3);

  // Logo + brand
  const logoPng = await sharp(svgBuf).resize(80, 80).png().toBuffer();
  ctx.drawImage(await loadImage(logoPng), 72, 72, 64, 64);
  ctx.fillStyle = c.textMuted; ctx.font = '600 18px Inter, sans-serif'; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Agent Army", 148, 104);

  // Headlines
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = c.text; ctx.font = 'bold 52px Inter, sans-serif'; ctx.fillText("Vera", 72, 220);
  const subGrad = ctx.createLinearGradient(72, 250, 500, 320);
  subGrad.addColorStop(0, c.text); subGrad.addColorStop(1, c.primaryLight);
  ctx.fillStyle = subGrad; ctx.font = '600 34px Inter, sans-serif';
  ctx.fillText("AI engineering agent", 72, 275); ctx.fillText("for your team", 72, 320);

  // Tagline
  ctx.fillStyle = c.textMuted; ctx.font = '400 20px Inter, sans-serif';
  ctx.fillText("Delegate in Slack. Wake up to a merged PR.", 72, 375);

  // CTA pill
  roundRect(ctx, 72, 410, 200, 44, 22); ctx.fillStyle = c.primary; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = '600 16px Inter, sans-serif'; ctx.textAlign = "center";
  ctx.fillText("agent-army.ai", 172, 437); ctx.textAlign = "left";

  // Integration cards
  const cardW = 130, cardH = 130, iconSize = 56;
  const cards = [
    { x: 600, y: 140, label: "Slack", color: c.slack, draw: drawSlackIcon },
    { x: 820, y: 140, label: "Linear", color: c.linear, draw: drawLinearIcon },
    { x: 1020, y: 140, label: "GitHub", color: c.github, draw: drawGitHubIcon },
  ];
  const veraX = 810, veraY = 380, veraW = 160, veraH = 100;

  // Lines from integrations to Vera
  cards.forEach((card) => {
    ctx.save(); ctx.strokeStyle = card.color + "40"; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(card.x + cardW / 2, card.y + cardH + 4);
    ctx.lineTo(veraX + cardW / 2, veraY - 4); ctx.stroke(); ctx.restore();
  });

  // Horizontal connections
  for (let i = 0; i < cards.length - 1; i++) {
    const y = cards[i].y + cardH / 2;
    drawConnection(ctx, cards[i].x + cardW + 8, y, cards[i + 1].x - 8, y, c.border);
    drawArrow(ctx, cards[i + 1].x - 10, y, c.textMuted);
  }

  // Draw cards
  cards.forEach((card) => {
    roundRect(ctx, card.x, card.y, cardW, cardH, 16); ctx.fillStyle = c.bgCard; ctx.fill();
    ctx.strokeStyle = c.border; ctx.lineWidth = 1; roundRect(ctx, card.x, card.y, cardW, cardH, 16); ctx.stroke();
    ctx.save(); roundRect(ctx, card.x, card.y, cardW, cardH, 16); ctx.clip();
    ctx.fillStyle = card.color + "30"; ctx.fillRect(card.x, card.y, cardW, 3); ctx.restore();
    card.draw(ctx, card.x + cardW / 2, card.y + cardH / 2 - 8, iconSize);
    ctx.fillStyle = c.textMuted; ctx.font = '500 14px Inter, sans-serif'; ctx.textAlign = "center";
    ctx.fillText(card.label, card.x + cardW / 2, card.y + cardH - 14); ctx.textAlign = "left";
  });

  // Vera card
  const veraCardX = veraX + (cardW - veraW) / 2;
  roundRect(ctx, veraCardX, veraY, veraW, veraH, 16); ctx.fillStyle = c.bgCard; ctx.fill();
  ctx.strokeStyle = c.primary + "80"; ctx.lineWidth = 2;
  roundRect(ctx, veraCardX, veraY, veraW, veraH, 16); ctx.stroke();

  const veraLogoPng = await sharp(svgBuf).resize(36, 36).png().toBuffer();
  const veraLogoCx = veraCardX + veraW / 2;
  ctx.drawImage(await loadImage(veraLogoPng), veraLogoCx - 56, veraY + 20, 32, 32);
  ctx.fillStyle = c.text; ctx.font = 'bold 26px Inter, sans-serif'; ctx.fillText("Vera", veraLogoCx - 18, veraY + 46);
  ctx.fillStyle = c.textMuted; ctx.font = '400 13px Inter, sans-serif'; ctx.textAlign = "center";
  ctx.fillText("AI Engineering Agent", veraCardX + veraW / 2, veraY + 72); ctx.textAlign = "left";

  // Footer
  ctx.fillStyle = c.border + "60"; ctx.fillRect(72, H - 60, W - 144, 1);
  ctx.fillStyle = c.textMuted + "80"; ctx.font = '400 14px Inter, sans-serif';
  ctx.fillText("Async AI agent embedded in Slack, Linear & GitHub", 72, H - 28);
  ctx.textAlign = "right"; ctx.fillText("agent-army.ai", W - 72, H - 28);

  return canvas.toBuffer("image/png");
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const svgPath = join(publicDir, "favicon.svg");
  const svgBuf = readFileSync(svgPath);

  console.log("Rasterizing favicon.svg for icon variants...");
  const logo512 = await rasterizeSvg(svgPath, 512);

  console.log("Generating apple-touch-icon (180x180)...");
  writeFileSync(join(publicDir, "apple-touch-icon.png"), await sharp(logo512).resize(180, 180).png().toBuffer());
  console.log("  ✓ apple-touch-icon.png");

  console.log("Generating favicon...");
  const f32 = await sharp(logo512).resize(32, 32).png().toBuffer();
  const f16 = await sharp(logo512).resize(16, 16).png().toBuffer();
  writeFileSync(join(publicDir, "favicon-32x32.png"), f32);
  writeFileSync(join(publicDir, "favicon.ico"), await pngToIco([f16, f32]));
  console.log("  ✓ favicon.ico + favicon-32x32.png");

  console.log("Generating icon-192 (Android)...");
  writeFileSync(join(publicDir, "icon-192.png"), await sharp(logo512).resize(192, 192).png().toBuffer());
  console.log("  ✓ icon-192.png");

  console.log("Generating OG image (1200x630)...");
  writeFileSync(join(publicDir, "og-image.png"), await generateOGImage(svgBuf));
  console.log("  ✓ og-image.png");

  console.log("\nDone!");
}

main().catch(console.error);
