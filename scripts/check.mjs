import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + item.name;
    if (item.isDirectory()) await walk(path);
    else if (/\.(js|mjs)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
await walk('apps'); await walk('tests'); await walk('scripts');
const manifest = JSON.parse(await readFile('apps/extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(!manifest.host_permissions, 'No permanent all-site access.');
assert.ok(!manifest.content_scripts, 'No automatic page injection.');
assert.ok(!manifest.externally_connectable, 'No website-to-extension command channel.');
assert.ok(!manifest.permissions.includes('debugger'));
const html = await readFile('apps/extension/index.html', 'utf8');
assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
assert.ok(!/\bon\w+=/i.test(html), 'No inline handlers under extension CSP.');
console.log('Syntax and extension permission checks passed.');
