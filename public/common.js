// 全站共用：拉取页面设置并套用到顶部标题、导航和页脚（各页元素按 id 存在才套用）
async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const data = await r.json();
    if (!data.ok) return null;
    const s = data.settings;
    const set = (id, text) => { const el = document.getElementById(id); if (el && text != null) el.textContent = text; };
    set('schoolName', s.school_name);
    set('subtitle', s.subtitle);
    set('footerText', s.footer_text);
    set('navLookup', s.lookup_entry_name);
    set('navEntry', s.entry_entry_name);
    if (document.title && s.school_name) document.title = s.school_name;
    return s;
  } catch (e) { return null; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
