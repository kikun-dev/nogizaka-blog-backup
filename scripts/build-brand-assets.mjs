import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets/brand/SakaClip_icon_selected_original.png");
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
const outside = new Uint8Array(width * height);
const queue = new Int32Array(width * height);
let end = 0;

// The original has an opaque white canvas. Only remove light, neutral pixels
// connected to its edge; enclosed white SC and paperclip pixels stay intact.
function enqueue(index) {
  if (outside[index]) return;
  const offset = index * channels;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  if (Math.min(red, green, blue) < 180 || Math.max(red, green, blue) - Math.min(red, green, blue) > 55) return;
  outside[index] = 1;
  queue[end++] = index;
}
for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
for (let start = 0; start < end; start++) {
  const index = queue[start];
  const x = index % width;
  if (x > 0) enqueue(index - 1);
  if (x < width - 1) enqueue(index + 1);
  if (index >= width) enqueue(index - width);
  if (index < width * (height - 1)) enqueue(index + width);
}

let left = width;
let top = height;
let right = -1;
let bottom = -1;
for (let index = 0; index < width * height; index++) {
  if (outside[index]) data[index * channels + 3] = 0;
  else {
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
}
if (right < left || bottom < top) throw new Error("Icon foreground was not found");
const side = Math.max(right - left + 1, bottom - top + 1);
const cropLeft = Math.max(0, Math.min(width - side, Math.round((left + right + 1 - side) / 2)));
const cropTop = Math.max(0, Math.min(height - side, Math.round((top + bottom + 1 - side) / 2)));
const master = await sharp(data, { raw: { width, height, channels } })
  .extract({ left: cropLeft, top: cropTop, width: side, height: side }).png().toBuffer();
const resized = async (size) => sharp(master).resize(size, size, { kernel: "lanczos3" }).png().toBuffer();

await writeFile(path.join(root, "app/icon.png"), await resized(512));
await writeFile(path.join(root, "app/apple-icon.png"), await resized(180));
await writeFile(path.join(root, "public/icons/icon-192.png"), await resized(192));
await writeFile(path.join(root, "public/icons/icon-512.png"), await resized(512));

const faviconSizes = [16, 32, 48];
const faviconImages = await Promise.all(faviconSizes.map(resized));
const header = Buffer.alloc(6 + faviconSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(faviconSizes.length, 4);
let offset = header.length;
faviconImages.forEach((png, index) => {
  const entry = 6 + index * 16;
  header[entry] = faviconSizes[index];
  header[entry + 1] = faviconSizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile(path.join(root, "app/favicon.ico"), Buffer.concat([header, ...faviconImages]));

const ogBackground = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#11132e"/><stop offset="0.55" stop-color="#202260"/><stop offset="1" stop-color="#0c496f"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#7855ff" stop-opacity=".35"/><stop offset="1" stop-color="#7855ff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="210" cy="100" r="430" fill="url(#glow)"/>
  <rect x="32" y="32" width="1136" height="566" rx="36" fill="none" stroke="#ffffff" stroke-opacity=".17" stroke-width="2"/>
  <rect x="505" y="466" width="286" height="54" rx="27" fill="#ffffff" fill-opacity=".13"/>
</svg>`);
const logo = await resized(350);
// sharp's text input loads the bundled files directly, so regenerating the
// PNGs does not depend on fonts installed on the host operating system.
async function renderedText(text, size, color, fontfile, family) {
  return sharp({ text: {
    text: `<span foreground="${color}">${text}</span>`,
    font: `${family} ${size}`,
    fontfile: path.join(root, `assets/brand/fonts/${fontfile}`),
    rgba: true,
  } }).png().toBuffer();
}
const englishFont = ["DejaVuSans-Bold.ttf", "DejaVu Sans Bold"];
const japaneseFont = ["ipag.ttf", "IPAGothic"];
const lines = [
  ["SakaClip", 85, "#ffffff", englishFont, 505, 145],
  ["坂道ブログ保存ツール", 32, "#dbe9ff", japaneseFont, 507, 244],
  ["乃木坂46・櫻坂46・日向坂46の", 26, "#ffffff", japaneseFont, 507, 336],
  ["公式ブログから写真・ブログを保存", 26, "#ffffff", japaneseFont, 507, 380],
  ["非公式・個人制作ツール", 21, "#ffffff", japaneseFont, 527, 478],
];
const textLayers = await Promise.all(lines.map(async ([text, size, color, [fontfile, family], left, top]) => ({
  input: await renderedText(text, size, color, fontfile, family), left, top,
})));
const ogImage = await sharp(ogBackground).composite([{ input: logo, left: 92, top: 140 }, ...textLayers]).png().toBuffer();
await writeFile(path.join(root, "app/opengraph-image.png"), ogImage);
await writeFile(path.join(root, "app/twitter-image.png"), ogImage);

console.log(`Built SakaClip assets from ${side}px cropped master`);
