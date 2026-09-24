import { resolve } from 'node:path';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 4322);
const server = createApp({ filePath: resolve(process.env.DATA_FILE || '.data/board.json'), distDir: resolve('dist') });
server.listen(port, '127.0.0.1', () => console.log(`CommonGround API: http://127.0.0.1:${port}`));
