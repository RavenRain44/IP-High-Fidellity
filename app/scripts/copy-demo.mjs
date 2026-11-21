// Copies the demo prototype (../frontend) into dist/demo so one deploy serves both modes:
//   /        real app (normal mode)
//   /demo/   the original simulated prototype
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'frontend');
const dest = join(here, '..', 'dist', 'demo');
if (!existsSync(src)) throw new Error(`Demo source not found at ${src}`);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied demo prototype to ${dest}`);
