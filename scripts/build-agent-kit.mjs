import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist', 'agent-kit');
const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

await mkdir(output, { recursive: true });
await copyFile(resolve(root, 'server', 'mcp.mjs'), resolve(output, 'mcp.mjs'));
await writeFile(resolve(output, 'package.json'), JSON.stringify({
  name: 'crewyard-agent-connector',
  private: true,
  version: project.version,
  type: 'module',
  engines: { node: '>=22' },
  dependencies: {
    '@modelcontextprotocol/server': project.dependencies['@modelcontextprotocol/server'],
    zod: project.dependencies.zod,
  },
}, null, 2) + '\n');
