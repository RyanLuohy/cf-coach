/* CF 教练 — offline PWA. Data lives in plan.json / menu.json. */

const $ = (sel, root = document) => root.querySelector(sel);
const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const KEYS = ['sleep', 'rhr', 'hrv', 'steps', 'workout', 'weight',
              'active', 'exercise', 'stand', 'workoutKcal', 'workoutDistance', 'hrAvg'];
const TEXT_KEYS = ['workoutType'];

let PLAN = null;
let MENU = null;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('cf_' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cf_' + key, JSON.stringify(value)); } catch (e) {}
  }
};

const state = {
  startDate: store.get('startDate', null),
  checkins: store.get('checkins', {}),
  meals: store.get('meals', {}),
  health: store.get('health', []),
  mode: store.get('mode', {}),
  skips: store.get('skips', {}),
  results: store.get('results', []),
  extraPick: store.get('extraPick', {}),
  extraDone: store.get('extraDone', {}),
  lifts: store.get('lifts', {}),
  monthOffset: store.get('monthOffset', 0),
  shortcutName: store.get('shortcutName', '同步健康数据'),
  reviewWeek: null,
  tab: 'today'
};

/* ---------- date helpers ---------- */

function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function weekdayIndex(d = new Date()) {
  return ((d.getDay() + 6) % 7) + 1;
}

function weekNumber() {
  if (!state.startDate) return 1;
  const start = parseISO(state.startDate);
  const now = new Date();
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((b - a) / 86400000);
  return Math.min(12, Math.max(1, Math.floor(days / 7) + 1));
}

function cnDate(d = new Date()) {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WD[weekdayIndex(d) - 1]}`;
}

/* ---------- data ---------- */

async function loadData() {
  const [planRes, menuRes] = await Promise.all([fetch('plan.json'), fetch('menu.json')]);
  PLAN = await planRes.json();
  MENU = await menuRes.json();
}

function currentWeek() {
  return PLAN ? PLAN.weeks.find(w => w.week === weekNumber()) : null;
}

function todaySession() {
  const w = currentWeek();
  return w ? w.days.find(d => d.weekdayIndex === weekdayIndex()) : null;
}

function todayMenu() {
  return MENU ? MENU.days.find(d => d.weekdayIndex === weekdayIndex()) : null;
}

/* ---------- health ---------- */

function todayHealth() {
  const iso = todayISO();
  return state.health.find(h => h.date === iso) || null;
}

function baseline() {
  const iso = todayISO();
  const past = state.health.filter(h => h.date < iso).slice(-14);
  const avg = key => {
    const vals = past.map(h => h[key]).filter(v => typeof v === 'number' && !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return { rhr: avg('rhr'), hrv: avg('hrv'), sleep: avg('sleep'), count: past.length };
}

function saveHealth(rec) {
  const iso = rec.date || todayISO();
  const idx = state.health.findIndex(h => h.date === iso);
  const merged = idx >= 0 ? { ...state.health[idx], ...rec, date: iso } : { ...rec, date: iso };
  if (idx >= 0) state.health[idx] = merged; else state.health.push(merged);
  state.health.sort((a, b) => a.date.localeCompare(b.date));
  if (state.health.length > 120) state.health = state.health.slice(-120);
  store.set('health', state.health);
}

function importFromURL() {
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return false;
  const rec = { date: todayISO() };
  let found = false;
  KEYS.forEach(key => {
    if (params.has(key)) {
      const v = parseFloat(params.get(key));
      if (!isNaN(v)) { rec[key] = v; found = true; }
    }
  });
  TEXT_KEYS.forEach(key => {
    if (params.has(key) && params.get(key)) { rec[key] = params.get(key); found = true; }
  });
  if (params.has('date')) rec.date = params.get('date');
  if (!found) return false;
  saveHealth(rec);
  history.replaceState({}, '', location.pathname);
  return true;
}

function parseDuration(text, unit) {
  const s = String(text).trim();
  const clock = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const total = clock[3] != null
      ? (+clock[1]) * 3600 + (+clock[2]) * 60 + (+clock[3])
      : (+clock[1]) * 60 + (+clock[2]);
    return unit === 'hours' ? total / 3600 : total / 60;
  }
  let minutes = 0;
  let matched = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*(?:小时|个小时|h\b|hour)/i);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i);
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:秒|sec)/i);
  if (h) { minutes += parseFloat(h[1]) * 60; matched = true; }
  if (m) { minutes += parseFloat(m[1]); matched = true; }
  if (sec) { minutes += parseFloat(sec[1]) / 60; matched = true; }
  if (!matched) return null;
  return unit === 'hours' ? minutes / 60 : minutes;
}

function parseImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const rec = { date: todayISO() };
  let found = false;

  const ACTIVITY_ZERO = ['active', 'exercise', 'stand', 'workout', 'workoutKcal', 'workoutDistance'];
  const take = (key, value) => {
    if (!KEYS.includes(key)) return;
    const text = String(value).trim();
    if (text === '') {
      // 休息日没有活动数据时按 0 记；睡眠/心率/步数/体重不填 0，否则会污染基线
      if (ACTIVITY_ZERO.includes(key)) { rec[key] = 0; found = true; }
      return;
    }
    let num = /^-?\d+(\.\d+)?$/.test(text) ? parseFloat(text) : NaN;
    if (isNaN(num)) {
      const parsed = parseDuration(text, key === 'sleep' ? 'hours' : 'minutes');
      if (parsed != null) {
        num = parsed;
      } else {
        const m = text.match(/-?\d+(\.\d+)?/);
        if (!m) return;
        num = parseFloat(m[0]);
      }
    }
    rec[key] = num;
    found = true;
  };

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      Object.keys(obj).forEach(k => {
        if (k === 'date') { rec.date = obj[k]; return; }
        if (TEXT_KEYS.includes(k)) {
          const s = String(obj[k] || '').trim();
          if (s) { rec[k] = s; found = true; }
          return;
        }
        take(k, obj[k]);
      });
    } catch (e) { return null; }
  } else if (raw.includes('=')) {
    const normalized = raw.replace(/[\s,，]+/g, '&').replace(/^&+|&+$/g, '');
    const params = new URLSearchParams(normalized.replace(/^\?/, ''));
    params.forEach((v, k) => {
      if (k === 'date') { rec.date = v; return; }
      if (TEXT_KEYS.includes(k)) { if (v) { rec[k] = v; found = true; } return; }
      take(k, v);
    });
  }

  return found ? rec : null;
}

function openImportModal(prefill) {
  const modal = document.getElementById('importModal');
  const ta = document.getElementById('importText');
  if (!modal || !ta) return false;
  ta.value = prefill || '';
  updateImportPreview();
  modal.classList.remove('hidden');
  setTimeout(() => ta.focus(), 60);
  return true;
}

function closeImportModal() {
  const modal = document.getElementById('importModal');
  if (modal) modal.classList.add('hidden');
}

function updateImportPreview() {
  const ta = document.getElementById('importText');
  const box = document.getElementById('importPreview');
  if (!ta || !box) return;
  const text = ta.value;
  if (!text.trim()) { box.textContent = ''; return; }
  const rec = parseImportText(text);
  if (!rec) {
    const hasKeys = /[A-Za-z]+\s*=/.test(text);
    box.innerHTML = hasKeys
      ? '<span class="caution">格式对，但所有值都是空的——今天可能没测到/没戴表，先去快捷指令单独跑一项再试</span>'
      : '<span class="stop">没识别到。需要「键=值」格式，例如 rhr=55&hrv=48</span>';
    return;
  }
  const parts = Object.keys(rec)
    .filter(k => k !== 'date')
    .map(k => `${k}=${typeof rec[k] === 'number' ? Math.round(rec[k] * 100) / 100 : rec[k]}`);
  box.innerHTML = '<span class="good">识别到 ' + parts.length + ' 项：</span>' + esc(parts.join(' · '));
}

function bindImportModal() {
  const ta = document.getElementById('importText');
  const ok = document.getElementById('importOk');
  const cancel = document.getElementById('importCancel');
  if (ta) ta.addEventListener('input', updateImportPreview);
  if (cancel) cancel.addEventListener('click', closeImportModal);
  if (ok) ok.addEventListener('click', () => {
    const text = ta ? ta.value : '';
    const rec = parseImportText(text);
    if (!rec) {
      alert('还是没识别到。\n\n需要「键=值」格式，例如：\nrhr=55&hrv=48&steps=8200&active=620&exercise=45&weight=89.4');
      return;
    }
    saveHealth(rec);
    closeImportModal();
    render();
    alert('已导入，共 ' + Object.keys(rec).filter(k => k !== 'date').length + ' 项。');
  });
}

async function pasteImport() {
  let text = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch (e) { /* iOS 拒绝读剪贴板时走弹窗 */ }

  text = (text || '').trim();
  const direct = text ? parseImportText(text) : null;
  if (direct) {
    saveHealth(direct);
    render();
    alert('已导入，共 ' + Object.keys(direct).filter(k => k !== 'date').length + ' 项。');
    return;
  }
  if (!openImportModal(text)) {
    alert('打不开输入框，请刷新页面后再试。');
  }
}

function readinessOf(rec, base) {
  if (!rec) return null;
  let score = 80;
  if (typeof rec.sleep === 'number') {
    if (rec.sleep < 7) score -= Math.round((7 - rec.sleep) * 9);
    if (rec.sleep >= 7.5) score += 6;
  }
  if (typeof rec.rhr === 'number' && base.rhr) {
    const delta = rec.rhr - base.rhr;
    if (delta > 0) score -= Math.round(delta * 3); else score += Math.min(5, Math.round(-delta));
  }
  if (typeof rec.hrv === 'number' && base.hrv) {
    const ratio = rec.hrv / base.hrv;
    if (ratio < 1) score -= Math.round((1 - ratio) * 110); else score += Math.min(8, Math.round((ratio - 1) * 60));
  }
  if (typeof rec.steps === 'number' && rec.steps > 8000) score += 3;
  if (typeof rec.workout === 'number' && rec.workout > 20) score -= 2;
  return Math.min(100, Math.max(15, score));
}

function adviceFor(rec, base, session) {
  const list = [];
  const hour = new Date().getHours();

  if (!rec) {
    return [{
      level: 'info',
      title: '还没有今天的健康数据',
      detail: '点下面的「同步健康数据」，或去「数据」页手动填一次。没有数据也能练，只是恢复评分不准。'
    }];
  }

  if (typeof rec.sleep === 'number') {
    if (rec.sleep < 5.5) list.push({ level: 'stop', title: `睡眠 ${rec.sleep.toFixed(1)} 小时：今天不该上强度`, detail: '只做活动度或完全休息。把强度课推到明天，比硬练一次划算。' });
    else if (rec.sleep < 6.5) list.push({ level: 'caution', title: `睡眠不足（${rec.sleep.toFixed(1)}h）`, detail: '砍掉 C 部分的代谢/间歇，只做 A 主项和 B 辅助。今天不追任何成绩。' });
  }

  if (typeof rec.rhr === 'number' && base.rhr) {
    const delta = Math.round(rec.rhr - base.rhr);
    if (delta >= 8) list.push({ level: 'caution', title: `静息心率比基线高 ${delta} 次/分`, detail: '恢复不足的信号。加一天完全休息，或把今天改成 30 分钟 Zone2。' });
    else if (delta <= -3) list.push({ level: 'good', title: `静息心率比基线低 ${-delta} 次/分`, detail: '恢复得不错，可以按计划上强度。' });
  }

  if (typeof rec.hrv === 'number' && base.hrv) {
    const ratio = rec.hrv / base.hrv;
    if (ratio < 0.8) list.push({ level: 'caution', title: `HRV 比基线低 ${Math.round((1 - ratio) * 100)}%`, detail: '主项降 20% 重量；WOD 只求完成，不追时间。' });
  }

  if (typeof rec.steps === 'number' && rec.steps < 6000 && hour >= 18) {
    list.push({ level: 'info', title: `今天还差约 ${Math.round(8000 - rec.steps)} 步`, detail: '晚饭后走 20 分钟就够。步数对减脂的贡献比多练一节 WOD 更稳。' });
  }

  if (session) {
    const trainMinutes = typeof rec.workout === 'number'
      ? rec.workout
      : (typeof rec.exercise === 'number' ? rec.exercise : null);
    if (trainMinutes != null && trainMinutes >= 20) {
      const wtype = rec.workoutType ? ` · ${rec.workoutType}` : '';
      list.push({ level: 'good', title: `检测到今天的训练：${Math.round(trainMinutes)} 分钟${wtype}`, detail: '如果还没打勾，记得标记完成，周统计才准。' });
    } else if (hour >= 20) {
      list.push({ level: 'info', title: '今天还没检测到训练记录', detail: '练了的话，在手表上开一次训练（任意类型），数据才会进 HealthKit。' });
    }
  }

  if (!list.length) {
    list.push({ level: 'good', title: '按计划走', detail: '没有异常信号。训练前把重量再看一遍，RPE 超过 8 就降 2.5kg。' });
  }
  return list;
}

/* ---------- render ---------- */

const TITLES = { today: '今天', plan: '计划', meals: '餐食', data: '数据', settings: '设置' };

function setHeader() {
  const w = currentWeek();
  const label = state.tab === 'today'
    ? `第 ${weekNumber()} 周 · ${w ? w.phase : ''}`
    : `第 ${weekNumber()} 周 / 共 12 周`;
  $('#kicker').textContent = label;
  $('#pagetitle').textContent = TITLES[state.tab];
  $('#dateline').textContent = cnDate();
}

function ring(score) {
  const color = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--orange)' : 'var(--red)';
  const r = 36;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - score / 100);
  return `<div class="ring">
    <svg width="88" height="88" viewBox="0 0 88 88">
      <circle cx="44" cy="44" r="${r}" fill="none" stroke="var(--card2)" stroke-width="8"/>
      <circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
    </svg>
    <div class="center"><div class="score" style="color:${color}">${score}</div><div class="label">恢复</div></div>
  </div>`;
}

function sessionDone(session) {
  return !!state.checkins[`w${weekNumber()}d${session.day}`];
}

function todayMode() {
  const iso = todayISO();
  if (state.mode[iso]) return state.mode[iso];
  return todaySession() ? 'train' : 'rest';
}

function setMode(mode) {
  const iso = todayISO();
  state.mode[iso] = mode;
  store.set('mode', state.mode);
  const session = todaySession();
  if (session) {
    const key = `w${weekNumber()}d${session.day}`;
    if (mode === 'rest') {
      state.skips[key] = true;
      delete state.checkins[key];
    } else {
      delete state.skips[key];
    }
    store.set('skips', state.skips);
    store.set('checkins', state.checkins);
  }
  render();
}

function menuForToday() {
  if (!MENU) return null;
  const day = todayMenu();
  if (!day) return null;
  if (todayMode() === 'rest' && day.restMeals && day.restMeals.length) {
    return {
      ...day,
      label: day.restLabel || day.label,
      meals: day.restMeals,
      totals: day.restTotals,
      targetKcal: Math.round(day.restTotals.kcal),
      isRest: true
    };
  }
  return day;
}

function sessionSkipped(session) {
  return !!state.skips[`w${weekNumber()}d${session.day}`];
}

function formatSeconds(total) {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

function weekInfo(week) {
  const start = parseISO(state.startDate || todayISO());
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (week - 1) * 7);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
  return { from, to, fromISO: todayISO(from), toISO: todayISO(to) };
}

function weeklyReview(week) {
  const info = weekInfo(week);
  const plan = PLAN ? PLAN.weeks.find(w => w.week === week) : null;
  const days = plan ? plan.days : [];
  const done = days.filter(d => state.checkins[`w${week}d${d.day}`]).length;
  const skipped = days.filter(d => state.skips[`w${week}d${d.day}`]).length;
  const hs = state.health.filter(h => h.date >= info.fromISO && h.date <= info.toISO);
  const results = state.results.filter(r => r.date >= info.fromISO && r.date <= info.toISO);

  const nums = key => hs.map(h => h[key]).filter(v => typeof v === 'number');
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const sleeps = nums('sleep');
  const rhrs = nums('rhr');
  const hrvs = nums('hrv');
  const steps = nums('steps');
  const weights = hs.filter(h => typeof h.weight === 'number').map(h => h.weight);
  const base = baseline();

  const rows = [];
  const extras = Object.keys(state.extraDone).filter(d => d >= info.fromISO && d <= info.toISO && state.extraDone[d]).length;
  rows.push(['完成', (days.length ? `${done} / ${days.length} 次${skipped ? `（跳过 ${skipped}）` : ''}` : '—') + (extras ? ` · 加练 ${extras}` : '')]);
  rows.push(['WOD 成绩', results.length ? `${results.length} 条` : '未记录']);
  rows.push(['睡眠', sleeps.length ? `均值 ${avg(sleeps).toFixed(1)}h · 最低 ${Math.min(...sleeps).toFixed(1)}h` : '—']);
  rows.push(['静息心率', rhrs.length ? `均值 ${Math.round(avg(rhrs))}${base.rhr ? ` · 基线 ${Math.round(base.rhr)}` : ''}` : '—']);
  rows.push(['HRV', hrvs.length ? `均值 ${Math.round(avg(hrvs))}${base.hrv ? ` · 基线 ${Math.round(base.hrv)}` : ''}` : '—']);
  rows.push(['步数', steps.length ? `均值 ${Math.round(avg(steps))}` : '—']);
  const sportDays = hs.filter(h => typeof h.workout === 'number' && h.workout > 0);
  const sportMinutes = sportDays.reduce((a, h) => a + h.workout, 0);
  const sportKcal = hs.filter(h => typeof h.active === 'number').reduce((a, h) => a + h.active, 0);
  rows.push(['运动', sportDays.length
    ? `${sportDays.length} 天 · ${Math.round(sportMinutes)} 分钟${sportKcal ? ` · ${Math.round(sportKcal)} kcal` : ''}`
    : '—']);
  rows.push(['体重', weights.length >= 2 ? `${weights[0].toFixed(1)} → ${weights[weights.length - 1].toFixed(1)} kg（${(weights[weights.length - 1] - weights[0]).toFixed(1)}）` : '—']);

  const notes = [];
  if (days.length && done < days.length / 2) {
    notes.push('完成率不到一半。先把训练日固定成周几，别靠当天早上决定。');
  }
  if (skipped >= 2) {
    notes.push('本周跳过 2 次以上：不是意志力问题，是排太满。下周先按每周 3 天走，稳了再加回来。');
  }
  if (sleeps.length && Math.min(...sleeps) < 6.5) {
    notes.push(`有一晚只睡 ${Math.min(...sleeps).toFixed(1)}h。那天本来应该砍掉代谢训练，睡眠不足时练强度是负收益。`);
  }
  const rhrDelta = (rhrs.length && base.rhr) ? avg(rhrs) - base.rhr : null;
  if (rhrDelta !== null && rhrDelta >= 5) {
    notes.push('静息心率整周偏高，下周安排一个减量周（容量砍 40%）。');
  }
  const stepAvg = steps.length ? avg(steps) : null;
  if (stepAvg !== null && stepAvg < 7000) {
    notes.push('步数偏低。减脂主要靠它，每天补 2000 步比多练一节 WOD 有用。');
  }
  if (weights.length >= 2) {
    const delta = weights[weights.length - 1] - weights[0];
    if (delta <= -0.3) notes.push(`体重降了 ${Math.abs(delta).toFixed(1)}kg，节奏正常，保持。`);
    else if (delta >= 0.3) notes.push('体重回升，先查饮食记录和外食次数，别急着加训练量。');
  }
  if (results.length >= 2) {
    notes.push('成绩有记录。下周用同一个降阶重测，才看得出是真进步还是熟练度。');
  }
  if (!notes.length) notes.push('这周数据没异常，继续保持。');

  return { rows, notes, done, skipped, planned: days.length, results };
}

function reviewCard(week) {
  const r = weeklyReview(week);
  const current = state.reviewWeek || week;
  let html = `<div class="card"><h2>第 ${week} 周复盘</h2>
    <div class="seg" style="margin-bottom:12px">
      <button class="${current === week - 1 ? 'on' : ''}" data-action="review-prev">上周</button>
      <button class="${current === week ? 'on' : ''}" data-action="review-this">本周</button>
    </div>`;
  r.rows.forEach(([k, v]) => {
    html += `<div class="row between small" style="padding:5px 0;border-bottom:1px solid var(--line)">
      <span class="muted">${k}</span><span style="font-weight:600">${esc(v)}</span></div>`;
  });
  html += `<div style="margin-top:12px">`;
  r.notes.forEach(n => { html += `<div class="small muted" style="margin:6px 0">· ${esc(n)}</div>`; });
  html += `</div></div>`;
  return html;
}

function wodBlock(session) {
  const mine = state.results.filter(r => r.date === todayISO());
  let html = `<div class="hr"></div><h2>WOD 成绩</h2>`;
  if (mine.length) {
    mine.forEach(r => {
      const value = r.kind === 'time' ? formatSeconds(r.seconds) : `${r.rounds} 轮 ${r.reps} 次`;
      html += `<div class="row between small" style="padding:6px 0">
        <span style="font-weight:600">${value}${r.rpe ? ` · RPE ${r.rpe}` : ''}</span>
        <button class="link" data-action="del-result" data-id="${r.id}">删除</button></div>
        ${r.note ? `<div class="tiny muted">${esc(r.note)}</div>` : ''}`;
    });
    return html + `</div>`;
  }
  html += `<form id="wodForm">
    <label class="field"><span>类型</span>
      <select name="kind" id="wodKind">
        <option value="time">计时（For Time / RFT）</option>
        <option value="rounds">AMRAP（轮数）</option>
      </select>
    </label>
    <div id="wodTime">
      <label class="field"><span>用时</span>
        <div class="row" style="gap:8px">
          <input type="number" name="min" placeholder="分" inputmode="numeric">
          <input type="number" name="sec" placeholder="秒" inputmode="numeric">
        </div>
      </label>
    </div>
    <div id="wodRounds" class="hidden">
      <label class="field"><span>完成轮数 / 额外次数</span>
        <div class="row" style="gap:8px">
          <input type="number" name="rounds" placeholder="轮" inputmode="numeric">
          <input type="number" name="reps" placeholder="次" inputmode="numeric">
        </div>
      </label>
    </div>
    <label class="field"><span>RPE（6–10）</span>
      <input type="number" name="rpe" min="6" max="10" value="8" inputmode="numeric"></label>
    <label class="field"><span>备注（降阶方式、感受）</span>
      <input type="text" name="note" placeholder="例：哑铃 2×15kg，最后一轮拆 4-3-3"></label>
    <button class="primary" type="submit">保存成绩</button>
  </form></div>`;
  return html;
}

const REST_TEMPLATES = [
  {
    id: 'full',
    name: '轻量全身 · 25 分钟',
    desc: '不碰大重量，保持血流量，不影响明天',
    blocks: [
      { label: 'A · 力量（轻）', items: ['高脚杯深蹲 3×10 @20kg', '哑铃卧推 3×10 @2×15kg', '单臂哑铃划船 3×10/侧 @15kg'] },
      { label: 'B · 短代谢', items: ['8min AMRAP：10 壶铃摆 16kg / 10 波比 / 200m 跑步机'] },
      { label: 'C · 收尾', items: ['髋 / 肩拉伸 5 分钟'] }
    ]
  },
  {
    id: 'zone2',
    name: '有氧 + 核心 · 40 分钟',
    desc: '最不影响恢复的加练，心率 120–135',
    blocks: [
      { label: 'A · Zone2', items: ['35min 单车或坡度走，全程能完整说话'] },
      { label: 'B · 核心', items: ['平板 3×40s', '侧板 3×30s/侧', '死虫 3×10/侧'] }
    ]
  },
  {
    id: 'skill',
    name: '技术课 · 30 分钟',
    desc: '只练动作不追重量：抓举 / 倒立撑 / 双摇',
    blocks: [
      { label: 'A · 奥举技术', items: ['空杆抓举 3×5', '高抓 5×2 @50%', '过顶深蹲 3×5（轻）'] },
      { label: 'B · 体操', items: ['箱上倒立撑 4×5', '双摇 4×30', '悬垂 3×20s'] }
    ]
  }
];

function extraOptions() {
  const week = PLAN ? PLAN.weeks.find(w => w.week === weekNumber()) : null;
  if (!week) return REST_TEMPLATES.map(t => ({ id: 'tpl-' + t.id, name: t.name, note: t.desc, template: t }));
  const today = weekdayIndex();
  const past = [];
  const future = [];
  week.days.forEach(s => {
    if (s.weekdayIndex === today) return;
    if (state.checkins[`w${weekNumber()}d${s.day}`]) return;
    const diff = s.weekdayIndex - today;
    const item = {
      id: 'day-' + s.day,
      name: (diff < 0 ? '补练' : '提前上') + ' Day ' + s.day,
      note: s.weekday + '的课 · ' + s.title,
      session: s
    };
    if (diff < 0) past.push(item); else future.push(item);
  });
  const templates = REST_TEMPLATES.map(t => ({ id: 'tpl-' + t.id, name: t.name, note: t.desc, template: t }));
  return past.concat(future, templates);
}

function extraCard() {
  const opts = extraOptions();
  const iso = todayISO();
  const picked = state.extraPick[iso];
  const current = opts.find(o => o.id === picked) || opts[0];
  let html = `<div class="card"><h2>今天加练 · 自选</h2>
    <div class="small muted">今天不在课表里。挑一个，别上大重量——明天还有课。</div>
    <div style="margin-top:12px;display:grid;gap:8px">`;
  opts.forEach(o => {
    html += `<button class="ghost pick ${current && current.id === o.id ? 'on' : ''}" data-action="pick-extra" data-id="${o.id}">
      <span style="font-weight:600">${esc(o.name)}</span><br><span class="tiny muted">${esc(o.note)}</span></button>`;
  });
  html += `</div>`;

  if (current) {
    const blocks = current.session ? current.session.blocks : current.template.blocks;
    blocks.forEach(b => {
      html += `<div class="block"><div class="lbl">${esc(b.label)}</div><ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
    });
    const planKey = current.id.startsWith('day-') ? `w${weekNumber()}d${current.id.split('-')[1]}` : null;
    const done = planKey ? !!state.checkins[planKey] : !!state.extraDone[iso];
    html += `<div style="margin-top:14px"><button class="primary ${done ? 'done' : ''}" data-action="toggle-extra" data-id="${current.id}">
      ${done ? '已完成 ✓' : '标记完成'}</button></div>`;
  }
  return html + `</div>`;
}

function renderToday() {
  if (state.startDate && todayISO() < state.startDate) {
    const days = Math.round((parseISO(state.startDate) - parseISO(todayISO())) / 86400000);
    $('#tab-today').innerHTML = `<div class="card"><h2>还没开始</h2>
      <div style="font-weight:700;font-size:17px">计划从 ${state.startDate} 开始</div>
      <div class="small muted" style="margin-top:6px">还有 ${days} 天。这几天可以先把日历导好、把「同步健康数据」快捷指令调通。</div>
      <div style="margin-top:12px"><button class="ghost" data-action="go-plan">先看看 12 周计划</button></div></div>`;
    return;
  }
  const rec = todayHealth();
  const base = baseline();
  const score = readinessOf(rec, base);
  const session = todaySession();
  const mode = todayMode();
  const menu = menuForToday();
  const advice = adviceFor(rec, base, mode === 'train' ? session : null);

  let html = '';

  if (score !== null) {
    html += `<div class="card readiness">${ring(score)}
      <div class="grow">
        <div style="font-weight:700">${score >= 80 ? '可以按计划上强度' : score >= 60 ? '降一档练，别追成绩' : '今天以恢复为主'}</div>
        <div class="small muted" style="margin-top:4px">睡眠 ${fmt(rec.sleep)}h · 静息心率 ${fmt(rec.rhr, 0)} · HRV ${fmt(rec.hrv, 0)}</div>
      </div></div>`;
  }

  advice.forEach(a => {
    html += `<div class="advice"><div class="dot ${a.level}" style="background:currentColor"></div>
      <div class="grow"><div class="t ${a.level}">${esc(a.title)}</div><div class="d">${esc(a.detail)}</div></div></div>`;
  });

  html += `<div class="card"><h2>今天怎么安排</h2>
    <div class="seg">
      <button class="${mode === 'train' ? 'on' : ''}" data-action="mode-train">今天练</button>
      <button class="${mode === 'rest' ? 'on' : ''}" data-action="mode-rest">今天不练</button>
    </div>
    <div class="tiny muted" style="margin-top:10px">${mode === 'rest'
      ? '已切到休息：训练记为跳过，餐食换成休息版（少 290 kcal，蛋白不变）。'
      : (session ? '按计划训练，餐食为训练版。' : '今天没有排课，属于自选训练日。')}</div>
  </div>`;

  if (session && mode === 'train') {
    const done = sessionDone(session);
    html += `<div class="card"><h2>今天的训练 · ${session.duration} 分钟</h2>
      <div style="font-weight:700;font-size:17px">${esc(session.title)}</div>`;
    session.blocks.forEach(b => {
      html += `<div class="block"><div class="lbl">${esc(b.label)}</div><ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
    });
    if (session.notes) html += `<div class="small muted" style="margin-top:10px">${esc(session.notes)}</div>`;
    html += `<div style="margin-top:14px"><button class="primary ${done ? 'done' : ''}" data-action="toggle-session">
      ${done ? '已完成 ✓' : '标记完成'}</button></div>`;
    html += wodBlock(session);
    html += `</div>`;
  } else if (session) {
    html += `<div class="card"><h2>今天不练</h2>
      <div class="small muted">这次课记为「跳过」，不算完成。偶尔跳一次不影响进度；连着跳两次就要改计划——宁可把每周 4 天降到 3 天。</div>
      <div class="block"><div class="lbl">原计划（可改天补）</div><ul>${session.blocks[0].items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>
      <div class="tiny muted" style="margin-top:10px">餐食已切到休息版；日历里那条 7:20 的提醒照常响，它只是提示你今天干什么。</div>
      </div>`;
  } else if (mode === 'train') {
    html += extraCard();
  } else {
    html += `<div class="card"><h2>今天休息</h2>
      <div class="small muted">完全休息，或者 20–30 分钟轻松走（心率 110–120）。周六的长有氧课不要省。</div>
      <div style="margin-top:12px"><button class="ghost" data-action="go-plan">看本周 4 次训练</button></div></div>`;
  }

  if (menu) {
    const next = nextMeal(menu);
    const doneCount = menu.meals.filter(m => state.meals[`${todayISO()}-${m.slot}`]).length;
    html += `<div class="card"><h2>餐食 · ${doneCount}/${menu.meals.length}${menu.isRest ? ' · 休息版' : ''}</h2>`;
    if (next) {
      html += `<div class="row between"><div style="font-weight:600">${esc(next.slot)} · ${next.time}</div>
        <div class="tiny muted">${Math.round(next.kcal)} kcal</div></div>
        <div class="small muted" style="margin-top:4px">${esc(next.summary)}</div>`;
    }
    html += `<div class="small muted" style="margin-top:8px">全天 ${Math.round(menu.totals.kcal)} kcal · 蛋白 ${Math.round(menu.totals.protein)}g</div>
      <div style="margin-top:12px"><button class="ghost" data-action="go-meals">查看全部 ${menu.meals.length} 餐</button></div></div>`;
  }

  html += `<div class="card"><h2>健康数据</h2>
    <div class="small muted">${rec ? `最后同步：${rec.date}` : '今天还没有数据'}</div>
    <div style="margin-top:10px;display:grid;gap:8px">
      <button class="primary" data-action="sync">同步健康数据</button>
      <button class="ghost" data-action="paste-import">从剪贴板导入</button>
      <button class="ghost" data-action="go-data">手动填一次</button>
    </div></div>`;

  $('#tab-today').innerHTML = html;
}

function nextMeal(menu) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  return menu.meals.find(m => {
    const [h, mi] = m.time.split(':').map(Number);
    return h * 60 + mi >= mins;
  }) || menu.meals[menu.meals.length - 1];
}

function renderMeals() {
  const menu = menuForToday();
  if (!menu) { $('#tab-meals').innerHTML = '<div class="card">今天没有配餐数据</div>'; return; }

  const t = menu.totals;
  const target = MENU.targets;
  const mode = todayMode();

  let html = `<div class="card"><h2>${esc(menu.label)}</h2>
    <div class="seg" style="margin-bottom:12px">
      <button class="${mode === 'train' ? 'on' : ''}" data-action="mode-train">训练日</button>
      <button class="${mode === 'rest' ? 'on' : ''}" data-action="mode-rest">休息日</button>
    </div>
    <div style="font-weight:700">全天 ${Math.round(t.kcal)} kcal <span class="small muted">/ 目标 ${menu.targetKcal}</span></div>
    ${macroBar('蛋白', t.protein, target.protein, 'g')}
    ${macroBar('碳水', t.carbs, target.carbs, 'g')}
    ${macroBar('脂肪', t.fat, target.fat, 'g')}
    <div class="tiny muted" style="margin-top:10px">${menu.isRest
      ? '休息版：去掉训练前/后的两餐，碳水降约 60g，蛋白保持。'
      : '训练版：碳水集中在训练前后。'}</div></div>`;

  menu.meals.forEach(m => {
    const key = `${todayISO()}-${m.slot}`;
    const done = !!state.meals[key];
    html += `<div class="card"><div class="meal">
      <div class="head"><div><span class="slot">${esc(m.slot)}</span> <span class="time">${m.time}</span></div>
      <div class="box-check ${done ? 'on' : ''}" data-action="toggle-meal" data-slot="${esc(m.slot)}">${done ? '✓' : ''}</div></div>
      <div class="items">${m.items.map(i => `${esc(i.name)} ${i.grams}g`).join(' · ')}</div>
      <div class="macros">${Math.round(m.kcal)} kcal · 蛋白 ${Math.round(m.protein)}g · 碳水 ${Math.round(m.carbs)}g · 脂肪 ${Math.round(m.fat)}g</div>
    </div></div>`;
  });

  $('#tab-meals').innerHTML = html;
}

function macroBar(label, value, target, unit) {
  const pct = Math.min(100, (value / target) * 100);
  return `<div style="margin-top:10px">
    <div class="row between small"><span class="muted">${label}</span><span class="muted">${Math.round(value)} / ${Math.round(target)}${unit}</span></div>
    <div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div></div>`;
}

function renderPlan() {
  const wk = weekNumber();
  let html = '';
  PLAN.weeks.forEach(w => {
    html += `<details class="week"><summary><div class="week-row">
      <div class="w">W${w.week}</div>
      <div class="grow"><div class="p">${esc(w.phase)}</div><div class="f">${esc(w.focus)}</div></div>
      ${w.week === wk ? '<span class="badge">本周</span>' : ''}
    </div></summary>`;
    w.days.forEach(d => {
      html += `<div class="session">
        <div class="row between"><div style="font-weight:600">Day ${d.day} · ${esc(d.weekday)}</div>
        <div class="tiny muted">${d.duration}′</div></div>
        <div style="font-size:14px;margin:2px 0 6px">${esc(d.title)}</div>`;
      d.blocks.forEach(b => {
        html += `<div class="block"><div class="lbl">${esc(b.label)}</div><ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
      });
      if (d.notes) html += `<div class="tiny muted" style="margin-top:6px">${esc(d.notes)}</div>`;
      html += `</div>`;
    });
    html += `</details>`;
  });
  $('#tab-plan').innerHTML = `<div class="card">${html}</div>`;
}


/* ---------------- charts ---------------- */
const CW = 320, CH = 150, CL = 34, CR = 8, CT = 12, CB = 22;

function shortNum(v) {
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 10) return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 100) / 100).toString();
}

function chartX(i, n) {
  return CL + (n <= 1 ? 0 : (i / (n - 1)) * (CW - CL - CR));
}
function chartY(v, min, max) {
  const span = (max - min) || 1;
  return CH - CB - ((v - min) / span) * (CH - CT - CB);
}

function svgLine(series, opts) {
  opts = opts || {};
  const n = opts.count || 1;
  const all = [];
  series.forEach(s => s.points.forEach(p => all.push(p.v)));
  if (!all.length) return '';
  let min = Math.min.apply(null, all);
  let max = Math.max.apply(null, all);
  if (opts.floor != null) min = Math.min(min, opts.floor);
  const pad = (max - min) * 0.15 || 1;
  min -= pad; max += pad;

  let svg = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" class="chart">';
  for (let g = 0; g <= 2; g++) {
    const v = min + (max - min) * (g / 2);
    const y = chartY(v, min, max);
    svg += '<line x1="' + CL + '" y1="' + y.toFixed(1) + '" x2="' + (CW - CR) + '" y2="' + y.toFixed(1) + '" class="grid"/>';
    svg += '<text x="' + (CL - 5) + '" y="' + (y + 3).toFixed(1) + '" class="axis" text-anchor="end">' + shortNum(v) + '</text>';
  }
  if (opts.target != null) {
    const y = chartY(opts.target, min, max);
    svg += '<line x1="' + CL + '" y1="' + y.toFixed(1) + '" x2="' + (CW - CR) + '" y2="' + y.toFixed(1) + '" class="target"/>';
  }
  series.forEach(s => {
    let d = '', prev = null;
    s.points.forEach(p => {
      const cmd = (prev !== null && p.i - prev === 1) ? 'L' : 'M';
      d += cmd + chartX(p.i, n).toFixed(1) + ',' + chartY(p.v, min, max).toFixed(1) + ' ';
      prev = p.i;
    });
    svg += '<path d="' + d.trim() + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 2) + '"' +
      (s.dash ? ' stroke-dasharray="4 3"' : '') + ' stroke-linecap="round" stroke-linejoin="round"/>';
    if (s.dots) {
      s.points.forEach(p => {
        svg += '<circle cx="' + chartX(p.i, n).toFixed(1) + '" cy="' + chartY(p.v, min, max).toFixed(1) + '" r="2.2" fill="' + s.color + '"/>';
      });
    }
  });
  (opts.labels || []).forEach(l => {
    svg += '<text x="' + chartX(l.i, n).toFixed(1) + '" y="' + (CH - 6) + '" class="axis" text-anchor="middle">' + l.text + '</text>';
  });
  return svg + '</svg>';
}

function svgBars(items, opts) {
  opts = opts || {};
  const n = items.length || 1;
  const max = Math.max.apply(null, items.map(i => i.value).concat([1]));
  const step = (CW - CL - CR) / n;
  const bw = Math.min(20, step * 0.55);
  let svg = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" class="chart">';
  for (let g = 0; g <= 2; g++) {
    const v = max * (g / 2);
    const y = CH - CB - (g / 2) * (CH - CT - CB);
    svg += '<line x1="' + CL + '" y1="' + y.toFixed(1) + '" x2="' + (CW - CR) + '" y2="' + y.toFixed(1) + '" class="grid"/>';
    svg += '<text x="' + (CL - 5) + '" y="' + (y + 3).toFixed(1) + '" class="axis" text-anchor="end">' + shortNum(v) + '</text>';
  }
  items.forEach((it, idx) => {
    const x = CL + step * idx + (step - bw) / 2;
    const h = Math.max(1, (it.value / max) * (CH - CT - CB));
    const y = CH - CB - h;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" fill="' + (it.color || 'var(--accent)') + '"/>';
    if (it.extra) {
      const eh = Math.max(1, (it.extra / max) * (CH - CT - CB));
      const ey = y - eh - 1;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + ey.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + eh.toFixed(1) + '" rx="3" fill="var(--muted)" opacity=".45"/>';
    }
    svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (CH - 6) + '" class="axis" text-anchor="middle">' + it.label + '</text>';
  });
  return svg + '</svg>';
}

function sparkSVG(points, color) {
  if (!points.length) return '';
  const w = 78, h = 26, p = 3;
  const vals = points.map(p => p.v);
  let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (max - min < 0.001) { max = min + 1; }
  const x = i => p + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (w - p * 2));
  const y = v => h - p - ((v - min) / (max - min)) * (h - p * 2);
  let d = '';
  points.forEach((pt, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(pt.v).toFixed(1) + ' '; });
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark"><path d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function chartCard(title, note, svg, emptyText) {
  return '<div class="card"><h2>' + title + '</h2>' +
    (svg ? svg : '<div class="small muted">' + (emptyText || '还没有数据') + '</div>') +
    (note ? '<div class="tiny muted" style="margin-top:6px">' + note + '</div>' : '') + '</div>';
}

function healthSeries(key) {
  return state.health
    .filter(h => typeof h[key] === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));
}

function twoLabels(list) {
  if (!list.length) return [];
  if (list.length === 1) return [{ i: 0, text: list[0].date.slice(5) }];
  return [{ i: 0, text: list[0].date.slice(5) }, { i: list.length - 1, text: list[list.length - 1].date.slice(5) }];
}

function weightChart() {
  const recs = healthSeries('weight');
  if (recs.length < 2) return chartCard('体重', '', '', '每天记录一次体重，攒够 2 天就有曲线');
  const pts = recs.map((h, i) => ({ i, v: h.weight }));
  const avg = recs.map((h, i) => {
    const end = parseISO(h.date);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
    const win = recs.filter(r => { const d = parseISO(r.date); return d >= start && d <= end; });
    return { i, v: win.reduce((a, r) => a + r.weight, 0) / win.length };
  });
  const svg = svgLine([
    { points: pts, color: 'var(--muted)', width: 1.4, dots: true },
    { points: avg, color: 'var(--accent)', width: 2.4 }
  ], { count: recs.length, labels: twoLabels(recs), target: 83, floor: 80 });
  const delta = recs[recs.length - 1].weight - recs[0].weight;
  return chartCard('体重', '细线＝每日 · 粗线＝7 日均线 · 虚线＝目标 83kg', svg,
    '') + '';
}

function readinessChart() {
  const recs = state.health
    .filter(h => h.sleep != null || h.rhr != null || h.hrv != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (recs.length < 2) return chartCard('恢复评分', '', '', '至少 3 天数据才有意义');
  const pts = recs.map((h, i) => {
    const prior = recs.slice(0, i).slice(-14);
    const avg = k => {
      const v = prior.map(x => x[k]).filter(x => typeof x === 'number');
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    return { i, v: readinessOf(h, { rhr: avg('rhr'), hrv: avg('hrv') }) };
  });
  const svg = svgLine([{ points: pts, color: 'var(--accent)', width: 2.2, dots: true }],
    { count: recs.length, labels: twoLabels(recs) });
  return chartCard('恢复评分', '60 以下就该降强度，80 以上可以按计划上', svg);
}

function sleepChart() {
  const recs = healthSeries('sleep');
  if (recs.length < 2) return chartCard('睡眠', '', '', '导入几天数据后出现');
  const items = recs.map(h => ({ label: h.date.slice(5), value: h.sleep, color: 'var(--indigo, #6366f1)' }));
  const avg = recs.reduce((a, h) => a + h.sleep, 0) / recs.length;
  return chartCard('睡眠', '均值 ' + avg.toFixed(1) + ' 小时 · 目标 7.5', svgBars(items));
}

function weeklyVolumeChart() {
  const cur = weekNumber();
  const items = [];
  for (let w = 1; w <= cur; w++) {
    const info = weekInfo(w);
    const plan = PLAN.weeks.find(x => x.week === w);
    let done = 0;
    (plan ? plan.days : []).forEach(d => { if (state.checkins['w' + w + 'd' + d.day]) done++; });
    const extra = Object.keys(state.extraDone)
      .filter(d => state.extraDone[d] && d >= info.fromISO && d <= info.toISO).length;
    items.push({ label: 'W' + w, value: done, extra, color: 'var(--accent)' });
  }
  return chartCard('每周训练量', '实心＝完成 · 浅色＝加练', svgBars(items));
}

function waistChart() {
  const recs = healthSeries('waist');
  if (recs.length < 2) return '';
  const pts = recs.map((h, i) => ({ i, v: h.waist }));
  const svg = svgLine([{ points: pts, color: 'var(--blue)', width: 2.2, dots: true }],
    { count: recs.length, labels: twoLabels(recs) });
  return chartCard('腰围', '起点 ' + recs[0].waist + 'cm → 现在 ' + recs[recs.length - 1].waist + 'cm', svg);
}

function bodyfatChart() {
  const recs = healthSeries('bodyfat');
  if (recs.length < 2) return '';
  const pts = recs.map((h, i) => ({ i, v: h.bodyfat }));
  const svg = svgLine([{ points: pts, color: 'var(--purple, #a855f7)', width: 2.2, dots: true }],
    { count: recs.length, labels: twoLabels(recs) });
  return chartCard('体脂', '起点 ' + recs[0].bodyfat + '% → 现在 ' + recs[recs.length - 1].bodyfat + '%', svg);
}

function liftCard() {
  const dates = Object.keys(state.lifts).sort();
  if (!dates.length) {
    return chartCard('力量 1RM', '', '', '还没有记录。测一次 1RM 记下来，第 6 周复测就能连成线');
  }
  const defs = [
    ['squat', '深蹲', 'var(--accent)'],
    ['deadlift', '硬拉', 'var(--blue)'],
    ['snatch', '抓举', 'var(--green)'],
    ['cj', '挺举', 'var(--purple, #a855f7)']
  ];
  let rows = '';
  defs.forEach(d => {
    const pts = [];
    dates.forEach((dt, i) => {
      const v = state.lifts[dt] && state.lifts[dt][d[0]];
      if (typeof v === 'number') pts.push({ i, v });
    });
    if (!pts.length) return;
    const first = pts[0].v;
    const last = pts[pts.length - 1].v;
    const diff = last - first;
    rows += '<div class="lift-row"><div class="lift-name">' + d[1] + '</div>' +
      '<div class="lift-val">' + last + ' kg<span class="tiny muted"> ' + (diff >= 0 ? '+' : '') + diff + '</span></div>' +
      sparkSVG(pts, d[2]) + '</div>';
  });
  return '<div class="card"><h2>力量 1RM</h2>' + rows +
    '<div class="tiny muted" style="margin-top:8px">灰色数字是相对第一次记录的变化</div></div>';
}

function bodyFormCard(rec) {
  const t = rec || {};
  return '<div class="card"><h2>记录身体数据</h2><form id="bodyForm">' +
    '<label class="field"><span>日期</span><input type="date" name="date" value="' + todayISO() + '"></label>' +
    '<label class="field"><span>体重（kg）</span><input type="number" step="0.1" name="weight" inputmode="decimal"></label>' +
    '<label class="field"><span>腰围（cm）</span><input type="number" step="0.5" name="waist" inputmode="decimal"></label>' +
    '<label class="field"><span>体脂（%）</span><input type="number" step="0.1" name="bodyfat" inputmode="decimal"></label>' +
    '<button class="primary" type="submit">保存</button></form></div>';
}

function liftFormCard() {
  return '<div class="card"><h2>记录 1RM</h2><form id="liftForm">' +
    '<label class="field"><span>日期</span><input type="date" name="date" value="' + todayISO() + '"></label>' +
    '<label class="field"><span>深蹲（kg）</span><input type="number" step="2.5" name="squat" inputmode="decimal"></label>' +
    '<label class="field"><span>硬拉（kg）</span><input type="number" step="2.5" name="deadlift" inputmode="decimal"></label>' +
    '<label class="field"><span>抓举（kg）</span><input type="number" step="2.5" name="snatch" inputmode="decimal"></label>' +
    '<label class="field"><span>挺举（kg）</span><input type="number" step="2.5" name="cj" inputmode="decimal"></label>' +
    '<button class="primary" type="submit">保存</button></form></div>';
}


/* ---------------- monthly review ---------------- */
function monthRange(offset) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    fromISO: todayISO(d),
    toISO: todayISO(end),
    label: (d.getMonth() + 1) + ' 月',
    year: d.getFullYear(),
    days: end.getDate()
  };
}

function sessionDate(week, s) {
  const start = parseISO(state.startDate || todayISO());
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (week - 1) * 7 + (s.weekdayIndex - 1));
  return todayISO(d);
}

function monthStats(offset) {
  const r = monthRange(offset);
  const inRange = d => d >= r.fromISO && d <= r.toISO;

  let planned = 0, done = 0, skipped = 0;
  PLAN.weeks.forEach(w => w.days.forEach(s => {
    const d = sessionDate(w.week, s);
    if (!inRange(d)) return;
    planned++;
    if (state.checkins['w' + w.week + 'd' + s.day]) done++;
    else if (state.skips['w' + w.week + 'd' + s.day]) skipped++;
  }));

  const extras = Object.keys(state.extraDone).filter(d => state.extraDone[d] && inRange(d)).length;
  const hs = state.health.filter(h => inRange(h.date));
  const num = k => hs.map(h => h[k]).filter(v => typeof v === 'number');
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  const sleeps = num('sleep');
  const rhrs = num('rhr');
  const hrvs = num('hrv');
  const steps = num('steps');
  const weights = hs.filter(h => typeof h.weight === 'number').sort((a, b) => a.date.localeCompare(b.date));
  const waists = hs.filter(h => typeof h.waist === 'number').sort((a, b) => a.date.localeCompare(b.date));
  const fats = hs.filter(h => typeof h.bodyfat === 'number').sort((a, b) => a.date.localeCompare(b.date));

  const base = baseline();
  const results = state.results.filter(x => inRange(x.date));
  const liftDates = Object.keys(state.lifts).filter(inRange).sort();

  const mealPrefix = r.year + '-' + String(new Date(r.fromISO).getMonth() + 1).padStart(2, '0');
  const mealsDone = Object.keys(state.meals).filter(k => k.indexOf(mealPrefix) === 0 && state.meals[k]).length;

  return {
    range: r,
    planned, done, skipped, extras,
    avgSleep: avg(sleeps), minSleep: sleeps.length ? Math.min.apply(null, sleeps) : null,
    avgRhr: avg(rhrs), avgHrv: avg(hrvs), avgSteps: avg(steps),
    weightStart: weights.length ? weights[0].weight : null,
    weightEnd: weights.length ? weights[weights.length - 1].weight : null,
    waistStart: waists.length ? waists[0].waist : null,
    waistEnd: waists.length ? waists[waists.length - 1].waist : null,
    fatStart: fats.length ? fats[0].bodyfat : null,
    fatEnd: fats.length ? fats[fats.length - 1].bodyfat : null,
    results: results.length,
    liftDates: liftDates,
    mealsDone,
    base
  };
}

function liftChange(stats) {
  const dates = stats.liftDates;
  if (dates.length < 2) return null;
  const a = state.lifts[dates[0]];
  const b = state.lifts[dates[dates.length - 1]];
  let best = null;
  ['squat', 'deadlift', 'snatch', 'cj'].forEach(k => {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') {
      const diff = b[k] - a[k];
      if (best === null || Math.abs(diff) > Math.abs(best.diff)) best = { key: k, diff, from: a[k], to: b[k] };
    }
  });
  return best;
}

function monthReviewCard() {
  const s = monthStats(state.monthOffset || 0);
  const r = s.range;
  const pct = s.planned ? Math.round((s.done / s.planned) * 100) : 0;

  const rows = [];
  rows.push(['训练', s.planned ? s.done + ' / ' + s.planned + ' 次（' + pct + '%）' + (s.skipped ? ' · 跳过 ' + s.skipped : '') + (s.extras ? ' · 加练 ' + s.extras : '') : '这个月没有排课']);
  if (s.avgSleep != null) rows.push(['睡眠', s.avgSleep.toFixed(1) + 'h' + (s.minSleep != null ? ' · 最低 ' + s.minSleep.toFixed(1) + 'h' : '')]);
  if (s.avgRhr != null) rows.push(['静息心率', Math.round(s.avgRhr) + (s.base.rhr ? ' · 基线 ' + Math.round(s.base.rhr) : '')]);
  if (s.avgHrv != null) rows.push(['HRV', Math.round(s.avgHrv) + (s.base.hrv ? ' · 基线 ' + Math.round(s.base.hrv) : '')]);
  if (s.avgSteps != null) rows.push(['步数', Math.round(s.avgSteps) + ' / 天']);
  if (s.weightStart != null) rows.push(['体重', s.weightStart.toFixed(1) + ' → ' + s.weightEnd.toFixed(1) + ' kg（' + (s.weightEnd - s.weightStart >= 0 ? '+' : '') + (s.weightEnd - s.weightStart).toFixed(1) + '）']);
  if (s.waistStart != null) rows.push(['腰围', s.waistStart + ' → ' + s.waistEnd + ' cm']);
  if (s.fatStart != null) rows.push(['体脂', s.fatStart + ' → ' + s.fatEnd + ' %']);
  const lc = liftChange(s);
  if (lc) {
    const names = { squat: '深蹲', deadlift: '硬拉', snatch: '抓举', cj: '挺举' };
    rows.push(['力量', names[lc.key] + ' ' + lc.from + ' → ' + lc.to + ' kg（' + (lc.diff >= 0 ? '+' : '') + lc.diff + '）']);
  }
  if (s.results) rows.push(['WOD 成绩', s.results + ' 条']);

  const train = [];
  const diet = [];
  const focus = [];

  if (s.planned && pct < 60) {
    train.push('下月降到每周 3 天：完成率 ' + pct + '%，4 天排太满了。');
    focus.push('把训练日固定下来，别每天临时决定');
  } else if (s.planned && pct >= 85) {
    train.push('完成率 ' + pct + '%，可以按原计划继续，不用加量。');
  }
  if (s.skipped >= 4) train.push('这个月跳了 ' + s.skipped + ' 次，先把时间定死（比如周一/二/四/五晚上 7 点）。');
  if (s.avgSleep != null && s.avgSleep < 7) {
    train.push('睡眠均值 ' + s.avgSleep.toFixed(1) + 'h：下月每周只安排 1 次高强度，其余放 Zone2。');
    focus.push('把入睡时间提前 30 分钟');
  }
  if (s.avgRhr != null && s.base.rhr && s.avgRhr - s.base.rhr >= 5) {
    train.push('静息心率整月偏高：下月第 1 周做减量（组数 −40%，重量 −10%）。');
    focus.push('安排一个真正的减量周');
  }
  if (s.avgHrv != null && s.base.hrv && s.avgHrv / s.base.hrv < 0.9) {
    train.push('HRV 偏低：减少阈值间歇，改成 Zone2 为主。');
  }
  if (lc && lc.diff <= 0) {
    train.push('力量停滞（' + lc.from + ' → ' + lc.to + 'kg）：下月把主项组数 +1 组，重量不动。');
    focus.push('主项多做一组，先把量堆起来');
  }
  if (s.results >= 2) train.push('WOD 有 ' + s.results + ' 条记录，下月用同一个降阶重测一次，才看得出进步。');

  if (s.weightStart != null) {
    const dw = s.weightEnd - s.weightStart;
    if (dw > -0.3) {
      diet.push('体重几乎没动（' + dw.toFixed(1) + 'kg）：热量减 150 kcal，或每天步数 +1500。');
      focus.push('盯住饮食记录，别再凭感觉吃');
    } else if (dw <= -3) {
      diet.push('掉重偏快（' + dw.toFixed(1) + 'kg）：热量 +150 kcal，优先加训练日碳水。');
    } else {
      diet.push('体重降 ' + Math.abs(dw).toFixed(1) + 'kg，节奏正常，维持 2300 kcal。');
    }
  }
  if (s.avgSteps != null && s.avgSteps < 7000) {
    diet.push('步数均值 ' + Math.round(s.avgSteps) + '：先补到 8000，比加练更有效。');
    focus.push('每天补 2000 步');
  }
  if (s.planned && s.mealsDone < s.planned * 2) {
    diet.push('餐食打卡很少：先记一周，否则没法判断吃得对不对。');
  }

  if (!train.length) train.push('训练数据正常，按原计划继续。');
  if (!diet.length) diet.push('饮食没有异常，维持当前配额。');
  while (focus.length < 3) {
    focus.push(['保持每周 4 练的节奏', '睡眠守住 7.5 小时', '步数守住 8000'][focus.length]);
  }

  let html = '<div class="card"><h2>月度复盘</h2>' +
    '<div class="seg" style="margin-bottom:12px">' +
    '<button class="' + ((state.monthOffset || 0) === -1 ? 'on' : '') + '" data-action="month-prev">上月</button>' +
    '<button class="' + ((state.monthOffset || 0) === 0 ? 'on' : '') + '" data-action="month-this">本月</button>' +
    '</div>' +
    '<div style="font-weight:700;margin-bottom:6px">' + r.year + ' 年 ' + r.label + '</div>';

  rows.forEach(pair => {
    html += '<div class="row between small" style="padding:5px 0;border-bottom:1px solid var(--line)">' +
      '<span class="muted">' + pair[0] + '</span><span style="font-weight:600;text-align:right">' + esc(pair[1]) + '</span></div>';
  });

  html += '<div style="margin-top:12px"><div class="tiny muted" style="margin-bottom:4px">训练调整</div>';
  train.forEach(t => { html += '<div class="small" style="margin:4px 0">· ' + esc(t) + '</div>'; });
  html += '</div><div style="margin-top:10px"><div class="tiny muted" style="margin-bottom:4px">饮食调整</div>';
  diet.forEach(t => { html += '<div class="small" style="margin:4px 0">· ' + esc(t) + '</div>'; });
  html += '</div><div style="margin-top:10px"><div class="tiny muted" style="margin-bottom:4px">下月重点加强</div>';
  focus.slice(0, 3).forEach((t, i) => { html += '<div class="small" style="margin:4px 0">' + (i + 1) + '. ' + esc(t) + '</div>'; });
  html += '</div></div>';
  return html;
}

function renderData() {
  const rec = todayHealth();
  const base = baseline();
  const score = readinessOf(rec, base);
  const week = state.reviewWeek || weekNumber();

  const tile = (k, v, c) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${c ? `<div class="c">${c}</div>` : ''}</div>`;

  let html = reviewCard(week);
  html += monthReviewCard();

  if (score !== null) {
    html += `<div class="card readiness">${ring(score)}<div class="grow">
      <div style="font-weight:700">今天的恢复评分</div>
      <div class="small muted" style="margin-top:4px">基线来自最近 ${base.count} 天的记录${base.count < 3 ? '（不足 3 天时心率项不参与计算）' : ''}</div>
    </div></div>`;
  }

  html += readinessChart();
  html += weightChart();
  html += sleepChart();
  html += weeklyVolumeChart();
  html += waistChart();
  html += bodyfatChart();
  html += liftCard();

  html += `<div class="card"><h2>今天</h2><div class="grid2">
    ${tile('睡眠', rec && rec.sleep != null ? rec.sleep.toFixed(1) + ' h' : '—', base.sleep ? `基线 ${base.sleep.toFixed(1)}h` : '')}
    ${tile('静息心率', rec && rec.rhr != null ? Math.round(rec.rhr) + ' bpm' : '—', base.rhr ? `基线 ${Math.round(base.rhr)}` : '')}
    ${tile('HRV', rec && rec.hrv != null ? Math.round(rec.hrv) + ' ms' : '—', base.hrv ? `基线 ${Math.round(base.hrv)}` : '')}
    ${tile('步数', rec && rec.steps != null ? Math.round(rec.steps) : '—', '目标 8000+')}
    ${tile('训练', rec && rec.workout != null ? Math.round(rec.workout) + ' 分' : '—', todaySession() ? '今天是训练日' : '今天休息')}
    ${tile('体重', rec && rec.weight != null ? rec.weight.toFixed(1) + ' kg' : '—', '目标 83–84')}
  </div></div>`;

  if (rec && (rec.active != null || rec.exercise != null || rec.stand != null || rec.workoutType)) {
    const detail = [
      rec.workoutType ? esc(rec.workoutType) : null,
      rec.workoutKcal != null ? `${Math.round(rec.workoutKcal)} kcal` : null,
      rec.workoutDistance != null ? `${rec.workoutDistance.toFixed(1)} km` : null,
      rec.hrAvg != null ? `平均心率 ${Math.round(rec.hrAvg)}` : null
    ].filter(Boolean).join(' · ');
    const trainMinutes = rec.workout != null ? rec.workout : rec.exercise;
    html += `<div class="card"><h2>运动</h2><div class="grid2">
      ${tile('活动热量', rec.active != null ? Math.round(rec.active) + ' kcal' : '—', null)}
      ${tile('锻炼分钟', rec.exercise != null ? Math.round(rec.exercise) + ' 分' : '—', '目标 30+')}
      ${tile('站立', rec.stand != null ? Math.round(rec.stand) + ' 小时' : '—', '目标 10+')}
      ${tile('训练时长', trainMinutes != null ? Math.round(trainMinutes) + ' 分' : '—', rec.workout == null && rec.exercise != null ? '按锻炼时间' : null)}
    </div>${detail ? `<div class="small muted" style="margin-top:10px">最近一次：${detail}</div>` : ''}</div>`;
  }

  if (state.results.length) {
    html += `<div class="card"><h2>WOD 成绩</h2>`;
    state.results.slice().reverse().slice(0, 8).forEach(r => {
      const value = r.kind === 'time' ? formatSeconds(r.seconds) : `${r.rounds} 轮 ${r.reps} 次`;
      const plan = PLAN.weeks.find(w => w.week === r.week);
      const session = plan ? plan.days.find(d => d.day === r.day) : null;
      html += `<div class="row between small" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span class="muted">${r.date.slice(5)}</span>
        <span class="grow">${esc(session ? session.title : '训练')}</span>
        <span style="font-weight:600">${value}</span>
      </div>`;
    });
    html += `</div>`;
  }

  const recent = state.health.slice(-7).reverse();
  if (recent.length) {
    html += `<div class="card"><h2>最近记录</h2>`;
    recent.forEach(h => {
      html += `<div class="row between small" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span class="muted">${h.date.slice(5)}</span>
        <span>睡 ${h.sleep != null ? h.sleep.toFixed(1) : '—'}h</span>
        <span>${h.steps != null ? Math.round(h.steps) : '—'} 步</span>
        <span class="muted">${h.workout != null ? Math.round(h.workout) + ' 分' : '—'}</span>
      </div>`;
    });
    html += `</div>`;
  }

  html += `<div class="card"><h2>导入健康数据</h2>
    <div class="small muted" style="margin-bottom:10px">iPhone 上主屏幕 App 与 Safari 的存储是分开的，所以快捷指令用剪贴板把数据送进来：跑完快捷指令，回到这里点一下。</div>
    <div style="display:grid;gap:8px">
      <button class="primary" data-action="sync">运行快捷指令</button>
      <button class="ghost" data-action="paste-import">从剪贴板导入</button>
    </div></div>`;

  html += bodyFormCard(rec);
  html += liftFormCard();

  html += `<div class="card"><h2>手动录入今天</h2>
    <form id="manualForm">
      <label class="field"><span>睡眠（小时）</span><input type="number" step="0.1" name="sleep" inputmode="decimal" value="${rec && rec.sleep != null ? rec.sleep : ''}"></label>
      <label class="field"><span>静息心率</span><input type="number" name="rhr" inputmode="numeric" value="${rec && rec.rhr != null ? Math.round(rec.rhr) : ''}"></label>
      <label class="field"><span>HRV（ms）</span><input type="number" name="hrv" inputmode="numeric" value="${rec && rec.hrv != null ? Math.round(rec.hrv) : ''}"></label>
      <label class="field"><span>步数</span><input type="number" name="steps" inputmode="numeric" value="${rec && rec.steps != null ? Math.round(rec.steps) : ''}"></label>
      <label class="field"><span>训练时长（分钟）</span><input type="number" name="workout" inputmode="numeric" value="${rec && rec.workout != null ? Math.round(rec.workout) : ''}"></label>
      <label class="field"><span>体重（kg）</span><input type="number" step="0.1" name="weight" inputmode="decimal" value="${rec && rec.weight != null ? rec.weight : ''}"></label>
      <button class="primary" type="submit">保存</button>
    </form></div>`;

  $('#tab-data').innerHTML = html;
}

function renderSettings() {
  let html2 = `<div class="card"><h2>计划</h2>
    <label class="field"><span>开始日期（第 1 周第 1 天）</span>
      <input type="date" id="startDate" value="${state.startDate || todayISO()}"></label>
    <div class="small muted">当前：第 ${weekNumber()} 周</div></div>`;

  html2 += `<div class="card"><h2>快捷指令同步</h2>
    <label class="field"><span>快捷指令名称</span>
      <input type="text" id="shortcutName" value="${esc(state.shortcutName)}"></label>
    <button class="primary" data-action="sync">运行快捷指令并同步</button>
    <div class="hr"></div>
    <button class="ghost" data-action="copy-template">复制「打开 URL」模板</button>
    <div class="small muted" style="margin-top:8px">在快捷指令的最后一步用「打开 URL」，把模板里的 [睡眠] 等替换成健康数据变量，就能把数据带回来。</div></div>`;

  html2 += `<div class="card"><h2>日历提醒</h2>
    <div class="small muted">导入 <b>CF-提醒-每日.ics</b>：每天 <b>07:20</b> 一条，训练和当天全部餐食都在里面。12 周共 51 条。</div>
    <div class="tiny muted" style="margin-top:8px">一天只有这一条，所以不需要再单独取消训练提醒；不练就在上面切「今天不练」，餐单自动换休息版。</div></div>`;

  html2 += `<div class="card"><h2>数据</h2>
    <button class="ghost" data-action="clear">清空全部记录</button>
    <div class="small muted" style="margin-top:8px">所有数据只存在这台手机的浏览器里，不上传。</div></div>`;

  html2 += `<div class="card"><h2>关于</h2>
    <div class="small muted">CF 教练 · v2 计划（引擎优先）· 12 周 48 次训练 · 7 天餐单</div></div>`;

  $('#tab-settings').innerHTML = html2;
}

/* ---------- helpers ---------- */

function fmt(v, digits = 1) {
  return (typeof v === 'number' && !isNaN(v)) ? v.toFixed(digits) : '—';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  setHeader();
  document.querySelectorAll('.tab').forEach(el => el.classList.add('hidden'));
  $('#tab-' + state.tab).classList.remove('hidden');
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));

  if (state.tab === 'today') renderToday();
  if (state.tab === 'plan') renderPlan();
  if (state.tab === 'meals') renderMeals();
  if (state.tab === 'data') renderData();
  if (state.tab === 'settings') renderSettings();
}

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('#tabbar button');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'mode-train') { setMode('train'); return; }
  if (action === 'mode-rest') { setMode('rest'); return; }
  if (action === 'pick-extra') {
    state.extraPick[todayISO()] = el.dataset.id;
    store.set('extraPick', state.extraPick);
    render();
    return;
  }
  if (action === 'toggle-extra') {
    const id = el.dataset.id || '';
    if (id.indexOf('day-') === 0) {
      const key = `w${weekNumber()}d${id.split('-')[1]}`;
      state.checkins[key] = !state.checkins[key];
      store.set('checkins', state.checkins);
    } else {
      const iso = todayISO();
      state.extraDone[iso] = !state.extraDone[iso];
      store.set('extraDone', state.extraDone);
    }
    render();
    return;
  }
  if (action === 'review-this') { state.reviewWeek = weekNumber(); render(); return; }
  if (action === 'review-prev') { state.reviewWeek = Math.max(1, weekNumber() - 1); render(); return; }
  if (action === 'month-this') { state.monthOffset = 0; store.set('monthOffset', 0); render(); return; }
  if (action === 'month-prev') { state.monthOffset = -1; store.set('monthOffset', -1); render(); return; }
  if (action === 'del-result') {
    state.results = state.results.filter(r => String(r.id) !== el.dataset.id);
    store.set('results', state.results);
    render();
    return;
  }

  if (action === 'toggle-session') {
    const s = todaySession();
    if (!s) return;
    const key = `w${weekNumber()}d${s.day}`;
    state.checkins[key] = !state.checkins[key];
    store.set('checkins', state.checkins);
    render();
  }

  if (action === 'toggle-meal') {
    const key = `${todayISO()}-${el.dataset.slot}`;
    state.meals[key] = !state.meals[key];
    store.set('meals', state.meals);
    render();
  }

  if (action === 'go-meals') { state.tab = 'meals'; render(); window.scrollTo(0, 0); }
  if (action === 'go-data') { state.tab = 'data'; render(); window.scrollTo(0, 0); }
  if (action === 'go-plan') { state.tab = 'plan'; render(); window.scrollTo(0, 0); }

  if (action === 'sync') {
    const name = encodeURIComponent(state.shortcutName || '同步健康数据');
    location.href = `shortcuts://run-shortcut?name=${name}`;
  }

  if (action === 'paste-import') { pasteImport(); }

  if (action === 'copy-template') {
    const url = location.origin + location.pathname +
      '?sleep=[睡眠]&rhr=[静息心率]&hrv=[HRV]&steps=[步数]&workout=[训练分钟]&weight=[体重]';
    const done = () => alert('模板已复制。\n\n' + url);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(done);
    } else { done(); }
  }

  if (action === 'clear') {
    if (confirm('清空所有打卡和健康记录？此操作不可撤销。')) {
      ['checkins', 'meals', 'health'].forEach(k => { store.set(k, k === 'health' ? [] : {}); });
      state.checkins = {}; state.meals = {}; state.health = [];
      render();
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'wodKind') {
    const timeBox = document.getElementById('wodTime');
    const roundBox = document.getElementById('wodRounds');
    const isTime = e.target.value === 'time';
    if (timeBox) timeBox.classList.toggle('hidden', !isTime);
    if (roundBox) roundBox.classList.toggle('hidden', isTime);
  }
  if (e.target.id === 'startDate') {
    state.startDate = e.target.value;
    store.set('startDate', state.startDate);
    render();
  }
  if (e.target.id === 'shortcutName') {
    state.shortcutName = e.target.value;
    store.set('shortcutName', state.shortcutName);
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'wodForm') {
    e.preventDefault();
    const form = new FormData(e.target);
    const kind = form.get('kind') || 'time';
    const session = todaySession();
    if (!session) return;
    const rpeRaw = parseInt(form.get('rpe'), 10);
    const result = {
      id: String(Date.now()),
      date: todayISO(),
      week: weekNumber(),
      day: session.day,
      kind,
      rpe: isNaN(rpeRaw) ? null : Math.min(10, Math.max(1, rpeRaw)),
      note: String(form.get('note') || '').trim()
    };
    if (kind === 'time') {
      const m = parseInt(form.get('min'), 10) || 0;
      const s = parseInt(form.get('sec'), 10) || 0;
      if (m === 0 && s === 0) { alert('填一下用时。'); return; }
      result.seconds = m * 60 + s;
    } else {
      result.rounds = parseInt(form.get('rounds'), 10) || 0;
      result.reps = parseInt(form.get('reps'), 10) || 0;
      if (result.rounds === 0 && result.reps === 0) { alert('填一下轮数或次数。'); return; }
    }
    state.results.push(result);
    store.set('results', state.results);
    render();
    alert('成绩已保存。');
    return;
  }

  if (e.target.id === 'bodyForm') {
    e.preventDefault();
    const form = new FormData(e.target);
    const date = String(form.get('date') || todayISO());
    const rec = { date };
    ['weight', 'waist', 'bodyfat'].forEach(k => {
      const raw = form.get(k);
      if (raw !== null && String(raw).trim() !== '') {
        const v = parseFloat(raw);
        if (!isNaN(v)) rec[k] = v;
      }
    });
    if (Object.keys(rec).length === 1) { alert('填一个数再保存。'); return; }
    saveHealth(rec);
    render();
    return;
  }

  if (e.target.id === 'liftForm') {
    e.preventDefault();
    const form = new FormData(e.target);
    const date = String(form.get('date') || todayISO());
    const rec = {};
    ['squat', 'deadlift', 'snatch', 'cj'].forEach(k => {
      const raw = form.get(k);
      if (raw !== null && String(raw).trim() !== '') {
        const v = parseFloat(raw);
        if (!isNaN(v)) rec[k] = v;
      }
    });
    if (!Object.keys(rec).length) { alert('至少填一项。'); return; }
    state.lifts[date] = Object.assign({}, state.lifts[date] || {}, rec);
    store.set('lifts', state.lifts);
    render();
    return;
  }

  if (e.target.id === 'manualForm') {
    e.preventDefault();
    const form = new FormData(e.target);
    const rec = { date: todayISO() };
    KEYS.forEach(k => {
      const raw = form.get(k);
      if (raw !== null && String(raw).trim() !== '') {
        const v = parseFloat(raw);
        if (!isNaN(v)) rec[k] = v;
      }
    });
    saveHealth(rec);
    render();
    alert('已保存。');
  }
});

/* ---------- boot ---------- */

async function boot() {
  if (!state.startDate) {
    state.startDate = todayISO();
    store.set('startDate', state.startDate);
  }
  try {
    await loadData();
  } catch (err) {
    $('#tab-today').innerHTML = `<div class="card">数据加载失败：${esc(err.message)}<br><br>请确认 plan.json 和 menu.json 在同一目录。</div>`;
    return;
  }
  importFromURL();
  bindImportModal();
  render();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* debug hook (also used by the offline test harness) */
if (typeof globalThis !== 'undefined') {
  globalThis.__cf = { state, render, setMode, renderToday, renderData, renderMeals, weeklyReview };
}

boot();
