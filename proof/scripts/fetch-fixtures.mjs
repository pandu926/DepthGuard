import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'fixture-manifest.json'), 'utf8'));
const folder = resolve(root, 'fixtures');
await mkdir(folder, { recursive: true });
for (const [filename, expected] of Object.entries(manifest.sha256)) {
  const target = resolve(folder, filename);
  let bytes;
  try { bytes = await readFile(target); } catch { /* download missing fixture */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${manifest.directory}/${filename}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Checksum mismatch: ${filename}`);
    await writeFile(target, bytes);
  }
  console.log(`${filename}: SHA256 verified`);
}
