import { resolve } from 'node:path';
import { createApp } from './app.mjs';
import { createPostgresStore } from './postgres-store.mjs';

const port = Number(process.env.PORT || 4322);
const hosted = Boolean(process.env.RENDER);
if (hosted && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required on Render');
const store = process.env.DATABASE_URL ? createPostgresStore(process.env.DATABASE_URL) : undefined;
const server = createApp({ filePath: resolve(process.env.DATA_FILE || '.data/board.json'), distDir: resolve('dist'), store });
const host = hosted ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => console.log(`CommonGround listening on ${host}:${port}`));
