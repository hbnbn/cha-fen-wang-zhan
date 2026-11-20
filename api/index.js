'use strict';
/*
 * Vercel Serverless Function 入口。
 * vercel.json 把 /api/* 和其余所有请求都 rewrite 到这里，
 * 这里直接重新导出根目录 server.js 的请求处理 handler：
 * 它既处理 /api/* 接口，也托管 public/ 下的静态页面，
 * 与 Render / 本地 `node server.js` 长驻运行的行为一致。
 * handler 内部是懒加载建表 + 全局缓存连接池，不依赖长连接常驻。
 */
const handler = require('../server');

module.exports = handler;

// 请求体由 server.js 自己按原始流读取（readBody），
// 关掉 Vercel 的自动 body 解析，避免 JSON 已经被解析导致读不到原始请求体。
module.exports.config = {
  api: { bodyParser: false },
};
