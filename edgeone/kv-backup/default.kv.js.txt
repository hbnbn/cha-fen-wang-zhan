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
 * 存储：EdgeOne KV，不再连 PostgreSQL。
 * - 部署前要在 EdgeOne Pages 项目里创建一个 KV 命名空间，并把它绑定到
 *   本项目，绑定变量名必须填：SCORE_KV（大写，就是下面代码用的名字）。
 * - KV 的访问方式按官方《KV 存储》文档的示例：绑定变量名会被注入为一个
 *   全局变量，直接用 SCORE_KV.get(key) / SCORE_KV.put(key, value) /
 *   SCORE_KV.delete(key)，不是通过 context.env 取（官方示例里就是
 *   my_kv.get('count') 这种裸全局变量写法）。为兼容起见下面也兜底查了
 *   globalThis.SCORE_KV，其实是同一个全局变量。
 * - 数据只用两个键（键名只用字母数字下划线）：
 *     score_records  -> JSON 字符串，内容是成绩记录数组
 *     score_settings -> JSON 字符串，内容是页面设置对象
 * - KV 是最终一致（官方说约 60 秒内全球同步），且整表读写不是原子操作：
 *   查分这种小数据量、基本单人录入的场景够用；多人同时录入时后写可能
 *   覆盖先写，排名和刚录入的数据在个别边缘节点上可能延迟几十秒才可见。
 *
 * 接口行为与根目录 server.js（Render/Vercel 版）保持一致，前端页面不用改：
 *   GET    /api/settings          读页面设置（没存过时返回默认值）
 *   PUT|POST /api/settings        存页面设置
 *   GET    /api/lookup?name=&studentId=  学生查分（含总分、全体/班级排名）
 *   GET    /api/records           全部成绩列表
 *   POST   /api/records           新增一条成绩
 *   POST   /api/records/import    批量导入 { records: [...] }
 *   PUT    /api/records/:id       修改一条
 *   DELETE /api/records/:id       删除一条
 */

const RECORDS_KEY = 'score_records';
const SETTINGS_KEY = 'score_settings';

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

// 取 KV 绑定：绑定变量名 SCORE_KV 会被运行时注入为全局变量。
function getKv() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof SCORE_KV !== 'undefined' && SCORE_KV) return SCORE_KV;
  } catch (e) { /* 未绑定时 typeof 也可能抛错，忽略 */ }
  if (typeof globalThis !== 'undefined' && globalThis.SCORE_KV) return globalThis.SCORE_KV;
  return null;
}

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

// ---- 与 server.js 相同的纯逻辑（总分、科目清洗、记录形状） ----

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

// 与 server.js 的 ORDER BY exam_name, class_name, student_id, id 对齐的排序。
function sortRecords(records) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...records].sort((x, y) =>
    cmp(String(x.exam_name), String(y.exam_name)) ||
    cmp(String(x.class_name), String(y.class_name)) ||
    cmp(String(x.student_id), String(y.student_id)) ||
    (Number(x.id) - Number(y.id))
  );
}

// 查分排名：与 server.js 相同——同场考试里总分比自己高的人数 + 1。
function lookupResults(records, name, studentId) {
  const mine = sortRecords(records.filter(
    (r) => r.student_name === name && r.student_id === studentId
  ));
  if (mine.length === 0) return { found: false };
  const results = mine.map((r) => {
    const all = records.filter((x) => x.exam_name === r.exam_name);
    const myTotal = Number(r.total);
    const overallRank = 1 + all.filter((x) => Number(x.total) > myTotal).length;
    const classmates = all.filter((x) => x.class_name === r.class_name);
    const classRank = 1 + classmates.filter((x) => Number(x.total) > myTotal).length;
    return {
      ...rowToRecord(r),
      overall_rank: overallRank,
      overall_count: all.length,
      class_rank: classRank,
      class_count: classmates.length,
    };
  });
  return {
    found: true,
    student: { name, student_id: studentId, class_name: mine[0].class_name },
    results,
  };
}

// ---- KV 读写 ----

async function loadRecords(kv) {
  const text = await kv.get(RECORDS_KEY);
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

async function saveRecords(kv, records) {
  await kv.put(RECORDS_KEY, JSON.stringify(records));
}

async function loadSettings(kv) {
  const text = await kv.get(SETTINGS_KEY);
  if (!text) return { id: 1, ...DEFAULT_SETTINGS };
  try { return { id: 1, ...DEFAULT_SETTINGS, ...JSON.parse(text) }; }
  catch (e) { return { id: 1, ...DEFAULT_SETTINGS }; }
}

// ---- 主处理 ----

async function handleApi(request) {
  const kv = getKv();
  if (!kv) {
    return jsonResponse(500, { ok: false, error: '服务器未配置 KV 存储（SCORE_KV 未绑定），无法读取数据。' });
  }
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;

  if (p === '/api/settings' && method === 'GET') {
    return jsonResponse(200, { ok: true, settings: await loadSettings(kv) });
  }

  if (p === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const b = await readJsonBody(request);
    const settings = {
      id: 1,
      school_name: String(b.school_name ?? DEFAULT_SETTINGS.school_name),
      subtitle: String(b.subtitle ?? ''),
      announcement: String(b.announcement ?? ''),
      home_intro: String(b.home_intro ?? ''),
      lookup_entry_name: String(b.lookup_entry_name ?? DEFAULT_SETTINGS.lookup_entry_name),
      lookup_description: String(b.lookup_description ?? ''),
      entry_entry_name: String(b.entry_entry_name ?? DEFAULT_SETTINGS.entry_entry_name),
      footer_text: String(b.footer_text ?? ''),
    };
    await kv.put(SETTINGS_KEY, JSON.stringify(settings));
    return jsonResponse(200, { ok: true, settings });
  }

  if (p === '/api/lookup' && method === 'GET') {
    const name = (url.searchParams.get('name') || '').trim();
    const studentId = (url.searchParams.get('studentId') || '').trim();
    if (!name || !studentId) {
      return jsonResponse(400, { ok: false, error: '请输入姓名和学号' });
    }
    const records = await loadRecords(kv);
    const out = lookupResults(records, name, studentId);
    if (!out.found) return jsonResponse(200, { ok: true, found: false });
    return jsonResponse(200, { ok: true, found: true, student: out.student, results: out.results });
  }

  if (p === '/api/records' && method === 'GET') {
    const records = await loadRecords(kv);
    return jsonResponse(200, { ok: true, records: sortRecords(records).map(rowToRecord) });
  }

  if (p === '/api/records' && method === 'POST') {
    const b = await readJsonBody(request);
    const records = await loadRecords(kv);
    const subjects = cleanSubjects(b.subjects);
    const record = {
      id: records.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1,
      student_name: String(b.student_name || '').trim(),
      student_id: String(b.student_id || '').trim(),
      class_name: String(b.class_name || '').trim(),
      exam_name: String(b.exam_name || '').trim(),
      subjects,
      total: computeTotal(subjects),
    };
    records.push(record);
    await saveRecords(kv, records);
    return jsonResponse(201, { ok: true, record: rowToRecord(record) });
  }

  if (p === '/api/records/import' && method === 'POST') {
    const b = await readJsonBody(request);
    const list = Array.isArray(b.records) ? b.records : [];
    const records = await loadRecords(kv);
    let nextId = records.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
    let inserted = 0;
    for (const item of list) {
      const studentName = String(item.student_name || '').trim();
      const studentId = String(item.student_id || '').trim();
      const examName = String(item.exam_name || '').trim();
      if (!studentName || !studentId || !examName) continue;
      const subjects = cleanSubjects(item.subjects);
      records.push({
        id: nextId++,
        student_name: studentName,
        student_id: studentId,
        class_name: String(item.class_name || '').trim(),
        exam_name: examName,
        subjects,
        total: computeTotal(subjects),
      });
      inserted++;
    }
    await saveRecords(kv, records);
    return jsonResponse(200, { ok: true, inserted });
  }

  const m = p.match(/^\/api\/records\/(\d+)$/);
  if (m && method === 'PUT') {
    const b = await readJsonBody(request);
    const records = await loadRecords(kv);
    const idx = records.findIndex((r) => Number(r.id) === Number(m[1]));
    if (idx === -1) return jsonResponse(404, { ok: false, error: '记录不存在' });
    const subjects = cleanSubjects(b.subjects);
    records[idx] = {
      ...records[idx],
      student_name: String(b.student_name || '').trim(),
      student_id: String(b.student_id || '').trim(),
      class_name: String(b.class_name || '').trim(),
      exam_name: String(b.exam_name || '').trim(),
      subjects,
      total: computeTotal(subjects),
    };
    await saveRecords(kv, records);
    return jsonResponse(200, { ok: true, record: rowToRecord(records[idx]) });
  }
  if (m && method === 'DELETE') {
    const records = await loadRecords(kv);
    await saveRecords(kv, records.filter((r) => Number(r.id) !== Number(m[1])));
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(404, { ok: false, error: '接口不存在' });
}

export default async function onRequest(context) {
  try {
    return await handleApi(context.request);
  } catch (e) {
    return jsonResponse(500, { ok: false, error: (e && e.message) || '服务器错误' });
  }
}

// 供本地冒烟测试复用核心逻辑（EdgeOne 运行时不会用这些命名导出）。
export { computeTotal, cleanSubjects, lookupResults, sortRecords, handleApi, DEFAULT_SETTINGS };
