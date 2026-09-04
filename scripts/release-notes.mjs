import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };

const version = process.argv[2] || pkg.version;
const sections = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/^## /m).slice(1);
const index = sections.findIndex(section => section.startsWith(`[${version}] - `));
if (index < 0) throw new Error(`No CHANGELOG entry for ${version}`);
const section = sections[index];
const body = section.slice(section.indexOf('\n') + 1).trim();
if (!body) throw new Error(`Empty CHANGELOG entry for ${version}`);
const previous = sections[index + 1]?.match(/^\[([^\]]+)\]/)?.[1];
const repo = 'https://github.com/yikZero/grok-ally';
console.log(`${body}\n\n[Install](${repo}/tree/v${version}#install)`
  + (previous ? ` · [Full changelog](${repo}/compare/v${previous}...v${version})` : ''));
