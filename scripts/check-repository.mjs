import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', '.local', 'node_modules', 'target', 'dist']);
const required = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/README.md', 'docs/ARCHITECTURE.md', 'docs/GETTING_STARTED.md', 'docs/VERIFICATION.md', 'backend/.env.example'];
const forbidden = ['design', 'resources', 'video', 'docs/marketing', 'docs/pitch'];
const errors = [];
for (const file of required) if (!fs.existsSync(path.join(root, file))) errors.push(`Missing reference: ${file}`);
for (const dir of forbidden) if (fs.existsSync(path.join(root, dir))) errors.push(`Non-release material: ${dir}`);

const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /https?:\/\/[^\s"'<>]+[?&](?:api-key|api_key|apikey|access_token)=[^\s"'<>]{8,}/,
];
let count = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file);
    if (['proof/fixtures', 'proof/results', 'backend/artifacts'].includes(relative)) continue;
    if (entry.isDirectory()) { inspect(file); continue; }
    if (!entry.isFile()) continue;
    count++;
    if ((/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') || /-keypair\.json$/.test(entry.name)) {
      errors.push(`Private runtime file: ${relative}`);
    }
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (credentialPatterns.some(pattern => pattern.test(text))) errors.push(`Potential credential: ${relative}`);
    if (relative.endsWith('.md')) {
      for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = href.split('#')[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(file), target))) errors.push(`Broken local link: ${relative} → ${target}`);
      }
    }
  }
}
inspect(root);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository checks passed: ${count} files; required references, local links, release scope, and credential patterns.`);
}
