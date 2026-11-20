'use strict';
/*
 * 查分网站后端（Node 原生 http，无框架依赖，仅用 pg 连 PostgreSQL）
 * - 数据存 PostgreSQL：通过环境变量 DATABASE_URL 连接（部署时填 Neon 连接串）
 * - 自动建表：score_records（成绩）、settings（页面设置）。建表是懒加载的：
 *   首次数据请求时才确保表存在（兼容 Vercel Serverless 的无状态短时运行），
 *   Render / 本地长驻运行时也会在启动时先跑一遍。
 * - Neon 需要 SSL：只要有 DATABASE_URL 就开启 ssl.rejectUnauthorized=false
 * - 本地没有 DATABASE_URL 时也能启动页面，但涉及数据的接口会返回 500 提示未配置
 * - 两种运行方式共用同一套请求处理逻辑（本文件导出的 handler）：
 *   1) 长驻服务：node server.js（Render / 本地），直接运行时才 listen；
 *   2) Vercel Serverless：api/index.js 重新导出 handler 作为函数入口。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_SETTINGS = {
  school_name: '学校成绩查询',
  subtitle: '学生成绩查询系统',
  announcement: '',
  home_intro: '学生输入姓名和学号即可查询自己的成绩；老师请从成绩录入入口维护成绩。',
  lookup_entry_name: '学生查分',
  lookup_description: '输入姓名和学号，查询各科分数、总分和排名。',
  entry_entry_name: '成绩录入',
  footer_text: '',
};

let pool = null;
let warnedNoDb = false;

function getPool() {
  if (pool) return pool;
  // Serverless 环境下同一容器会复用模块/全局对象，把池缓存在 global 上，
  // 避免每次请求都新建连接池；长驻运行时行为不变（只建一个池）。
  if (global.__chaFenPool) {
    pool = global.__chaFenPool;
    return pool;
  }
  if (!process.env.DATABASE_URL) {
    if (!warnedNoDb) {
      warnedNoDb = true;
      console.warn('[warn] DATABASE_URL 未设置：页面可打开，但数据接口不可用。请按 README 配置 Neon 连接串。');
    }
    return null;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // 短时/无状态运行下连接按需取用、用完尽快释放，不依赖长连接常驻。
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  global.__chaFenPool = pool;
  return pool;
}

let dbReadyPromise = null;

// 懒加载建表：第一次需要数据库时才执行，成功后缓存 Promise 不重复建表；
// 失败时清掉缓存，下次请求可重试。没有 DATABASE_URL 时直接返回 false，
// 由 requirePool 给出「未配置」提示（与原行为一致）。
function ensureDb() {
  const activePool = getPool();
  if (!activePool) return Promise.resolve(false);
  if (!dbReadyPromise) {
    dbReadyPromise = initDb(activePool).catch((e) => {
      dbReadyPromise = null;
      throw e;
    });
  }
  return dbReadyPromise.then(() => true);
}

async function initDb(activePool) {
  await activePool.query(`
    CREATE TABLE IF NOT EXISTS score_records (
      id SERIAL PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_id TEXT NOT NULL,
      class_name TEXT NOT NULL DEFAULT '',
      exam_name TEXT NOT NULL,
      subjects JSONB NOT NULL DEFAULT '{}'::jsonb,
      total NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_score_records_student
      ON score_records (student_id, student_name);
    CREATE INDEX IF NOT EXISTS idx_score_records_exam
      ON score_records (exam_name);
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      school_name TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '',
      announcement TEXT NOT NULL DEFAULT '',
      home_intro TEXT NOT NULL DEFAULT '',
      lookup_entry_name TEXT NOT NULL DEFAULT '',
      lookup_description TEXT NOT NULL DEFAULT '',
      entry_entry_name TEXT NOT NULL DEFAULT '',
      footer_text TEXT NOT NULL DEFAULT ''
    );
  `);
  await activePool.query(
    `INSERT INTO settings (id, school_name, subtitle, announcement, home_intro,
        lookup_entry_name, lookup_description, entry_entry_name, footer_text)
     VALUES (1, $1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEFAULT_SETTINGS.school_name,
      DEFAULT_SETTINGS.subtitle,
      DEFAULT_SETTINGS.announcement,
      DEFAULT_SETTINGS.home_intro,
      DEFAULT_SETTINGS.lookup_entry_name,
      DEFAULT_SETTINGS.lookup_description,
      DEFAULT_SETTINGS.entry_entry_name,
      DEFAULT_SETTINGS.footer_text,
    ]
  );
  console.log('[db] tables ready');
}

function requirePool(res) {
  if (getPool()) return true;
  sendJson(res, 500, { ok: false, error: '服务器未配置 DATABASE_URL，无法读取数据。' });
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('JSON 格式不正确')); }
    });
    req.on('error', reject);
  });
}

function computeTotal(subjects) {
  return Object.values(subjects || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function cleanSubjects(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      const name = String(k).trim();
      if (!name) continue;
      const num = Number(v);
      if (Number.isFinite(num)) out[name] = num;
    }
  }
  return out;
}

function rowToRecord(r) {
  return {
    id: r.id,
    student_name: r.student_name,
    student_id: r.student_id,
    class_name: r.class_name,
    exam_name: r.exam_name,
    subjects: r.subjects || {},
    total: Number(r.total),
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/settings' && req.method === 'GET') {
    if (!requirePool(res)) return;
    const { rows } = await getPool().query('SELECT * FROM settings WHERE id = 1');
    sendJson(res, 200, { ok: true, settings: rows[0] || DEFAULT_SETTINGS });
    return;
  }

  if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    if (!requirePool(res)) return;
    const b = await readBody(req);
    const vals = [
      String(b.school_name ?? DEFAULT_SETTINGS.school_name),
      String(b.subtitle ?? ''),
      String(b.announcement ?? ''),
      String(b.home_intro ?? ''),
      String(b.lookup_entry_name ?? DEFAULT_SETTINGS.lookup_entry_name),
      String(b.lookup_description ?? ''),
      String(b.entry_entry_name ?? DEFAULT_SETTINGS.entry_entry_name),
      String(b.footer_text ?? ''),
    ];
    const { rows } = await getPool().query(
      `INSERT INTO settings (id, school_name, subtitle, announcement, home_intro,
          lookup_entry_name, lookup_description, entry_entry_name, footer_text)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         school_name=EXCLUDED.school_name, subtitle=EXCLUDED.subtitle,
         announcement=EXCLUDED.announcement, home_intro=EXCLUDED.home_intro,
         lookup_entry_name=EXCLUDED.lookup_entry_name,
         lookup_description=EXCLUDED.lookup_description,
         entry_entry_name=EXCLUDED.entry_entry_name, footer_text=EXCLUDED.footer_text
       RETURNING *`,
      vals
    );
    sendJson(res, 200, { ok: true, settings: rows[0] });
    return;
  }

  if (p === '/api/lookup' && req.method === 'GET') {
    if (!requirePool(res)) return;
    const name = (url.searchParams.get('name') || '').trim();
    const studentId = (url.searchParams.get('studentId') || '').trim();
    if (!name || !studentId) {
      sendJson(res, 400, { ok: false, error: '请输入姓名和学号' });
      return;
    }
    const mine = await getPool().query(
      'SELECT * FROM score_records WHERE student_name = $1 AND student_id = $2 ORDER BY exam_name, id',
      [name, studentId]
    );
    if (mine.rows.length === 0) {
      sendJson(res, 200, { ok: true, found: false });
      return;
    }
    const results = [];
    for (const r of mine.rows) {
      const all = await getPool().query(
        'SELECT total, class_name FROM score_records WHERE exam_name = $1',
        [r.exam_name]
      );
      const myTotal = Number(r.total);
      const overallRank = 1 + all.rows.filter((x) => Number(x.total) > myTotal).length;
      const classmates = all.rows.filter((x) => x.class_name === r.class_name);
      const classRank = 1 + classmates.filter((x) => Number(x.total) > myTotal).length;
      results.push({
        ...rowToRecord(r),
        overall_rank: overallRank,
        overall_count: all.rows.length,
        class_rank: classRank,
        class_count: classmates.length,
      });
    }
    sendJson(res, 200, {
      ok: true, found: true,
      student: { name, student_id: studentId, class_name: mine.rows[0].class_name },
      results,
    });
    return;
  }

  if (p === '/api/records' && req.method === 'GET') {
    if (!requirePool(res)) return;
    const { rows } = await getPool().query('SELECT * FROM score_records ORDER BY exam_name, class_name, student_id, id');
    sendJson(res, 200, { ok: true, records: rows.map(rowToRecord) });
    return;
  }

  if (p === '/api/records' && req.method === 'POST') {
    if (!requirePool(res)) return;
    const b = await readBody(req);
    const subjects = cleanSubjects(b.subjects);
    const total = computeTotal(subjects);
    const { rows } = await getPool().query(
      `INSERT INTO score_records (student_name, student_id, class_name, exam_name, subjects, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(b.student_name || '').trim(), String(b.student_id || '').trim(),
       String(b.class_name || '').trim(), String(b.exam_name || '').trim(),
       JSON.stringify(subjects), total]
    );
    sendJson(res, 201, { ok: true, record: rowToRecord(rows[0]) });
    return;
  }

  if (p === '/api/records/import' && req.method === 'POST') {
    if (!requirePool(res)) return;
    const b = await readBody(req);
    const list = Array.isArray(b.records) ? b.records : [];
    let inserted = 0;
    for (const item of list) {
      const subjects = cleanSubjects(item.subjects);
      const studentName = String(item.student_name || '').trim();
      const studentId = String(item.student_id || '').trim();
      const examName = String(item.exam_name || '').trim();
      if (!studentName || !studentId || !examName) continue;
      await getPool().query(
        `INSERT INTO score_records (student_name, student_id, class_name, exam_name, subjects, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [studentName, studentId, String(item.class_name || '').trim(), examName,
         JSON.stringify(subjects), computeTotal(subjects)]
      );
      inserted++;
    }
    sendJson(res, 200, { ok: true, inserted });
    return;
  }

  const m = p.match(/^\/api\/records\/(\d+)$/);
  if (m && req.method === 'PUT') {
    if (!requirePool(res)) return;
    const b = await readBody(req);
    const subjects = cleanSubjects(b.subjects);
    const { rows } = await getPool().query(
      `UPDATE score_records SET student_name=$1, student_id=$2, class_name=$3,
         exam_name=$4, subjects=$5, total=$6, updated_at=now()
       WHERE id=$7 RETURNING *`,
      [String(b.student_name || '').trim(), String(b.student_id || '').trim(),
       String(b.class_name || '').trim(), String(b.exam_name || '').trim(),
       JSON.stringify(subjects), computeTotal(subjects), Number(m[1])]
    );
    if (rows.length === 0) { sendJson(res, 404, { ok: false, error: '记录不存在' }); return; }
    sendJson(res, 200, { ok: true, record: rowToRecord(rows[0]) });
    return;
  }
  if (m && req.method === 'DELETE') {
    if (!requirePool(res)) return;
    await getPool().query('DELETE FROM score_records WHERE id=$1', [Number(m[1])]);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 统一的请求处理函数：长驻服务和 Vercel Serverless 共用。
// 本地/Render 时由 http.createServer 包起来 listen；
// Vercel 时由 api/index.js 直接作为函数 handler 导出。
const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // 懒加载：首次数据请求时才建表（Serverless 冷启动后同样适用）。
      await ensureDb();
      await handleApi(req, res, url);
      return;
    }
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(abs, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面不存在'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message || '服务器错误' });
  }
};

// Vercel Serverless 入口（api/index.js 重新导出本 handler）；
// 同时保留命名导出，方便其他方式引用。
module.exports = handler;
module.exports.handler = handler;
module.exports.ensureDb = ensureDb;

// 只有直接运行本文件（node server.js，Render / 本地）时才启动长驻服务；
// 被 api/index.js 或其他模块 require 时不 listen。
if (require.main === module) {
  const server = http.createServer(handler);
  ensureDb()
    .catch((e) => console.error('[db] 初始化失败（检查 DATABASE_URL 是否正确）:', e.message))
    .finally(() => {
      server.listen(PORT, () => console.log(`cha-fen server listening on http://localhost:${PORT}`));
    });
}
