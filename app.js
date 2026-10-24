/* 看板 · 项目管理（纯静态单页应用）
 *
 * 只依赖浏览器原生能力：DOM + localStorage + HTML5 拖放，无任何构建与后端。
 * 分层：
 *   常量/工具 → 数据模型（校验清洗/种子/存储） → 纯查询（筛选/统计）
 *   → 弹窗系统 → 看板·列·卡片操作 → 拖拽 → 渲染 → 导入导出 → 初始化
 * 所有用户数据只经 textContent / createElement 写入 DOM，不做 HTML 拼接。
 */
(function () {
  'use strict';

  /* ==================== 常量与配置 ==================== */

  var STORAGE_KEY = 'kanban-board.v1';
  var CORRUPT_KEY = 'kanban-board.corrupt.v1';
  var DATA_VERSION = 1;
  var MAX_COLUMNS = 8;      // 每个看板最多列数
  var NAME_MAX = 30;        // 看板/列名称长度上限
  var CARD_TITLE_MAX = 60;
  var DESC_MAX = 500;
  var SUB_MAX = 200;        // 单条子任务文本长度
  var SUB_COUNT_MAX = 50;   // 每张卡片子任务条数上限

  /* 内置标签（卡片可多选，用于筛选） */
  var LABELS = [
    { id: 'feat',    name: '功能', color: '#2563eb' },
    { id: 'bug',     name: '缺陷', color: '#dc2626' },
    { id: 'design',  name: '设计', color: '#9333ea' },
    { id: 'doc',     name: '文档', color: '#0d9488' },
    { id: 'test',    name: '测试', color: '#ea580c' },
    { id: 'idea',    name: '想法', color: '#db2777' },
    { id: 'opt',     name: '优化', color: '#16a34a' },
    { id: 'release', name: '发布', color: '#64748b' }
  ];
  var LABEL_MAP = {};
  LABELS.forEach(function (l) { LABEL_MAP[l.id] = l; });

  var PRIORITIES = [
    { id: 'high', name: '高' },
    { id: 'mid',  name: '中' },
    { id: 'low',  name: '低' }
  ];
  var PRIORITY_NAME = { high: '高', mid: '中', low: '低' };

  /* ==================== DOM / 通用工具 ==================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* h('button', { class:'btn', onclick: fn, disabled: cond||null }, ['文本', childEl]) */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ==================== 日期工具（一律本地日期 YYYY-MM-DD） ==================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayKey() { return fmtKey(new Date()); }
  function parseKey(key) {
    var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!p) return null;
    var d = new Date(+p[1], +p[2] - 1, +p[3]);
    return isNaN(d.getTime()) ? null : d;
  }
  function isDateKey(s) {
    if (typeof s !== 'string') return false;
    var d = parseKey(s);
    return !!d && fmtKey(d) === s;
  }
  function addDays(key, n) {
    var d = parseKey(key);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return fmtKey(d);
  }
  /* 本周周日的日期 key（周一为一周开始） */
  function endOfWeekKey(key) {
    var d = parseKey(key);
    if (!d) return null;
    var day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() + (6 - day));
    return fmtKey(d);
  }
  function fmtDue(key) {
    var d = parseKey(key);
    return d ? d.getMonth() + 1 + '-' + pad2(d.getDate()) : key;
  }

  /* ==================== 数据模型：校验与清洗 ==================== */

  function sanitizeCard(raw, columnIds) {
    if (!raw || typeof raw !== 'object') return null;
    var columnId = typeof raw.columnId === 'string' ? raw.columnId : '';
    if (columnIds.indexOf(columnId) < 0) return null; // 卡片必须挂在存在的列上
    var title = typeof raw.title === 'string' ? raw.title.trim().slice(0, CARD_TITLE_MAX) : '';
    if (!title) return null;
    var desc = typeof raw.desc === 'string' ? raw.desc.trim().slice(0, DESC_MAX) : '';
    var labels = Array.isArray(raw.labels)
      ? raw.labels.filter(function (id) { return !!LABEL_MAP[id]; })
      : [];
    var priority = PRIORITY_NAME[raw.priority] ? raw.priority : 'mid';
    var due = isDateKey(raw.due) ? raw.due : null;
    var subtasks = [];
    if (Array.isArray(raw.subtasks)) {
      raw.subtasks.forEach(function (s) {
        if (!s || typeof s !== 'object') return;
        var text = typeof s.text === 'string' ? s.text.trim().slice(0, SUB_MAX) : '';
        if (!text) return;
        subtasks.push({
          id: typeof s.id === 'string' && s.id ? s.id : uid('sub'),
          text: text,
          done: !!s.done
        });
      });
      if (subtasks.length > SUB_COUNT_MAX) subtasks = subtasks.slice(0, SUB_COUNT_MAX);
    }
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('card'),
      columnId: columnId,
      title: title,
      desc: desc,
      labels: labels,
      priority: priority,
      due: due,
      subtasks: subtasks,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
    };
  }

  function sanitizeColumn(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
    if (!name) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('col'),
      name: name,
      isDone: !!raw.isDone
    };
  }

  function sanitizeBoard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
    if (!name) return null;
    if (!Array.isArray(raw.columns)) return null;
    var columns = [];
    raw.columns.forEach(function (c) {
      var col = sanitizeColumn(c);
      if (col) columns.push(col);
    });
    if (!columns.length) return null; // 看板至少要有一列
    var columnIds = columns.map(function (c) { return c.id; });
    var cards = [];
    var seen = {};
    if (Array.isArray(raw.cards)) {
      raw.cards.forEach(function (cRaw) {
        var card = sanitizeCard(cRaw, columnIds);
        if (!card || seen[card.id]) return;
        seen[card.id] = 1;
        cards.push(card);
      });
    }
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('board'),
      name: name,
      columns: columns,
      cards: cards
    };
  }

  /* 宽松清洗：接受导出信封 {boards, activeBoardId} 或裸 boards 数组；
   * 结构性错误返回 null（加载时回退示例，导入时提示格式不符）。 */
  function sanitizeState(data) {
    if (!data || typeof data !== 'object') return null;
    var boardsRaw = Array.isArray(data.boards) ? data.boards : (Array.isArray(data) ? data : null);
    if (!boardsRaw) return null;
    var boards = [];
    var seenIds = {};
    boardsRaw.forEach(function (bRaw) {
      var b = sanitizeBoard(bRaw);
      if (!b || seenIds[b.id]) return;
      seenIds[b.id] = 1;
      boards.push(b);
    });
    if (!boards.length) return null;
    var activeBoardId =
      typeof data.activeBoardId === 'string' && boards.some(function (b) { return b.id === data.activeBoardId; })
        ? data.activeBoardId
        : boards[0].id;
    return { version: DATA_VERSION, boards: boards, activeBoardId: activeBoardId };
  }

  /* ==================== 种子数据 ==================== */

  function defaultColumns() {
    return [
      { id: uid('col'), name: '待办', isDone: false },
      { id: uid('col'), name: '进行中', isDone: false },
      { id: uid('col'), name: '已完成', isDone: true }
    ];
  }
  function createBoard(name) {
    return { id: uid('board'), name: name, columns: defaultColumns(), cards: [] };
  }

  /* 首次打开播种示例看板：日期相对「今天」生成，保证逾期/本周到期可见 */
  function seedState() {
    var t = todayKey();
    var board = createBoard('示例看板');
    var cols = board.columns;
    function card(colIdx, title, desc, labels, priority, due, subtasks) {
      board.cards.push({
        id: uid('card'),
        columnId: cols[colIdx].id,
        title: title,
        desc: desc,
        labels: labels,
        priority: priority,
        due: due,
        subtasks: subtasks.map(function (s) {
          return { id: uid('sub'), text: s[0], done: s[1] };
        }),
        createdAt: Date.now()
      });
    }
    card(0, '整理新版产品需求文档', '汇总近两周的用户反馈，输出 PRD 草稿并同步给设计与开发。',
      ['feat', 'doc'], 'high', addDays(t, 2),
      [['梳理用户反馈', true], ['竞品对比分析', true], ['输出 PRD 草稿', false], ['评审会排期', false]]);
    card(0, '修复登录页移动端样式错位', '小屏下验证码按钮会被挤出屏幕，需要调整断点布局。',
      ['bug'], 'high', addDays(t, -1),
      [['复现问题', true], ['修复并回归', false]]);
    card(1, '首页改版视觉设计稿', '重点优化首屏信息层级与行动按钮引导。',
      ['design', 'idea'], 'mid', addDays(t, 4),
      [['首屏方案', true], ['二级页面延展', false], ['标注与切图', false]]);
    card(1, '订单接口联调', '与后端联调下单 / 查询两个接口，今天要提测。',
      ['feat', 'test'], 'high', t,
      [['下单接口', true], ['查询接口', true], ['异常场景', false]]);
    card(2, '搭建项目工程脚手架', '初始化仓库、目录结构与基础规范。',
      ['feat', 'release'], 'mid', addDays(t, -5),
      [['初始化仓库', true], ['配置代码规范', true]]);
    card(2, '完成季度竞品调研报告', '已同步给产品团队，结论沉淀在知识库。',
      ['doc'], 'low', null, []);
    return { version: DATA_VERSION, boards: [board], activeBoardId: board.id };
  }

  /* ==================== 存取 ==================== */

  var state = null;

  /* 返回 { status, state }：ok=正常读取；first=首次播种；
   * corrupted=数据损坏（原文已备份并重置示例）；unavailable=存储不可用。 */
  function loadState() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (e) {
      return { status: 'unavailable', state: seedState() };
    }
    if (raw === null || raw === undefined || raw === '') {
      return { status: 'first', state: seedState() };
    }
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    var st = parsed ? sanitizeState(parsed) : null;
    if (st) return { status: 'ok', state: st };
    try { window.localStorage.setItem(CORRUPT_KEY, raw); } catch (e2) { /* 忽略备份失败 */ }
    return { status: 'corrupted', state: seedState() };
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('保存失败：浏览器存储不可用或已满', 'error');
      return false;
    }
  }

  /* ==================== 查询与统计（纯计算） ==================== */

  function activeBoard() {
    if (!state || !state.boards.length) return null;
    for (var i = 0; i < state.boards.length; i++) {
      if (state.boards[i].id === state.activeBoardId) return state.boards[i];
    }
    return state.boards[0];
  }
  function findCard(board, cardId) {
    for (var i = 0; i < board.cards.length; i++) {
      if (board.cards[i].id === cardId) return board.cards[i];
    }
    return null;
  }
  function cardsOfColumn(board, colId) {
    return board.cards.filter(function (c) { return c.columnId === colId; });
  }
  function doneColumnIds(board) {
    return board.columns.filter(function (c) { return c.isDone; }).map(function (c) { return c.id; });
  }
  /* 逾期口径：有截止日期、早于今天、且不在完成列 */
  function isOverdue(card, doneIds, today) {
    return !!card.due && card.due < today && doneIds.indexOf(card.columnId) < 0;
  }

  function computeStats(board) {
    var doneIds = doneColumnIds(board);
    var t = todayKey();
    var eow = endOfWeekKey(t);
    var week = 0, over = 0, done = 0;
    board.cards.forEach(function (c) {
      if (doneIds.indexOf(c.columnId) >= 0) { done++; return; }
      if (!c.due) return;
      if (c.due < t) over++;
      else if (c.due <= eow) week++;
    });
    var total = board.cards.length;
    return {
      perColumn: board.columns.map(function (col) {
        return { name: col.name, isDone: col.isDone, count: cardsOfColumn(board, col.id).length };
      }),
      week: week,
      over: over,
      done: done,
      total: total,
      rate: total ? Math.round((done / total) * 100) : null
    };
  }

  /* ==================== 筛选（仅界面状态，不持久化） ==================== */

  var filter = { q: '', label: '', priority: '', overdue: '' };

  function filterActive() {
    return !!(filter.q.trim() || filter.label || filter.priority || filter.overdue);
  }
  function cardMatches(card, doneIds, today) {
    var q = filter.q.trim().toLowerCase();
    if (q) {
      var hay = (card.title + '\n' + card.desc + '\n' +
        card.subtasks.map(function (s) { return s.text; }).join('\n')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (filter.label && card.labels.indexOf(filter.label) < 0) return false;
    if (filter.priority && card.priority !== filter.priority) return false;
    var over = isOverdue(card, doneIds, today);
    if (filter.overdue === 'over' && !over) return false;
    if (filter.overdue === 'not' && over) return false;
    return true;
  }

  /* ==================== 弹窗系统（可叠加，Esc 只关最上层） ==================== */

  var modalStack = [];

  function openModal(build) {
    return new Promise(function (resolve) {
      var overlay = h('div', { class: 'modal-overlay' });
      var box = h('div', { class: 'modal-box', role: 'dialog', 'aria-modal': 'true' });
      overlay.appendChild(box);
      $('#modal-root').appendChild(overlay);
      var closed = false;
      function close(val) {
        if (closed) return;
        closed = true;
        var i = modalStack.indexOf(entry);
        if (i >= 0) modalStack.splice(i, 1);
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(val === undefined ? null : val);
      }
      function onKey(e) {
        if (e.key === 'Escape' && modalStack[modalStack.length - 1] === entry) {
          e.stopPropagation();
          close(null);
        }
      }
      var entry = { close: close, onKey: onKey };
      modalStack.push(entry);
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey);
      build(box, close);
      var fi = box.querySelector('input:not([type="checkbox"]), textarea, select, button');
      if (fi) fi.focus();
    });
  }

  /* 文本输入弹窗：确认返回去除首尾空白后的文本，取消/关闭返回 null */
  function promptDialog(opts) {
    opts = opts || {};
    return openModal(function (box, close) {
      var err = h('p', { class: 'field-error', hidden: 'hidden' });
      var input = h('input', {
        type: 'text', class: 'input', maxlength: opts.maxLength || NAME_MAX,
        placeholder: opts.placeholder || ''
      });
      input.value = opts.value || '';
      var form = h('form', {}, [
        h('h3', { class: 'modal-title', text: opts.title || '请输入' }),
        opts.label ? h('span', { class: 'field-label', text: opts.label }) : null,
        input,
        err,
        h('div', { class: 'modal-actions' }, [
          h('button', { type: 'button', class: 'btn', onclick: function () { close(null); } }, ['取消']),
          h('button', { type: 'submit', class: 'btn btn-primary' }, ['确定'])
        ])
      ]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = input.value.trim();
        if (opts.required !== false && !v) {
          err.textContent = '内容不能为空';
          err.hidden = false;
          input.focus();
          return;
        }
        close(v);
      });
      box.appendChild(form);
    });
  }

  /* 确认弹窗：确定 true / 取消 false */
  function confirmDialog(opts) {
    opts = opts || {};
    return openModal(function (box, close) {
      box.appendChild(h('div', {}, [
        h('h3', { class: 'modal-title', text: opts.title || '确认操作' }),
        h('p', { class: 'modal-msg', text: opts.message || '' }),
        h('div', { class: 'modal-actions' }, [
          h('button', { type: 'button', class: 'btn', onclick: function () { close(false); } }, ['取消']),
          h('button', {
            type: 'button',
            class: 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger'),
            onclick: function () { close(true); }
          }, [opts.confirmText || '确定'])
        ])
      ]));
    });
  }

  /* ==================== 看板操作 ==================== */

  function newBoardDialog() {
    promptDialog({ title: '新建看板', label: '看板名称', placeholder: '如：工作 / 学习 / 生活', required: true })
      .then(function (name) {
        if (!name) return;
        var b = createBoard(name);
        state.boards.push(b);
        state.activeBoardId = b.id;
        commit();
        toast('已创建看板「' + name + '」', 'ok');
      });
  }

  function renameBoardDialog() {
    var board = activeBoard();
    if (!board) return;
    promptDialog({ title: '重命名看板', label: '看板名称', value: board.name, required: true })
      .then(function (name) {
        if (!name || name === board.name) return;
        board.name = name;
        commit();
        toast('已重命名看板', 'ok');
      });
  }

  function deleteBoardDialog() {
    var board = activeBoard();
    if (!board) return;
    confirmDialog({
      title: '删除看板「' + board.name + '」',
      message: '共 ' + board.columns.length + ' 列 / ' + board.cards.length + ' 张卡片，删除后无法恢复。',
      confirmText: '删除看板'
    }).then(function (ok) {
      if (!ok) return;
      state.boards = state.boards.filter(function (b) { return b.id !== board.id; });
      state.activeBoardId = state.boards.length ? state.boards[0].id : null;
      commit();
      toast('已删除看板「' + board.name + '」');
    });
  }

  /* ==================== 列操作 ==================== */

  function addColumnDialog() {
    var board = activeBoard();
    if (!board) return;
    if (board.columns.length >= MAX_COLUMNS) {
      toast('每个看板最多 ' + MAX_COLUMNS + ' 列', 'warn');
      return;
    }
    promptDialog({ title: '新增列', label: '列名称', placeholder: '如：待测试', required: true })
      .then(function (name) {
        if (!name) return;
        board.columns.push({ id: uid('col'), name: name, isDone: false });
        commit();
        toast('已添加列「' + name + '」', 'ok');
      });
  }

  function renameColumnDialog(board, col) {
    promptDialog({ title: '重命名列', label: '列名称', value: col.name, required: true })
      .then(function (name) {
        if (!name || name === col.name) return;
        col.name = name;
        commit();
        toast('已重命名列', 'ok');
      });
  }

  function deleteColumnDialog(board, col) {
    var n = cardsOfColumn(board, col.id).length;
    confirmDialog({
      title: '删除列「' + col.name + '」',
      message: n
        ? '该列下有 ' + n + ' 张卡片，删除列会一并删除这些卡片。'
        : '该列为空，确定删除吗？',
      confirmText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      board.columns = board.columns.filter(function (c) { return c.id !== col.id; });
      board.cards = board.cards.filter(function (c) { return c.columnId !== col.id; });
      commit();
      toast('已删除列「' + col.name + '」');
    });
  }

  var openMenu = null;
  function closeMenus() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }
  function toggleColMenu(colEl, board, col) {
    if (openMenu && openMenu.parentNode === colEl) { closeMenus(); return; }
    closeMenus();
    var menu = h('div', { class: 'col-menu', role: 'menu' }, [
      h('button', {
        type: 'button', role: 'menuitem',
        onclick: function () { closeMenus(); renameColumnDialog(board, col); }
      }, ['✏️ 重命名列']),
      h('button', {
        type: 'button', role: 'menuitem',
        onclick: function () {
          closeMenus();
          col.isDone = !col.isDone;
          commit();
          toast(col.isDone
            ? '已把「' + col.name + '」标记为完成列（计入完成率，不再计逾期）'
            : '已取消「' + col.name + '」的完成列标记', 'ok');
        }
      }, [col.isDone ? '⬜ 取消完成列标记' : '✅ 标记为完成列']),
      h('button', {
        type: 'button', role: 'menuitem', class: 'danger',
        onclick: function () { closeMenus(); deleteColumnDialog(board, col); }
      }, ['🗑️ 删除列'])
    ]);
    $('.col-head', colEl).appendChild(menu);
    openMenu = menu;
  }

  /* ==================== 卡片编辑器 ==================== */

  function openCardEditor(boardId, columnId, cardId) {
    var board = null;
    state.boards.forEach(function (b) { if (b.id === boardId) board = b; });
    if (!board) return;
    var card = cardId ? findCard(board, cardId) : null;
    var isNew = !card;
    var draft = {
      labels: card ? card.labels.slice() : [],
      priority: card ? card.priority : 'mid',
      subtasks: card
        ? card.subtasks.map(function (s) { return { id: s.id, text: s.text, done: s.done }; })
        : []
    };

    openModal(function (box, close) {
      box.classList.add('modal-wide');

      var titleInput = h('input', { type: 'text', class: 'input', maxlength: CARD_TITLE_MAX, placeholder: '卡片标题（必填）' });
      titleInput.value = card ? card.title : '';
      var descInput = h('textarea', { class: 'input', rows: '3', maxlength: DESC_MAX, placeholder: '补充描述…' });
      descInput.value = card ? card.desc : '';
      var dueInput = h('input', { type: 'date', class: 'input input-date' });
      dueInput.value = card && card.due ? card.due : '';
      var labelsWrap = h('div', { class: 'chip-row' });
      var prioWrap = h('div', { class: 'seg' });
      var subList = h('div', { class: 'sub-list' });
      var subProgress = h('div', { class: 'sub-progress' });
      var subInput = h('input', { type: 'text', class: 'input', maxlength: SUB_MAX, placeholder: '添加子任务，回车或点「添加」' });
      var err = h('p', { class: 'field-error', hidden: 'hidden' });

      function renderLabels() {
        labelsWrap.innerHTML = '';
        LABELS.forEach(function (l) {
          var on = draft.labels.indexOf(l.id) >= 0;
          labelsWrap.appendChild(h('button', {
            type: 'button', class: 'chip-btn' + (on ? ' on' : ''),
            style: '--c:' + l.color,
            'aria-pressed': on ? 'true' : 'false',
            onclick: function () {
              var i = draft.labels.indexOf(l.id);
              if (i >= 0) draft.labels.splice(i, 1);
              else draft.labels.push(l.id);
              renderLabels();
            }
          }, [h('span', { class: 'chip-dot' }), l.name]));
        });
      }
      function renderPriority() {
        prioWrap.innerHTML = '';
        PRIORITIES.forEach(function (p) {
          var on = draft.priority === p.id;
          prioWrap.appendChild(h('button', {
            type: 'button', class: 'seg-btn p-' + p.id + (on ? ' on' : ''),
            'aria-pressed': on ? 'true' : 'false',
            onclick: function () { draft.priority = p.id; renderPriority(); }
          }, [p.name]));
        });
      }
      function renderSubs() {
        subList.innerHTML = '';
        draft.subtasks.forEach(function (s) {
          var cb = h('input', { type: 'checkbox' });
          cb.checked = s.done;
          cb.addEventListener('click', function () { s.done = cb.checked; renderSubs(); });
          subList.appendChild(h('label', { class: 'sub-row' + (s.done ? ' done' : '') }, [
            cb,
            h('span', { class: 'sub-text', text: s.text }),
            h('button', {
              type: 'button', class: 'icon-btn sub-del', 'aria-label': '删除子任务',
              title: '删除子任务',
              onclick: function (e) {
                e.preventDefault();
                e.stopPropagation();
                draft.subtasks = draft.subtasks.filter(function (x) { return x !== s; });
                renderSubs();
              }
            }, ['✕'])
          ]));
        });
        var total = draft.subtasks.length;
        var done = draft.subtasks.filter(function (s) { return s.done; }).length;
        subProgress.innerHTML = '';
        subProgress.appendChild(h('div', { class: 'mini-bar' }, [
          h('i', { style: 'width:' + (total ? Math.round((done / total) * 100) : 0) + '%' })
        ]));
        subProgress.appendChild(h('span', { class: 'sub-num', text: total ? '已完成 ' + done + ' / ' + total : '暂无子任务' }));
      }
      function addSub() {
        var v = subInput.value.trim();
        if (!v) return;
        if (draft.subtasks.length >= SUB_COUNT_MAX) {
          toast('子任务最多 ' + SUB_COUNT_MAX + ' 条', 'warn');
          return;
        }
        draft.subtasks.push({ id: uid('sub'), text: v, done: false });
        subInput.value = '';
        renderSubs();
      }
      subInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addSub(); }
      });

      var form = h('form', { novalidate: 'novalidate' }, [
        h('h3', { class: 'modal-title', text: isNew ? '新建卡片' : '编辑卡片' }),
        h('span', { class: 'field-label', text: '标题 *' }),
        titleInput,
        h('span', { class: 'field-label', text: '描述' }),
        descInput,
        h('span', { class: 'field-label', text: '标签（可多选，颜色区分）' }),
        labelsWrap,
        h('span', { class: 'field-label', text: '优先级' }),
        prioWrap,
        h('span', { class: 'field-label', text: '截止日期（逾期会标红）' }),
        h('div', { class: 'due-row' }, [
          dueInput,
          h('button', {
            type: 'button', class: 'btn btn-sm btn-ghost',
            onclick: function () { dueInput.value = ''; }
          }, ['清除日期'])
        ]),
        h('span', { class: 'field-label', text: '子任务' }),
        subList,
        h('div', { class: 'sub-add-row' }, [
          subInput,
          h('button', { type: 'button', class: 'btn btn-sm', onclick: addSub }, ['添加'])
        ]),
        subProgress,
        err,
        h('div', { class: 'modal-actions' }, [
          !isNew ? h('button', {
            type: 'button', class: 'btn btn-danger-ghost',
            onclick: function () {
              confirmDialog({
                title: '删除卡片',
                message: '确定删除「' + card.title + '」？该操作不可撤销。',
                confirmText: '删除'
              }).then(function (ok) {
                if (!ok) return;
                board.cards = board.cards.filter(function (c) { return c.id !== card.id; });
                commit();
                close(true);
                toast('已删除卡片');
              });
            }
          }, ['删除卡片']) : null,
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn', onclick: function () { close(null); } }, ['取消']),
          h('button', { type: 'submit', class: 'btn btn-primary' }, ['保存'])
        ])
      ]);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var title = titleInput.value.trim();
        if (!title) {
          err.textContent = '标题不能为空';
          err.hidden = false;
          titleInput.focus();
          return;
        }
        var dueRaw = dueInput.value;
        var payload = {
          title: title,
          desc: descInput.value.trim(),
          labels: draft.labels.slice(),
          priority: draft.priority,
          due: isDateKey(dueRaw) ? dueRaw : null,
          subtasks: draft.subtasks.map(function (s) {
            return { id: s.id, text: s.text, done: s.done };
          })
        };
        var savedCard;
        if (isNew) {
          savedCard = {
            id: uid('card'), columnId: columnId, createdAt: Date.now()
          };
          Object.keys(payload).forEach(function (k) { savedCard[k] = payload[k]; });
          board.cards.push(savedCard);
        } else {
          savedCard = card;
          Object.keys(payload).forEach(function (k) { card[k] = payload[k]; });
        }
        commit();
        close(true);
        toast(isNew ? '已添加卡片' : '已保存卡片', 'ok');
        if (filterActive() && !cardMatches(savedCard, doneColumnIds(board), todayKey())) {
          toast('注意：当前筛选条件下不显示这张卡片', 'warn');
        }
      });

      renderLabels();
      renderPriority();
      renderSubs();
      box.appendChild(form);
    });
  }

  /* ==================== 拖拽与移动 ==================== */

  var drag = { cardId: null, ph: null };

  function ensurePh() {
    if (!drag.ph) drag.ph = h('div', { class: 'drop-ph' });
    return drag.ph;
  }
  function clearDrag() {
    var d = $('.card.dragging');
    if (d) d.classList.remove('dragging');
    if (drag.ph && drag.ph.parentNode) drag.ph.parentNode.removeChild(drag.ph);
    drag.cardId = null;
  }
  function onCardDragStart(e) {
    drag.cardId = e.currentTarget.getAttribute('data-id');
    e.currentTarget.classList.add('dragging');
    if (e.dataTransfer) {
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', drag.cardId); // Firefox 需要这句才能发起拖拽
      } catch (_) { /* 环境不支持时忽略 */ }
    }
  }
  function cardAfter(container, y) {
    var cards = $all('.card:not(.dragging)', container);
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return cards[i];
    }
    return null;
  }
  function onColDragOver(e) {
    if (!drag.cardId) return;
    if (e.preventDefault) e.preventDefault();
    var container = $('.col-cards', e.currentTarget);
    if (!container) return;
    var ph = ensurePh();
    var after = cardAfter(container, typeof e.clientY === 'number' ? e.clientY : 0);
    if (after) container.insertBefore(ph, after);
    else container.appendChild(ph);
  }
  function onColDrop(e) {
    if (!drag.cardId) return;
    if (e.preventDefault) e.preventDefault();
    var container = $('.col-cards', e.currentTarget);
    if (!container) { clearDrag(); return; }
    var ph = ensurePh();
    if (ph.parentNode !== container) container.appendChild(ph);
    var idx = 0;
    for (var i = 0; i < container.children.length; i++) {
      var el = container.children[i];
      if (el === ph) break;
      if (el.classList && el.classList.contains('card')) idx++;
    }
    moveCard(drag.cardId, e.currentTarget.getAttribute('data-col'), idx);
    clearDrag();
  }

  /* 把卡片移动到 toColId 列内第 toIndex 个位置（含跨列与列内重排） */
  function moveCard(cardId, toColId, toIndex) {
    var board = activeBoard();
    if (!board) return;
    var card = findCard(board, cardId);
    if (!card) return;
    board.cards.splice(board.cards.indexOf(card), 1);
    var members = [];
    board.cards.forEach(function (c) { if (c.columnId === toColId) members.push(c); });
    var idx = clamp(toIndex, 0, members.length);
    var insertAt;
    if (idx < members.length) insertAt = board.cards.indexOf(members[idx]);
    else insertAt = members.length
      ? board.cards.indexOf(members[members.length - 1]) + 1
      : board.cards.length;
    board.cards.splice(insertAt, 0, card);
    card.columnId = toColId;
    commit();
  }

  /* 卡片上的 ←/→（窄屏显示为 ↑/↓）跨列移动按钮 */
  function moveByButton(cardId, dir) {
    var board = activeBoard();
    if (!board) return;
    var card = findCard(board, cardId);
    if (!card) return;
    var idx = -1;
    board.columns.forEach(function (c, i) { if (c.id === card.columnId) idx = i; });
    var target = board.columns[idx + dir];
    if (!target) {
      toast(dir < 0 ? '已经在第一列了' : '已经在最后一列了', 'warn');
      return;
    }
    moveCard(cardId, target.id, cardsOfColumn(board, target.id).length);
  }

  /* ==================== 渲染 ==================== */

  function commit() { save(); render(); }

  function render() {
    var board = activeBoard();
    if (board && state.activeBoardId !== board.id) state.activeBoardId = board.id;
    var hasBoard = !!board;
    $('#boardbar').hidden = !hasBoard;
    $('#filterbar').hidden = !hasBoard;
    $('#statsbar').hidden = !hasBoard;
    $('#board').hidden = !hasBoard;
    $('#empty-boards').hidden = hasBoard;
    renderTabs();
    if (hasBoard) {
      renderBoardArea(board);
      renderStats(board);
    }
  }

  function renderTabs() {
    var nav = $('#board-tabs');
    nav.innerHTML = '';
    state.boards.forEach(function (b) {
      var active = b.id === state.activeBoardId;
      nav.appendChild(h('button', {
        class: 'tab' + (active ? ' active' : ''),
        type: 'button',
        'aria-current': active ? 'page' : 'false',
        title: '切换到「' + b.name + '」',
        onclick: function () {
          if (state.activeBoardId === b.id) return;
          state.activeBoardId = b.id;
          commit();
        }
      }, [b.name]));
    });
  }

  function renderBoardArea(board) {
    $('#board-name').textContent = board.name;
    var doneIds = doneColumnIds(board);
    var today = todayKey();
    var boardEl = $('#board');
    boardEl.innerHTML = '';
    if (!board.columns.length) {
      boardEl.appendChild(h('div', { class: 'board-empty-cols' }, [
        h('p', { text: '这个看板还没有列，先添加一列吧。' })
      ]));
    }
    board.columns.forEach(function (col, idx) {
      boardEl.appendChild(buildColumn(board, col, idx, today, doneIds));
    });
    if (board.columns.length < MAX_COLUMNS) {
      boardEl.appendChild(h('div', { class: 'add-column' }, [
        h('button', { class: 'add-column-btn', type: 'button', onclick: addColumnDialog }, ['＋ 新增列'])
      ]));
    }
    var fa = filterActive();
    var vis = board.cards.filter(function (c) { return cardMatches(c, doneIds, today); }).length;
    $('#f-reset').hidden = !fa;
    var summary = $('#filter-summary');
    summary.hidden = !fa;
    if (fa) summary.textContent = '显示 ' + vis + ' / ' + board.cards.length + ' 张卡片';
  }

  function buildColumn(board, col, colIdx, today, doneIds) {
    var all = cardsOfColumn(board, col.id);
    var visible = all.filter(function (c) { return cardMatches(c, doneIds, today); });
    var countText = filterActive() ? visible.length + '/' + all.length : String(all.length);

    var cardsEl = h('div', { class: 'col-cards', 'data-col': col.id });
    if (!all.length) cardsEl.appendChild(h('p', { class: 'col-empty-note', text: '暂无卡片' }));
    visible.forEach(function (card) { cardsEl.appendChild(buildCard(board, card, colIdx, today, doneIds)); });

    var colEl = h('section', {
      class: 'column' + (col.isDone ? ' col-done' : ''),
      'data-col': col.id
    }, [
      h('header', { class: 'col-head' }, [
        h('h3', { class: 'col-name' }, [
          col.name + ' ',
          h('span', { class: 'col-count', text: countText })
        ]),
        h('button', {
          class: 'icon-btn col-menu-btn', type: 'button',
          'aria-label': '列操作：「' + col.name + '」', title: '列操作',
          onclick: function (e) { e.stopPropagation(); toggleColMenu(colEl, board, col); }
        }, ['⋯'])
      ]),
      cardsEl,
      h('button', {
        class: 'add-card-btn', type: 'button',
        onclick: function () { openCardEditor(board.id, col.id, null); }
      }, ['＋ 添加卡片'])
    ]);
    colEl.addEventListener('dragover', onColDragOver);
    colEl.addEventListener('drop', onColDrop);
    return colEl;
  }

  function buildCard(board, card, colIdx, today, doneIds) {
    var over = isOverdue(card, doneIds, today);
    var soon = !over && !!card.due && card.due >= today && card.due <= addDays(today, 3);

    var chips = h('div', { class: 'card-labels' });
    card.labels.forEach(function (lid) {
      var l = LABEL_MAP[lid];
      if (!l) return;
      chips.appendChild(h('span', {
        class: 'chip',
        style: 'background:' + l.color + '1f;color:' + l.color
      }, [l.name]));
    });

    var meta = h('div', { class: 'card-meta' }, [
      h('span', { class: 'badge p-' + card.priority, text: PRIORITY_NAME[card.priority] })
    ]);
    if (card.due) {
      var dueText = card.due === today ? '今天截止' : (over ? '逾期 ' : '') + fmtDue(card.due);
      meta.appendChild(h('span', {
        class: 'due' + (over ? ' over' : soon ? ' soon' : ''),
        text: dueText
      }));
    }
    if (card.subtasks.length) {
      var done = card.subtasks.filter(function (s) { return s.done; }).length;
      meta.appendChild(h('span', { class: 'subs' }, [
        '☑ ' + done + '/' + card.subtasks.length,
        h('span', { class: 'mini-bar' }, [
          h('i', { style: 'width:' + Math.round((done / card.subtasks.length) * 100) + '%' })
        ])
      ]));
    }

    var cardEl = h('article', {
      class: 'card',
      draggable: 'true',
      'data-id': card.id,
      title: card.desc || card.title
    }, [
      h('div', { class: 'card-top' }, [
        chips,
        h('div', { class: 'card-move' }, [
          h('button', {
            class: 'mv', type: 'button',
            title: '移到上一列', 'aria-label': '移到上一列',
            disabled: colIdx <= 0 ? 'disabled' : null,
            onclick: function (e) { e.stopPropagation(); moveByButton(card.id, -1); }
          }, [h('span', { class: 'arr', text: '←' })]),
          h('button', {
            class: 'mv', type: 'button',
            title: '移到下一列', 'aria-label': '移到下一列',
            disabled: colIdx >= board.columns.length - 1 ? 'disabled' : null,
            onclick: function (e) { e.stopPropagation(); moveByButton(card.id, 1); }
          }, [h('span', { class: 'arr', text: '→' })])
        ])
      ]),
      h('h4', { class: 'card-title', text: card.title }),
      card.desc ? h('p', { class: 'card-desc', text: card.desc }) : null,
      meta
    ]);

    cardEl.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.card-move')) return;
      openCardEditor(board.id, card.columnId, card.id);
    });
    cardEl.addEventListener('dragstart', onCardDragStart);
    cardEl.addEventListener('dragend', function () { clearDrag(); });
    return cardEl;
  }

  function renderStats(board) {
    var s = computeStats(board);
    var bar = $('#statsbar');
    bar.innerHTML = '';
    bar.appendChild(h('div', { class: 'stat' }, [
      h('span', { class: 'stat-label', text: '各列卡片' }),
      h('div', { class: 'stat-cols-row' },
        s.perColumn.map(function (c) {
          return h('span', { class: 'stat-col' + (c.isDone ? ' done' : '') }, [
            c.name, h('b', { text: String(c.count) })
          ]);
        }))
    ]));
    bar.appendChild(h('div', { class: 'stat', title: '今天到本周日之间到期、且未完成的卡片' }, [
      h('span', { class: 'stat-label', text: '本周到期' }),
      h('b', { text: String(s.week) })
    ]));
    bar.appendChild(h('div', { class: 'stat', title: '截止日期早于今天且未完成的卡片' }, [
      h('span', { class: 'stat-label', text: '逾期' }),
      h('b', { class: s.over ? 'stat-danger' : null, text: String(s.over) })
    ]));
    bar.appendChild(h('div', { class: 'stat', title: '完成列卡片数 / 全部卡片数' }, [
      h('span', { class: 'stat-label', text: '完成率' }),
      h('b', { text: s.rate === null ? '—' : s.rate + '%' }),
      h('span', { class: 'mini-bar' }, [h('i', { style: 'width:' + (s.rate || 0) + '%' })])
    ]));
    if (filterActive()) {
      bar.appendChild(h('span', { class: 'stat-note', text: '统计为整板数据，不受筛选影响' }));
    }
  }

  /* ==================== 导入 / 导出 ==================== */

  function exportData() {
    if (!state.boards.length) {
      toast('当前没有可导出的数据', 'warn');
      return;
    }
    var payload = {
      app: 'kanban-board',
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      boards: state.boards,
      activeBoardId: state.activeBoardId
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: 'kanban-' + todayKey() + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast('已导出全部看板数据', 'ok');
  }

  function handleImportText(txt) {
    var data = null;
    try {
      data = JSON.parse(String(txt).replace(/^\uFEFF/, ''));
    } catch (e) {
      toast('导入失败：不是合法的 JSON 文件', 'error');
      return;
    }
    var st = sanitizeState(data);
    if (!st) {
      toast('导入失败：文件不符合看板数据格式', 'error');
      return;
    }
    var cardCount = st.boards.reduce(function (n, b) { return n + b.cards.length; }, 0);
    confirmDialog({
      title: '导入并覆盖当前数据？',
      message: '将导入 ' + st.boards.length + ' 个看板 / ' + cardCount + ' 张卡片，当前全部数据会被覆盖。',
      confirmText: '导入'
    }).then(function (ok) {
      if (!ok) return;
      state = st;
      save();
      render();
      toast('导入成功：' + st.boards.length + ' 个看板 / ' + cardCount + ' 张卡片', 'ok');
    });
  }

  /* ==================== 提示 ==================== */

  function toast(msg, type) {
    var root = $('#toast-root');
    var t = h('div', { class: 'toast' + (type ? ' ' + type : ''), role: 'status', text: msg });
    root.appendChild(t);
    while (root.children.length > 4) root.firstElementChild.remove();
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 350);
    }, 2600);
  }

  /* ==================== 事件接线与初始化 ==================== */

  function wireEvents() {
    $('#btn-new-board').addEventListener('click', newBoardDialog);
    $('#btn-new-board-2').addEventListener('click', newBoardDialog);
    $('#btn-rename-board').addEventListener('click', renameBoardDialog);
    $('#btn-delete-board').addEventListener('click', deleteBoardDialog);
    $('#btn-export').addEventListener('click', exportData);

    var fileInput = $('#import-file');
    $('#btn-import').addEventListener('click', function () {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { handleImportText(String(reader.result)); };
      reader.onerror = function () { toast('读取文件失败', 'error'); };
      reader.readAsText(file, 'utf-8');
    });

    $('#f-q').addEventListener('input', function () { filter.q = this.value; render(); });
    $('#f-label').addEventListener('change', function () { filter.label = this.value; render(); });
    $('#f-priority').addEventListener('change', function () { filter.priority = this.value; render(); });
    $('#f-overdue').addEventListener('change', function () { filter.overdue = this.value; render(); });
    $('#f-reset').addEventListener('click', function () {
      filter = { q: '', label: '', priority: '', overdue: '' };
      $('#f-q').value = '';
      $('#f-label').value = '';
      $('#f-priority').value = '';
      $('#f-overdue').value = '';
      render();
    });

    /* 点击页面其他位置时收起列菜单 */
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.col-menu') && !e.target.closest('.col-menu-btn')) closeMenus();
    });
  }

  function init() {
    var labelSel = $('#f-label');
    LABELS.forEach(function (l) {
      labelSel.appendChild(h('option', { value: l.id }, [l.name]));
    });

    var loaded = loadState();
    state = loaded.state;
    if (loaded.status !== 'ok') save(); // 首次/损坏/存储不可用时也尝试立即落盘
    render();
    if (loaded.status === 'first') {
      toast('欢迎使用看板！已创建示例看板，可直接体验', 'ok');
    } else if (loaded.status === 'corrupted') {
      toast('本地数据已损坏，已重置为示例看板（原文备份于 ' + CORRUPT_KEY + '）', 'warn');
    } else if (loaded.status === 'unavailable') {
      toast('浏览器存储不可用，数据将不会保存', 'warn');
    }
    wireEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
