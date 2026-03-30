/**
 * Generate raster assets from the existing favicon.svg (Agent Army logo):
 * - Apple touch icon (180x180)
 * - Favicon ICO (16x16 + 32x32)
 * - Favicon PNG (32x32)
 * - Android icon (192x192)
 * - OG image (1200x630) using the logo
 */
import { createCanvas, loadImage } from "canvas";
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "website", "public");

// Brand colors (matching the site's CSS variables)
const colors = {
  bg: "#0a0a0f",
  bgAlt: "#12121a",
  bgCard: "#1a1a25",
  primary: "#6c5ce7",
  primaryLight: "#a29bfe",
  accent: "#00d2ff",
  text: "#e8e8ed",
  textMuted: "#9898a8",
  border: "#2a2a3a",
};

// ─── Helper: rounded rectangle ──────────────────────────────────────────
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

// ─── Rasterize SVG at a given size via sharp ────────────────────────────
async function rasterizeSvg(svgPath, size) {
  const svgBuf = readFileSync(svgPath);
  return sharp(svgBuf).resize(size, size).png().toBuffer();
}

// ─── OG Image (1200x630) with the logo ─────────────────────────────────
async function generateOGImage(logoPngBuffer) {
  const w = 1200,
    h = 630;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle gradient overlay
  const bgGrad = ctx.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, "rgba(108, 92, 231, 0.12)");
  bgGrad.addColorStop(0.5, "rgba(10, 10, 15, 0)");
  bgGrad.addColorStop(1, "rgba(0, 210, 255, 0.08)");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // Grid pattern
  ctx.strokeStyle = "rgba(42, 42, 58, 0.4)";
  ctx.lineWidth = 0.5;
  for (let x = 0; x < w; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Decorative glows
  const drawGlow = (x, y, r, color) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  drawGlow(200, 160, 250, "rgba(108, 92, 231, 0.15)");
  drawGlow(1000, 480, 200, "rgba(0, 210, 255, 0.10)");

  // Top border accent line
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, colors.primary);
  topGrad.addColorStop(0.5, colors.accent);
  topGrad.addColorStop(1, colors.primary);
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, w, 3);

  // Draw the Agent Army logo on the right side
  const logoImg = await loadImage(logoPngBuffer);
  const logoSize = 280;
  const logoX = w - logoSize - 80;
  const logoY = (h - logoSize) / 2 - 20;
  ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);

  // Top-left: brand badge
  ctx.fillStyle = "rgba(108, 92, 231, 0.2)";
  roundRect(ctx, 60, 50, 180, 38, 19);
  ctx.fill();
  ctx.strokeStyle = "rgba(108, 92, 231, 0.4)";
  ctx.lineWidth = 1;
  roundRect(ctx, 60, 50, 180, 38, 19);
  ctx.stroke();

  ctx.fillStyle = colors.primaryLight;
  ctx.font = '600 14px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("AGENT ARMY", 150, 74);

  // Main title
  ctx.textAlign = "left";
  ctx.fillStyle = colors.text;
  ctx.font = 'bold 56px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText("Vera", 60, 170);

  // Subtitle
  ctx.font = '700 42px -apple-system, "Segoe UI", Roboto, sans-serif';
  const titleGrad = ctx.createLinearGradient(60, 190, 750, 280);
  titleGrad.addColorStop(0, colors.text);
  titleGrad.addColorStop(1, colors.primaryLight);
  ctx.fillStyle = titleGrad;
  ctx.fillText("The AI engineering agent", 60, 240);
  ctx.fillText("that works while you don't.", 60, 295);

  // Tagline
  ctx.fillStyle = colors.textMuted;
  ctx.font = '400 22px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText("Delegate a task in Slack. Wake up to a merged PR.", 60, 350);

  // Integration badges
  const badges = [
    { label: "Slack", color: "#E01E5A" },
    { label: "Linear", color: "#5E6AD2" },
    { label: "GitHub", color: "#f0f0f0" },
  ];
  let bx = 60;
  badges.forEach((b) => {
    const pw = ctx.measureText(b.label).width + 40;
    ctx.fillStyle = "rgba(26, 26, 37, 0.8)";
    roundRect(ctx, bx, 385, pw, 36, 8);
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    roundRect(ctx, bx, 385, pw, 36, 8);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(bx + 16, 403, 5, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();

    ctx.fillStyle = colors.text;
    ctx.font = '500 15px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "left";
    ctx.fillText(b.label, bx + 28, 408);

    bx += pw + 12;
  });

  // Pipeline stages at bottom
  const stages = ["Research", "Prep", "Execute", "Review", "Triage"];
  const stageStartX = 60;
  const stageY = 475;
  const stageW = 140;
  const stageGap = 18;

  stages.forEach((s, i) => {
    const sx = stageStartX + i * (stageW + stageGap);
    ctx.fillStyle = colors.bgAlt;
    roundRect(ctx, sx, stageY, stageW, 90, 10);
    ctx.fill();
    ctx.strokeStyle = i === 2 ? colors.primary : colors.border;
    ctx.lineWidth = i === 2 ? 2 : 1;
    roundRect(ctx, sx, stageY, stageW, 90, 10);
    ctx.stroke();

    ctx.fillStyle = i === 2 ? colors.primary : colors.textMuted;
    ctx.font = '600 12px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(`0${i + 1}`, sx + stageW / 2, stageY + 30);

    ctx.fillStyle = i === 2 ? colors.text : colors.textMuted;
    ctx.font = '600 16px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(s, sx + stageW / 2, stageY + 55);

    if (i < stages.length - 1) {
      ctx.fillStyle = colors.border;
      ctx.font = '400 18px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText("→", sx + stageW + stageGap / 2, stageY + 45);
    }
  });

  // Bottom right: URL
  ctx.fillStyle = colors.textMuted;
  ctx.font = '400 16px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "right";
  ctx.fillText("agent-army.ai", w - 60, h - 30);

  return canvas.toBuffer("image/png");
}

// ─── Generate all assets ────────────────────────────────────────────────
async function main() {
  const svgPath = join(publicDir, "favicon.svg");

  console.log("Rasterizing favicon.svg for icon variants...");
  const logo512 = await rasterizeSvg(svgPath, 512);

  console.log("Generating apple-touch-icon (180x180)...");
  const appleIcon = await sharp(logo512).resize(180, 180).png().toBuffer();
  writeFileSync(join(publicDir, "apple-touch-icon.png"), appleIcon);
  console.log("  ✓ website/public/apple-touch-icon.png");

  console.log("Generating favicon...");
  const favicon32 = await sharp(logo512).resize(32, 32).png().toBuffer();
  const favicon16 = await sharp(logo512).resize(16, 16).png().toBuffer();
  writeFileSync(join(publicDir, "favicon-32x32.png"), favicon32);
  console.log("  ✓ website/public/favicon-32x32.png");

  const icoBuffer = await pngToIco([favicon16, favicon32]);
  writeFileSync(join(publicDir, "favicon.ico"), icoBuffer);
  console.log("  ✓ website/public/favicon.ico");

  const android192 = await sharp(logo512).resize(192, 192).png().toBuffer();
  writeFileSync(join(publicDir, "icon-192.png"), android192);
  console.log("  ✓ website/public/icon-192.png");

  console.log("Generating OG image (1200x630) with logo...");
  const logoPng = await rasterizeSvg(svgPath, 512);
  const ogBuffer = await generateOGImage(logoPng);
  writeFileSync(join(publicDir, "og-image.png"), ogBuffer);
  console.log("  ✓ website/public/og-image.png");

  console.log("\nDone! All assets generated from favicon.svg.");
}

main().catch(console.error);
