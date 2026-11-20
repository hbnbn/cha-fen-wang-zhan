/*
 * 查分网站 - EdgeOne Pages / EdgeOne Makers 边缘函数（处理全部 /api/* 请求）
 *
 * 放置位置：edge-functions/api/[[default]].js
 * - EdgeOne Makers 按 edge-functions/ 目录结构生成路由，[[default]].js 是多级
 *   动态路由，会捕获 /api/ 下的全部子路径（/api/settings、/api/records、
 *   /api/records/123、/api/records/import、/api/lookup 都进这一个函数）。
 *   出处：EdgeOne Makers 官方文档《Edge Functions》的 Routing 一节
 *   （pages.edgeone.ai/document/edge-functions）。
 * - 入口写法按官方示例：export default function onRequest(context)，
 *   context 里有 request / params / env 等。
 *   注意：国际版 EdgeOne Pages（edgeone.ai）用的是 functions/ 目录 +
 *   export function onRequest 的命名导出写法，两边不完全一样；本文件按
 *   Makers（腾讯云国内版）的写法，部署到国际版时需改目录名和导出方式。
 *
 * 存储：Neon PostgreSQL（HTTP 查询），不再用 EdgeOne KV。
 * - 背景：EdgeOne KV 开通要人工审批且一直未批下来，所以改用之前已经建好
 *   的 Neon 数据库（表由 Vercel 版建过、数据为空）。原 KV 版函数完整备份在
 *   edgeone/kv-backup/default.kv.js.txt，以后 KV 批下来想切回时可用。
 * - 部署时必须在 EdgeOne 项目设置里新增一个环境变量：
 *     变量名：DATABASE_URL
 *     变量值：Neon 控制台 Connection string 里的连接串
 *   这是密码级别的机密，只能填在 EdgeOne 平台的项目设置里，绝不能写进
 *   代码仓库、README 或任何提交文件。本文件只从运行环境读取它。
 * - 环境变量的取法做了多路兜底（不同平台版本注入方式不完全一致）：
 *   依次尝试 context.env.DATABASE_URL、context.DATABASE_URL、
 *   globalThis.DATABASE_URL、globalThis.env.DATABASE_URL、
 *   globalThis.process.env.DATABASE_URL、process.env.DATABASE_URL；
 *   context.env 若是带 get(name) 的对象也会试 env.get('DATABASE_URL')。
 * - 未配置 DATABASE_URL 时，所有 /api/* 接口返回 500：
 *   「服务器未配置 DATABASE_URL，无法读取数据。」
 *
 * Neon HTTP 查询的依据（Neon 官方文档 / 官方驱动源码）：
 * - 官方《Neon serverless driver》文档：neon() 函数用 fetch 以 HTTP 方式
 *   发单条查询，参数用 $1、$2 占位、数值单独传（sql.query(text, params)），
 *   不把用户输入拼进 SQL。
 * - 官方驱动仓库 CONFIG.md：fetchEndpoint 默认值是
 *   host => 'https://' + host + '/sql'，即 POST https://<连接串 hostname>/sql。
 * - 官方驱动的 HTTP 请求形状：请求头带 Neon-Connection-String（完整连接串）
 *   和 Content-Type: application/json，body 为 { query, params }；驱动还会带
 *   Neon-Raw-Text-Output: true 表示由客户端按返回的 fields.dataTypeID 自己
 *   解析类型，本文件照此办理（见 parseFieldValue：整数/小数转 Number、
 *   JSONB 解析成对象、布尔转 boolean，其余保留文本）。
 * - 成功响应形状与 node-postgres 结果一致：
 *   { rows, fields, rowCount, command, rowAsArray }。
 * - HTTP 接口一次请求只能执行一条语句，所以建表/建索引/写默认设置在
 *   ensureDb 里逐条发送（根目录 server.js 用 pg 时是一次发多条）。
 *
 * 表结构与根目录 server.js 完全一致（score_records / settings），首次数据
 * 请求时懒加载建表并写入默认设置行，成功后在当前函数实例内缓存，不重复建。
 *
 * 接口行为与根目录 server.js（Render/Vercel 版）保持一致，前端不用改：
 *   GET    /api/settings          读页面设置
 *   PUT|POST /api/settings        存页面设置
 *   GET    /api/lookup?name=&studentId=  学生查分（含总分、全体/班级排名）
 *   GET    /api/records           全部成绩列表
 *   POST   /api/records           新增一条成绩
 *   POST   /api/records/import    批量导入 { records: [...] }
 *   PUT    /api/records/:id       修改一条
 *   DELETE /api/records/:id       删除一条
 */

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

// ---- 环境变量读取（多路兜底，见文件头说明） ----

function envObjectValue(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  try {
    if (typeof obj.get === 'function') {
      const v = obj.get('DATABASE_URL');
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch (e) { /* 忽略，继续试属性方式 */ }
  try {
    const v = obj.DATABASE_URL;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch (e) { /* 忽略 */ }
  return undefined;
}

function getDatabaseUrl(context) {
  const candidates = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) candidates.push(v.trim()); };
  try { push(envObjectValue(context && context.env)); } catch (e) { /* 忽略 */ }
  try { push(context && context.DATABASE_URL); } catch (e) { /* 忽略 */ }
  try { push(typeof globalThis !== 'undefined' && globalThis.DATABASE_URL); } catch (e) { /* 忽略 */ }
  try { push(typeof globalThis !== 'undefined' && envObjectValue(globalThis.env)); } catch (e) { /* 忽略 */ }
  try { push(typeof globalThis !== 'undefined' && globalThis.process && envObjectValue(globalThis.process.env)); } catch (e) { /* 忽略 */ }
  try { if (typeof process !== 'undefined') push(envObjectValue(process.env)); } catch (e) { /* 忽略 */ }
  return candidates.length ? candidates[0] : null;
}

// ---- Neon HTTP 查询 ----

// 官方驱动默认 fetchEndpoint：host => 'https://' + host + '/sql'。
// 这里的 host 取连接串的 hostname（不带端口，连接串一般也不写端口）。
function neonEndpoint(connectionString) {
  const u = new URL(connectionString);
  if (!u.hostname) throw new Error('DATABASE_URL 格式不正确');
  return `https://${u.hostname}/sql`;
}

// 因为请求带了 Neon-Raw-Text-Output: true，返回值多为 Postgres 原始文本，
// 按 fields 里的 dataTypeID（Postgres 类型 OID）转成 JS 值：
//   16 bool / 20 int8 / 21 int2 / 23 int4 / 700 float4 / 701 float8 /
//   1700 numeric / 114 json / 3802 jsonb，其余（text、时间戳等）保留字符串。
function parseFieldValue(value, dataTypeID) {
  if (value === null || value === undefined) return value;
  switch (dataTypeID) {
    case 16:
      if (typeof value === 'boolean') return value;
      return value === 't' || value === 'true' || value === 'TRUE';
    case 20:
    case 21:
    case 23:
    case 700:
    case 701:
    case 1700: {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 114:
    case 3802:
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch (e) { return value; }
    default:
      return value;
  }
}

function convertNeonResult(data) {
  if (!data || typeof data !== 'object') return { rows: [], rowCount: 0 };
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const rawRows = Array.isArray(data.rows) ? data.rows : [];
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const rows = rawRows.map((row) => {
    if (Array.isArray(row)) {
      const obj = {};
      fields.forEach((f, i) => { obj[f.name] = parseFieldValue(row[i], f.dataTypeID); });
      return obj;
    }
    const obj = {};
    for (const [k, v] of Object.entries(row || {})) {
      const f = fieldByName.get(k);
      obj[k] = parseFieldValue(v, f ? f.dataTypeID : undefined);
    }
    return obj;
  });
  return { ...data, rows };
}

// 执行一条参数化 SQL。query/params 分开发送，用户输入永远只进 params，
// 不拼进 SQL 文本。
async function query(connectionString, text, params = []) {
  const response = await fetch(neonEndpoint(connectionString), {
    method: 'POST',
    headers: {
      'Neon-Connection-String': connectionString,
      'Content-Type': 'application/json',
      // 与官方驱动一致：要原始文本输出，由本文件按 dataTypeID 解析。
      'Neon-Raw-Text-Output': 'true',
    },
    body: JSON.stringify({ query: text, params }),
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { data = null; }
  }
  if (!response.ok) {
    const msg = (data && (data.message || data.error)) || `Neon HTTP 查询失败（HTTP ${response.status}）`;
    const err = new Error(msg);
    if (data && data.code) err.code = data.code;
    throw err;
  }
  return convertNeonResult(data);
}

// ---- 自动建表（与 server.js 的 initDb 等价，HTTP 版逐条发） ----

const INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS score_records (
     id SERIAL PRIMARY KEY,
     student_name TEXT NOT NULL,
     student_id TEXT NOT NULL,
     class_name TEXT NOT NULL DEFAULT '',
     exam_name TEXT NOT NULL,
     subjects JSONB NOT NULL DEFAULT '{}'::jsonb,
     total NUMERIC NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_score_records_student
     ON score_records (student_id, student_name)`,
  `CREATE INDEX IF NOT EXISTS idx_score_records_exam
     ON score_records (exam_name)`,
  `CREATE TABLE IF NOT EXISTS settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     school_name TEXT NOT NULL DEFAULT '',
     subtitle TEXT NOT NULL DEFAULT '',
     announcement TEXT NOT NULL DEFAULT '',
     home_intro TEXT NOT NULL DEFAULT '',
     lookup_entry_name TEXT NOT NULL DEFAULT '',
     lookup_description TEXT NOT NULL DEFAULT '',
     entry_entry_name TEXT NOT NULL DEFAULT '',
     footer_text TEXT NOT NULL DEFAULT ''
   )`,
];

let dbReadyPromise = null;
let dbReadyFor = null;

async function initDb(connectionString) {
  for (const stmt of INIT_STATEMENTS) {
    await query(connectionString, stmt);
  }
  await query(
    connectionString,
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
}

// 懒加载建表：第一次需要数据库时才执行，成功后缓存 Promise 不重复建表；
// 失败时清掉缓存，下次请求可重试。连接串变了（换库）会重新初始化。
function ensureDb(connectionString) {
  if (!dbReadyPromise || dbReadyFor !== connectionString) {
    dbReadyFor = connectionString;
    dbReadyPromise = initDb(connectionString).catch((e) => {
      if (dbReadyFor === connectionString) {
        dbReadyPromise = null;
        dbReadyFor = null;
      }
      throw e;
    });
  }
  return dbReadyPromise;
}

// ---- 与 server.js 相同的纯逻辑（总分、科目清洗、记录形状）与响应工具 ----

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 5 * 1024 * 1024) throw new Error('请求体过大');
  try { return JSON.parse(text); } catch (e) { throw new Error('JSON 格式不正确'); }
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
  let subjects = r.subjects || {};
  if (typeof subjects === 'string') {
    try { subjects = JSON.parse(subjects); } catch (e) { subjects = {}; }
  }
  return {
    id: r.id,
    student_name: r.student_name,
    student_id: r.student_id,
    class_name: r.class_name,
    exam_name: r.exam_name,
    subjects,
    total: Number(r.total),
  };
}

// ---- 主处理（路由与 SQL 与 server.js 的 handleApi 逐项对齐） ----

async function handleApi(request, context) {
  const connectionString = getDatabaseUrl(context);
  if (!connectionString) {
    return jsonResponse(500, { ok: false, error: '服务器未配置 DATABASE_URL，无法读取数据。' });
  }
  await ensureDb(connectionString);

  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;

  if (p === '/api/settings' && method === 'GET') {
    const { rows } = await query(connectionString, 'SELECT * FROM settings WHERE id = 1');
    return jsonResponse(200, { ok: true, settings: rows[0] || DEFAULT_SETTINGS });
  }

  if (p === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const b = await readJsonBody(request);
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
    const { rows } = await query(
      connectionString,
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
    return jsonResponse(200, { ok: true, settings: rows[0] });
  }

  if (p === '/api/lookup' && method === 'GET') {
    const name = (url.searchParams.get('name') || '').trim();
    const studentId = (url.searchParams.get('studentId') || '').trim();
    if (!name || !studentId) {
      return jsonResponse(400, { ok: false, error: '请输入姓名和学号' });
    }
    const mine = await query(
      connectionString,
      'SELECT * FROM score_records WHERE student_name = $1 AND student_id = $2 ORDER BY exam_name, id',
      [name, studentId]
    );
    if (mine.rows.length === 0) {
      return jsonResponse(200, { ok: true, found: false });
    }
    const results = [];
    for (const r of mine.rows) {
      const all = await query(
        connectionString,
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
    return jsonResponse(200, {
      ok: true, found: true,
      student: { name, student_id: studentId, class_name: mine.rows[0].class_name },
      results,
    });
  }

  if (p === '/api/records' && method === 'GET') {
    const { rows } = await query(
      connectionString,
      'SELECT * FROM score_records ORDER BY exam_name, class_name, student_id, id'
    );
    return jsonResponse(200, { ok: true, records: rows.map(rowToRecord) });
  }

  if (p === '/api/records' && method === 'POST') {
    const b = await readJsonBody(request);
    const subjects = cleanSubjects(b.subjects);
    const total = computeTotal(subjects);
    const { rows } = await query(
      connectionString,
      `INSERT INTO score_records (student_name, student_id, class_name, exam_name, subjects, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(b.student_name || '').trim(), String(b.student_id || '').trim(),
       String(b.class_name || '').trim(), String(b.exam_name || '').trim(),
       JSON.stringify(subjects), total]
    );
    return jsonResponse(201, { ok: true, record: rowToRecord(rows[0]) });
  }

  if (p === '/api/records/import' && method === 'POST') {
    const b = await readJsonBody(request);
    const list = Array.isArray(b.records) ? b.records : [];
    let inserted = 0;
    for (const item of list) {
      const subjects = cleanSubjects(item.subjects);
      const studentName = String(item.student_name || '').trim();
      const studentId = String(item.student_id || '').trim();
      const examName = String(item.exam_name || '').trim();
      if (!studentName || !studentId || !examName) continue;
      await query(
        connectionString,
        `INSERT INTO score_records (student_name, student_id, class_name, exam_name, subjects, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [studentName, studentId, String(item.class_name || '').trim(), examName,
         JSON.stringify(subjects), computeTotal(subjects)]
      );
      inserted++;
    }
    return jsonResponse(200, { ok: true, inserted });
  }

  const m = p.match(/^\/api\/records\/(\d+)$/);
  if (m && method === 'PUT') {
    const b = await readJsonBody(request);
    const subjects = cleanSubjects(b.subjects);
    const { rows } = await query(
      connectionString,
      `UPDATE score_records SET student_name=$1, student_id=$2, class_name=$3,
         exam_name=$4, subjects=$5, total=$6, updated_at=now()
       WHERE id=$7 RETURNING *`,
      [String(b.student_name || '').trim(), String(b.student_id || '').trim(),
       String(b.class_name || '').trim(), String(b.exam_name || '').trim(),
       JSON.stringify(subjects), computeTotal(subjects), Number(m[1])]
    );
    if (rows.length === 0) return jsonResponse(404, { ok: false, error: '记录不存在' });
    return jsonResponse(200, { ok: true, record: rowToRecord(rows[0]) });
  }
  if (m && method === 'DELETE') {
    await query(connectionString, 'DELETE FROM score_records WHERE id=$1', [Number(m[1])]);
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(404, { ok: false, error: '接口不存在' });
}

export default async function onRequest(context) {
  const request = (context && context.request) || context;
  try {
    return await handleApi(request, context || {});
  } catch (e) {
    return jsonResponse(500, { ok: false, error: (e && e.message) || '服务器错误' });
  }
}

// 供本地冒烟测试复用（EdgeOne 运行时不会用这些命名导出）。
export {
  computeTotal,
  cleanSubjects,
  rowToRecord,
  getDatabaseUrl,
  neonEndpoint,
  query,
  ensureDb,
  handleApi,
  DEFAULT_SETTINGS,
};
