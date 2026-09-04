import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const out = 'plugins/grok-ally/dist/server.mjs';
const built = await build({ entryPoints: ['src/server.mjs'], outfile: out, bundle: true,
  platform: 'node', target: 'node22', format: 'esm', packages: 'bundle', minify: true,
  legalComments: 'eof', metafile: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
chmodSync(out, 0o755);
const packages = new Set();
for (const input of Object.keys(built.metafile.inputs)) {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
mkdirSync(path.dirname(out), { recursive: true });
const notices = [];
for (const name of [...packages].sort()) {
  const root = path.join('node_modules', name);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-APACHE', 'LICENSE-MIT']) {
    try { license = readFileSync(path.join(root, file), 'utf8'); break; } catch {}
  }
  if (!license) throw new Error(`Missing license for bundled dependency ${name}`);
  notices.push(`${name}@${pkg.version} (${pkg.license})\n${license}`);
}
writeFileSync(path.join(path.dirname(out), 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n---\n\n'));

// Both host packages contain exactly the same runtime; only discovery and path resolution differ.
const claude = 'claude/grok-ally';
mkdirSync(`${claude}/.claude-plugin`, { recursive: true });
const codexManifestPath = 'plugins/grok-ally/.codex-plugin/plugin.json';
const codexManifest = JSON.parse(readFileSync(codexManifestPath));
codexManifest.version = pkg.version;
writeFileSync(codexManifestPath, JSON.stringify(codexManifest, null, 2) + '\n');
const { interface: _ui, skills: _skills, ...manifest } = codexManifest;
writeFileSync(`${claude}/.claude-plugin/plugin.json`, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(`${claude}/.mcp.json`, JSON.stringify({ mcpServers: {
  'grok-ally': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'] },
} }, null, 2) + '\n');
cpSync('plugins/grok-ally/dist', `${claude}/dist`, { recursive: true });
cpSync('plugins/grok-ally/skills', `${claude}/skills`, { recursive: true });
