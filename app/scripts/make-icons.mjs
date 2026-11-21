// Renders the home-screen PNG icons from public/icon.svg. Run: npm run icons
// PNGs use a full-bleed square: iOS and Android apply their own rounded mask.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const pub = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('icon.svg', pub), 'utf8').replace(/rx="96"/, 'rx="0"');
for (const size of [180, 192, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(new URL(name, pub), png);
  console.log(`wrote public/${name} (${png.length} bytes)`);
}
