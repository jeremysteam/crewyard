import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes('--help')) {
  console.log('Usage: npm run link-folder -- --project PROJECT_ID --path FOLDER [--server URL]');
  console.log('Create a pairing code in the project UI first. The command prompts for it.');
  process.exit(0);
}

const projectId = arg('--project');
const requestedPath = arg('--path') || '.';
const base = (arg('--server') || process.env.COMMON_GROUND_URL || 'http://127.0.0.1:4322').replace(/\/$/, '');
if (!projectId) { console.error('Missing --project. Open a project and choose Connect folder.'); process.exit(1); }
let folderPath;
try {
  folderPath = await realpath(resolve(requestedPath));
  if (!(await stat(folderPath)).isDirectory()) throw new Error('The path is not a directory');
} catch (error) { console.error(`Cannot use folder: ${error.message}`); process.exit(1); }

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const code = arg('--code') || (await terminal.question('Paste the one-time pairing code: ')).trim();
terminal.close();
if (!code) { console.error('Pairing code is required.'); process.exit(1); }

try {
  const response = await fetch(`${base}/api/folder-pairings/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, projectId, path: folderPath, machine: hostname() }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Server returned ${response.status}`);
  console.log(`Linked ${folderPath} to project ${projectId} on ${hostname()}.`);
  console.log('Only the folder path was shared. No files were read or uploaded.');
} catch (error) {
  console.error(`Folder pairing failed: ${error.message}`);
  process.exitCode = 1;
}
