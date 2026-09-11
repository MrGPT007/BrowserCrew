import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('apps/extension', 'dist/extension', { recursive: true });
const checksums = [];
async function walk(dir) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = dir + '/' + item.name;
    if (item.isDirectory()) await walk(path);
    else checksums.push(createHash('sha256').update(await readFile(path)).digest('hex') + '  ' + path.replace('dist/', ''));
  }
}
await walk('dist/extension');
await writeFile('dist/SHA256SUMS', checksums.join('\n') + '\n');
console.log('Built ' + checksums.length + ' extension files. Load dist/extension in Chrome.');
