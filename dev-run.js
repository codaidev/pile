'use strict';
/**
 * 开发用：不启动 Electron，只跑 HTTP 服务端，方便用 curl / 浏览器对拍。
 *   node dev-run.js [port]
 */
const path = require('path');
const store = require('./server/store');
const { createServer } = require('./server/http');

const dataDir = process.env.NOTES_READER_DATA || path.join(__dirname, 'dev-data');
store.setDataDir(dataDir);
const port = Number(process.argv[2] || process.env.PORT || 7799);

const server = createServer({ staticDir: path.join(__dirname, 'static') });
server.listen(port, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${port}/  (data=${dataDir})`);
});
