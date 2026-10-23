/* THROWAWAY PROTOTYPE — one approved direction, in-memory fixtures only.
 * The external scene selector demonstrates states; it is not product UI.
 * No Her imports, network requests, localStorage, models, or external actions.
 */
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-7a8 8 0 1 1 18-3Z"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8 12 3Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/>',
  leaf: '<path d="M20 3c0 10-1 16-9 17-5 1-8-3-6-7S13 9 20 3Z"/><path d="M4 21c2-6 7-9 12-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  book: '<path d="M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1Zm0 0v15"/>',
  cup: '<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Zm12 1h2a3 3 0 1 1 0 6h-2M8 3v2m5-2v2"/>',
  dots: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  settings: '<path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 2 3 3 3-1 3 1 1 2 4-1v-3l2-2 3-1-1-4-3-1-1-3-4 1-3-2Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  file: '<path d="M6 2h8l5 5v15H6V2Zm8 0v6h5M9 13h7M9 17h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 3 4-5 5 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
const leafDrawing = '<svg viewBox="0 0 64 72" aria-hidden="true"><path d="M32 63V34m0 11C17 47 12 37 14 28c13-1 20 8 18 17Zm0-11c15 0 21-10 18-20-13 1-19 10-18 20Zm0 20c12 0 19-5 21-14-12-4-20 3-21 14ZM18 64h28M23 69h18"/></svg>';

const sceneGroups = [
  ['日常', [
    ['daily', '日常 · 接着聊', '默认画面。像平时一样输入一句话，或从左侧进入其他入口。'],
    ['daily-empty', '日常 · 还没说话', '没有历史消息时，只有一句轻声招呼和输入区。'],
    ['daily-loading', '日常 · 正在读取', '公共外壳保持稳定，目标内容区加载；此时不能发送。'],
    ['daily-error', '日常 · 读取失败', '读取失败不冒充空对话。点击“重新加载”仅恢复示例数据。'],
    ['daily-refresh', '日常 · 刷新失败', '保留已经看见的内容，明确标记尚未取得最新状态。'],
    ['no-model', '日常 · 尚未配置模型', '可以写草稿；发送不可用。设置里可模拟连接。'],
    ['pending', '日常 · 有事需要确认', '日常只显示通用提示。点击查看，才进入对应话题。'],
    ['stale', '日常 · 待处理已过期', '点“查看”后提示状态已经更新，不跳入空白话题。'],
  ]],
  ['生活话题', [
    ['topics', '话题 · 一起在做的事', '单列轻量话题卡，没有任务数量、完成率或旧测试对话分组。'],
    ['topics-empty', '话题 · 空列表', '没有预置卡片；点击“另开一个话题”，从空白开始。'],
    ['topics-loading', '话题 · 正在读取', '列表加载状态。'],
    ['topics-error', '话题 · 读取失败', '列表读取失败与空列表分别表达。'],
    ['topic', '话题 · 周末去哪儿', '直接显示具体话题标题。可以聊天、改名、查看详情或移入回收站。'],
    ['topic-empty', '话题 · 新话题', '不用先填任务表格或标题，第一句话会形成短标题。'],
    ['transfer', '话题 · 从日常单独聊', '预览少量相关对话，确认只衔接背景，不自动发消息。'],
    ['transfer-unknown', '话题 · 衔接结果待核实', '模拟提交后丢失回包：先核实同一次创建，不再次创建。'],
  ]],
  ['回复与按需办理', [
    ['replying', '回复 · 她正在回应', '回复是本地脚本。可以停止，也可以提交下一句体验排队。'],
    ['queued', '回复 · 接下来聊这句', '排队条目可撤销；停止后不会自动处理剩余消息。'],
    ['reply-failed', '回复 · 没有完成', '保留已经生成的内容，纯聊天可重试；不混同重新执行动作。'],
    ['attachment-error', '附件 · 文件状态变化', '失效附件留在原话题草稿里，明确标记并阻止发送。'],
    ['approval', '办理 · 等你确认', '准确预览这一步。拒绝单步、暂缓和取消分别作用于该事项。'],
    ['capability', '办理 · 连接未就绪', '业务已获准不代表浏览器能力已就绪；引导与复核均为演示。'],
    ['paused', '办理 · 暂缓在这里', '保留进展，等明确继续，不因切页自动续跑。'],
    ['failed', '办理 · 未能完成', '说明失败并保留已有结果；继续与重新生成不同。'],
    ['unknown', '办理 · 结果待核实', '没有普通重试按钮。核对后才能解除阻塞，不自动重放。'],
  ]],
  ['辅助页面', [
    ['memory', '记忆 · 尚未开放', '第三入口始终可点击，准确说明记忆能力未开放，不展示示例记忆。'],
    ['settings', '设置 · 模型与偏好', '独立居中面板。所有表单只影响本次原型，不写入 Her。'],
    ['trash', '回收站 · 有内容', '演示新话题的恢复与永久删除，不承载之前的旧测试对话。'],
    ['trash-empty', '回收站 · 空状态', '空回收站也有明确状态。'],
    ['startup-error', '启动 · 本地初始化失败', '初始化失败不能解释为没有历史，也不会执行重置。'],
  ]],
];
const scenes = Object.fromEntries(sceneGroups.flatMap(([, items]) => items.map(([key, title, description]) => [key, { title, description }])));
let uid = 0;
const makeMessage = (role, text, extra = {}) => ({ id: `m${++uid}`, role, text, ...extra });
function initialState() {
  return {
    page: 'daily', topicId: 'weekend', view: 'ready', scene: 'daily', menu: null, modal: null,
    configured: true, staleNotice: false, banner: '', transferOp: null,
    topics: [
      { id: 'weekend', title: '周末去哪儿', excerpt: '想找个有树、有水，能慢慢走的地方。', when: '今天', icon: 'leaf' },
      { id: 'book', title: '最近读的那本书', excerpt: '有一段话，读完还想再停一会儿。', when: '昨天', icon: 'book' },
      { id: 'time', title: '想留一点自己的时间', excerpt: '不用安排得很满，留一点空白就好。', when: '周三', icon: 'cup' },
    ],
    messages: {
      daily: [
        makeMessage('user', '今天下班后，绕远路走了一会儿。'),
        makeMessage('assistant', '听起来，今天终于有一小段时间不用赶路。\n\n那一路上，有什么让你多看了一眼吗？'),
      ],
      weekend: [
        makeMessage('user', '周末想出去走走，不想安排得太满。'),
        makeMessage('assistant', '那就把周末留松一点。\n\n找一段有树的路，走累了就坐下来喝点东西。你更想去河边，还是山脚下？'),
      ],
      book: [makeMessage('user', '这本书里有句话，我读了好几遍。'), makeMessage('assistant', '是哪一句？\n\n可以说给我听，也可以只聊聊它让你想到的事。')],
      time: [makeMessage('user', '最近想每天给自己留一点时间。'), makeMessage('assistant', '不用一开始就安排得很认真。\n\n如果今天只留二十分钟，你最想拿它做什么？')],
    },
    drafts: {}, files: {}, grants: {}, queues: {}, queuePaused: {}, runs: {}, workflow: {}, trash: [], scroll: {}, follow: {}, linked: {},
    settings: { gentleMotion: true, launch: false, shortcut: '⌘ ⇧ H', serviceName: '我的模型服务', model: '示例对话模型', prompt: '自然地接住日常交流，有温度，也有自己的判断。不急着给每件事找一个解决方案。', browsing: true, reading: true }, lastAction: '打开原型',
  };
}
let state = initialState();
let renderedThread = 'daily';
const timers = new Map();
let toastTimer;
const threadId = () => state.page === 'daily' ? 'daily' : state.page === 'topic' ? state.topicId : null;
const topicById = (id) => state.topics.find((topic) => topic.id === id);
const currentFiles = (id) => state.files[id] || [];
const currentGrants = (id) => state.grants[id] || [];
const captureTransfer = () => (state.messages.daily || []).filter((message) => !message.streaming).slice(-2).map(({role,text}) => ({role,text}));
const button = (label, action, css = 'outline-button', extra = '') => `<button class="${css}" data-action="${action}" ${extra}>${label}</button>`;
const dots = '<span class="typing" aria-label="正在回应"><i></i><i></i><i></i></span>';

function sidebar() {
  const selected = state.page === 'topic' ? 'topics' : state.page;
  return `<aside class="sidebar" aria-label="主要入口">
    <div class="companion-brand"><span class="avatar" role="img" aria-label="Samantha">她</span><div><div class="companion-name">Samantha</div><div class="companion-subtitle">你的私人伙伴</div></div></div>
    <nav class="main-nav" aria-label="主要页面">
      ${[['daily', 'chat', '日常'], ['topics', 'layers', '一起在做的事'], ['memory', 'leaf', '她记得的事']].map(([page, glyph, name]) => `<button class="nav-item" data-nav="${page}" ${selected === page ? 'aria-current="page"' : ''} aria-label="${name}">${icon(glyph)}<span>${name}</span></button>`).join('')}
    </nav>
    <div class="sidebar-bottom"><div class="sidebar-foot-row"><p class="sidebar-note">从这里回到日常<br>事情和记忆，都各有来处。</p><button class="icon-button sidebar-more" data-action="footer-menu" aria-label="更多入口" aria-expanded="${state.menu === 'footer'}">${icon('dots')}</button></div>
      ${state.menu === 'footer' ? `<div class="popover" role="menu">${button(`${icon('settings')} 设置`, 'settings', '', 'role="menuitem"')}${button(`${icon('trash')} 回收站`, 'trash', '', 'role="menuitem"')}</div>` : ''}
    </div>
  </aside>`;
}

function head(title, subtitle, right = '', back = false) {
  return `<header class="page-head"><div>${back ? `<button class="back-button" data-nav="topics">${icon('back')}一起在做的事</button>` : ''}<h1 id="page-title" tabindex="-1">${esc(title)}</h1><p>${esc(subtitle)}</p></div>${right}</header>`;
}

function headMenu() {
  return `<div class="head-actions"><button class="icon-button" data-action="head-menu" aria-label="话题操作" aria-expanded="${state.menu === 'head'}">${icon('dots')}</button>${state.menu === 'head' ? topicMenu(state.topicId) : ''}</div>`;
}
function topicMenu(id) {
  return `<div class="popover" role="menu">${button('重命名', 'rename', '', `role="menuitem" data-id="${id}"`)}${button('对话详情', 'details', '', `role="menuitem" data-id="${id}"`)}<div class="popover-separator"></div>${button('移入回收站', 'delete', 'danger', `role="menuitem" data-id="${id}"`)}</div>`;
}

function stateView(kind) {
  if (kind === 'loading') return `<div class="local-state" role="status"><div class="loading-wrap"><div class="loading-line"></div><div class="loading-line short"></div><p class="loading-caption">正在接上这段交流…</p></div></div>`;
  return `<div class="local-state" role="alert"><span class="state-mark">!</span><h2>${state.page === 'topics' ? '这次没能读到话题' : '这段对话暂时没能打开'}</h2><p>还不能确定里面的内容。可以重新读取，未发送的话会留在原处。</p>${button('重新加载', 'reload', 'primary-button')}</div>`;
}

function topicsPage() {
  const right = button(`${icon('plus')}另开一个话题`, 'new-topic');
  const header = head('一起在做的事', '有些事，可以慢慢一起聊。', right);
  if (['loading', 'error'].includes(state.view)) return `<main class="main">${header}${stateView(state.view)}</main>`;
  return `<main class="main">${header}<div class="view-body">${state.topics.length ? `<div class="topic-list">${state.topics.map((topic) => `<article class="topic-card">
      <button class="topic-card-main" data-open-topic="${topic.id}" aria-label="打开话题 ${esc(topic.title)}"><div class="topic-illustration">${icon(topic.icon || 'leaf')}</div><div class="topic-copy"><h2>${esc(topic.title)}</h2><p>${esc(topic.excerpt || '这段交流，还可以慢慢继续。')}</p><div class="topic-meta"><span>${esc(topic.when || '刚刚')}</span><span>接着聊 ${icon('chevron')}</span></div></div></button>
      <button class="icon-button topic-more" data-action="topic-menu" data-id="${topic.id}" aria-label="${esc(topic.title)}的更多操作">${icon('dots')}</button>${state.menu === `topic:${topic.id}` ? topicMenu(topic.id) : ''}
    </article>`).join('')}</div><p class="list-note">不必每件事都有结果。想起的时候，再回来接着聊。</p>` : `<section class="empty-list"><div class="quiet-illustration">${leafDrawing}</div><h2>还没有一起在做的事</h2><p>有想单独聊的事，可以放在这里。<br>不急，日常里的话也可以慢慢说。</p>${button(`${icon('plus')}另开一个话题`, 'new-topic', 'primary-button')}</section>`}</div></main>`;
}

function memoryPage() {
  return `<main class="main">${head('她记得的事', '关于你，关于我们聊过的那些事。')}<div class="view-body"><section class="memory-layout"><div class="memory-decoration">${leafDrawing}</div><div class="memory-card"><h2>记忆功能尚未开放</h2><p>这里会是查看与管理记忆的地方。<br>目前还不能长期记住、纠正或遗忘内容。</p><p class="memory-caption">日常聊天仍可以继续。记忆开放后，内容与来源也会清楚地放在这里。</p>${button('回到日常', 'back-daily')}</div></section></div></main>`;
}

function messagesHtml(id) {
  return (state.messages[id] || []).map((message) => `<article class="message ${message.role}" data-message-id="${message.id}">
    ${message.role === 'assistant' ? '<span class="avatar" role="img" aria-label="Samantha">她</span>' : ''}
    <div class="message-content"><div class="bubble">${message.text ? esc(message.text) : message.streaming ? dots : '这段回应停在了这里。'}</div>${message.failed ? `<div class="message-tools"><span>这次回应没有完成</span>${button('重新回应', 'retry-chat', 'text-button', `data-thread="${id}"`)}</div>` : message.stopped ? '<div class="message-tools">回应已停止，已有内容会保留。</div>' : ''}</div>
  </article>`).join('');
}

function pendingNotice() {
  const pending = Object.entries(state.workflow).find(([, value]) => ['approval', 'unknown', 'paused', 'failed'].includes(value));
  if (!pending && !state.staleNotice) return '';
  const needsApproval = state.staleNotice || pending?.[1] === 'approval';
  return `<div class="notice-card">${icon('info')}<p>${needsApproval ? '有一件事需要你确认' : '有一件事需要你处理'}</p>${button('查看', 'open-pending')}</div>`;
}

function workflowCard(id) {
  const value = state.workflow[id];
  if (value === 'approval') return `<section class="permission-card" aria-label="动作确认卡"><div class="permission-overline">${icon('leaf')}这一步，想先问问你</div><h3>保存这份周末散步清单？</h3><p>把刚才整理的想法保存到你选择的文件，之后可以再慢慢调整。</p><div class="preview-paper">沿河走一段，找一家小店喝茶。\n不赶时间，傍晚前回家。</div><div class="permission-meta">对象：周末散步清单.md（示例文件）<br>变化：写入上面展示的内容<br>范围：仅保存这份清单，不发送给其他人</div><div class="action-row" style="margin-top:16px">${button('确认保存这份清单', 'approve', 'primary-button')}${button('拒绝这一步', 'reject', 'quiet-button')}</div><details class="delegation-details"><summary>这件事的范围与其他操作</summary><p style="margin-top:9px">只整理和保存这份清单；预订、付款或外发消息另行确认。</p><div class="action-row">${button('暂缓这件事', 'pause-workflow', 'quiet-button')}${button('取消这件事', 'cancel-workflow', 'quiet-button')}</div></details></section>`;
  if (value === 'capability') return `<section class="state-inline"><h3>还差一个浏览器连接</h3><p>这件事的范围已经确认。要继续查看路线，还需要连接浏览器；已经聊到的内容都在这里。</p><div class="action-row">${button('查看连接指引', 'capability-guide')}${button('先继续聊', 'leave-capability', 'text-button')}</div></section>`;
  if (value === 'paused') return `<section class="state-inline"><h3>这件事先放在这里</h3><p>已有的想法和进展都留着。准备好了，再明确继续；切换页面不会让它自动开始。</p><div class="action-row">${button('继续这件事', 'resume-workflow')}${button('取消这件事', 'cancel-workflow', 'text-button')}</div></section>`;
  if (value === 'failed') return `<section class="state-inline warning"><h3>这一步暂时没能完成</h3><p>没有确认清单已经保存。已经整理的内容仍在，继续前会重新核对目标。</p><div class="action-row">${button('核对并继续', 'resume-workflow')}${button('查看过程', 'details', 'text-button', `data-id="${id}"`)}</div></section>`;
  if (value === 'unknown') return `<section class="state-inline warning"><h3>结果待核实</h3><p>刚才的保存操作可能已经发生，目前还不能确定。先到目标位置核对，避免重复写入。</p><label class="check-field"><input id="unknown-checked" type="checkbox">我已在目标位置核对或处理（原型演示）</label><div class="action-row"><button id="resolve-unknown" class="outline-button" data-action="resolve-unknown" disabled>已核对，解除阻塞</button></div><p class="small" style="margin-top:10px">解除阻塞不表示操作成功，也不会自动再做一次。</p></section>`;
  const finished = { saved: ['这份清单已在本次演示中保存', '这里只演示确认后的反馈，没有写入真实文件。'], rejected: ['好，这一步先不做', '保存步骤没有执行。我们仍可以继续聊周末的安排。'], cancelled: ['这件事已取消', '不会继续办理，已经发生的操作也不会因此撤销。'], resolved: ['已记录核对结果', '原动作仍保留结果未知的记录；继续时需要重新观察和确认。'] };
  if (finished[value]) return `<section class="state-inline"><h3>${finished[value][0]}</h3><p>${finished[value][1]}</p></section>`;
  return '';
}

function filesHtml(id) {
  const files = currentFiles(id);
  if (!files.length) return '';
  return `<div class="attachments" aria-label="待发送附件">${files.map((file) => `<div class="file-chip ${file.invalid ? 'invalid' : ''}">${file.url ? `<button data-action="preview-image" data-file="${file.id}" aria-label="预览 ${esc(file.name)}"><img alt="${esc(file.name)}" src="${file.url}"></button>` : file.demoImage ? '<span class="attachment-thumb-demo" aria-hidden="true">葉</span>' : icon('file')}<div><div class="file-chip-name">${esc(file.name)}</div><small>${file.invalid ? '文件已变化，请重新添加' : file.demoImage ? '示例图片' : '仅在当前话题'}</small></div><button class="icon-button" data-action="remove-file" data-file="${file.id}" aria-label="移除 ${esc(file.name)}">×</button></div>`).join('')}</div>${files.some((file) => file.invalid) ? '<p class="file-error" role="alert">有附件已变化，暂不能发送。移除后重新添加即可，其他内容会保留。</p>' : ''}`;
}

function composer(id) {
  const queue = state.queues[id] || [];
  const running = state.runs[id]?.status === 'running';
  const paused = state.queuePaused[id];
  const invalid = currentFiles(id).some((file) => file.invalid);
  const unavailable = !state.configured || ['loading', 'error', 'refresh-error'].includes(state.view);
  const hasInput = (state.drafts[id] || '').trim() || currentFiles(id).length;
  return `<div class="composer-area">
    ${queue.map((item) => `<div class="queued-strip"><span>接下来聊这句</span><span>${esc(item.text || '附上的资料')}</span>${button('撤销', 'cancel-queued', 'text-button', `data-id="${item.id}"`)}</div>`).join('')}
    ${paused && queue.length ? `<div class="queue-caption">${paused === 'stopped' ? '上一段回应已停止，后面的话还在等待。' : '后面的话暂未继续处理。'} ${button('继续接下来的话', 'resume-queue', 'text-button')}</div>` : ''}
    ${filesHtml(id)}
    <form class="composer" id="composer-form"><textarea id="composer" aria-label="消息" rows="2" placeholder="想说什么，就从这里开始…">${esc(state.drafts[id] || '')}</textarea><div class="composer-bottom"><button class="attachment-trigger" type="button" data-action="attachment-menu" aria-expanded="${state.menu === 'attach'}">${icon('plus')}文字与附件</button><div class="send-group"><span class="input-hint">Enter 发送</span>${running ? `<button class="stop-button" type="button" data-action="stop-reply"><i class="stop-square"></i>停止</button>` : ''}<button class="send-button" id="send-button" type="submit" aria-label="发送" ${!hasInput || invalid || unavailable ? 'disabled' : ''}>${icon('arrow')}</button></div></div></form>
    ${!state.configured ? `<p class="composer-note">先连接一个模型服务，就可以开始聊天。${button('去设置', 'settings', 'text-button')}</p>` : ''}
    ${state.menu === 'attach' ? `<div class="popover attachment-popover" role="menu">${button(`${icon('file')}选择图片或文件`, 'pick-files', '', 'role="menuitem"')}${button(`${icon('image')}添加一张示例图片`, 'demo-image', '', 'role="menuitem"')}${button(`${icon('file')}添加一份示例文档`, 'demo-file', '', 'role="menuitem"')}<div class="popover-separator"></div>${button(`${icon('lock')}查看当前资料授权`, 'file-access', '', 'role="menuitem"')}<p class="popover-note">仅在当前话题使用。原型不上传文件。</p></div>` : ''}
  </div>`;
}

function chatPage() {
  const id = threadId();
  const topic = topicById(id);
  const isDaily = state.page === 'daily';
  const title = isDaily ? '日常' : topic?.title || '新话题';
  const right = isDaily ? `<div class="head-actions"><button class="icon-button" data-action="details" data-id="daily" aria-label="对话详情">${icon('dots')}</button></div>` : headMenu();
  const header = head(title, isDaily ? '接着聊，就好。' : '这里的进展暂不能带回日常', right, !isDaily);
  if (['loading', 'error'].includes(state.view)) return `<main class="main">${header}${stateView(state.view)}${composer(id)}</main>`;
  const empty = !(state.messages[id] || []).length;
  return `<main class="main">${header}<div class="chat-scroll" id="chat-scroll" aria-label="聊天消息">
      ${state.view === 'refresh-error' ? `<div class="dismissible-banner" role="alert"><span>这次没能更新到最新内容，下面保留的是之前读到的记录。</span>${button('重新读取', 'reload', 'text-button')}</div>` : ''}
      ${state.banner ? `<div class="mini-banner">${esc(state.banner)}</div>` : ''}
      ${state.linked[id] ? '<div class="mini-banner">从日常接着聊 · 仅带入你确认的两段交流，没有自动发送新消息。</div>' : ''}
      ${empty ? `<div class="empty-chat"><p>${isDaily ? '我在，想说什么都可以。' : '这件事，我们从哪里开始？'}</p></div>` : `<div class="date-divider">今天</div>${messagesHtml(id)}`}
      ${isDaily ? pendingNotice() : workflowCard(id)}
      ${isDaily && !empty ? `<div class="transfer-invite">${icon('leaf')}有想单独聊的事 ${button('单独聊这件事', 'transfer', 'text-button')}</div>` : ''}
    </div><button class="jump-latest" id="jump-latest" data-action="jump-latest" hidden>回到最新</button>${composer(id)}</main>`;
}

function render() {
  const current = threadId();
  const oldEditor = document.activeElement?.id === 'composer';
  const cursor = oldEditor ? $('#composer')?.selectionStart : null;
  const area = $('#chat-scroll');
  if (area && renderedThread) state.scroll[renderedThread] = area.scrollTop;
  $('#app').innerHTML = state.view === 'startup-error' ? `<main class="boot-screen"><div><span class="avatar" aria-hidden="true">她</span><span class="wordmark">Her</span><h2>暂时没能打开本地资料</h2><p class="muted small" style="margin-top:10px">现有资料不会因此被清空。可以重新加载。</p>${button('重新加载', 'reload', 'primary-button')}</div></main>` : sidebar() + (state.page === 'memory' ? memoryPage() : state.page === 'topics' ? topicsPage() : chatPage());
  const nextArea = $('#chat-scroll');
  renderedThread = current;
  if (nextArea && current) {
    nextArea.scrollTop = state.follow[current] ? nextArea.scrollHeight : state.scroll[current] || 0;
    nextArea.addEventListener('scroll', () => {
      state.scroll[current] = nextArea.scrollTop;
      state.follow[current] = nextArea.scrollHeight - nextArea.clientHeight - nextArea.scrollTop < 70;
      $('#jump-latest').hidden = state.follow[current] || nextArea.scrollHeight <= nextArea.clientHeight;
    });
  }
  if (oldEditor && $('#composer') && !$('#dialog').open) {
    $('#composer').focus({ preventScroll: true });
    if (cursor !== null) $('#composer').setSelectionRange(cursor, cursor);
  }
  updateDemoState();
}

function updateDemoState() {
  $('#prototype-status').textContent = `${state.page === 'daily' ? '日常' : state.page === 'topics' ? '一起在做的事' : state.page === 'memory' ? '她记得的事' : topicById(state.topicId)?.title || '新话题'} · ${state.view === 'ready' ? '可交互' : state.view === 'loading' ? '正在读取' : state.view === 'startup-error' ? '初始化失败' : '读取失败'}`;
  $('#state-inspector').textContent = JSON.stringify({ 页面: state.page, 页面状态: state.view, 当前话题: threadId(), 话题数: state.topics.length, 草稿归属: Object.keys(state.drafts).filter((id) => state.drafts[id]), 附件归属: Object.fromEntries(Object.entries(state.files).filter(([, files]) => files.length).map(([id, files]) => [id, files.map((file) => file.name)])), 等待输入: Object.values(state.queues).reduce((n, items) => n + items.length, 0), 记忆: '尚未开放', 最近操作: state.lastAction }, null, 2);
}

function toast(text) {
  if (dialog.open) {
    dialog.querySelector('.dialog-toast')?.remove();
    const message = document.createElement('div');
    message.className = 'dialog-toast'; message.setAttribute('role', 'status'); message.textContent = text;
    dialog.appendChild(message); setTimeout(() => message.remove(), 4000);
    return;
  }
  const node = $('#toast');
  clearTimeout(toastTimer);
  node.textContent = text;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

function go(page, id) {
  const old = threadId();
  if (old && $('#chat-scroll')) state.scroll[old] = $('#chat-scroll').scrollTop;
  state.page = page;
  if (id) state.topicId = id;
  state.view = 'ready'; state.menu = null; state.banner = '';
  state.lastAction = `切换到${page === 'topic' ? topicById(id)?.title : page}`;
  render();
  $('#page-title')?.focus({ preventScroll: true });
}

function newTopic(title = '新话题', extra = {}) {
  const id = `topic-${++uid}`;
  const topic = { id, title, excerpt: '', when: '刚刚', icon: 'leaf', ...extra };
  state.topics.unshift(topic); state.messages[id] = [];
  return id;
}

function scriptedResponse(text) {
  if (/周末|旅行|出去|河边|山/.test(text)) return '那我们先不把行程排满。\n\n你更想去树多一点的地方，还是找个能坐很久的小店？';
  if (/书|读|句子/.test(text)) return '那句话好像让你多停留了一会儿。\n\n想说说它让你想到什么吗？不一定要有一个很完整的答案。';
  if (/累|难过|压力|烦|睡/.test(text)) return '今天可以先不用把所有事情都理清楚。\n\n我在这里，你想从哪一点说起，我们就从那里开始。';
  return '嗯，我在听。\n\n可以再说一点，也可以先停在这里，不着急。';
}

function runReply(id, text, existing) {
  const message = existing || makeMessage('assistant', '', { streaming: true });
  if (!existing) state.messages[id].push(message);
  const full = scriptedResponse(text);
  message.failed = false; message.stopped = false; message.streaming = true;
  const run = { status: 'running', full, messageId: message.id, userText: text };
  state.runs[id] = run;
  if (timers.has(id)) clearInterval(timers.get(id));
  timers.set(id, setInterval(() => {
    if (state.runs[id] !== run || run.status !== 'running') { clearInterval(timers.get(id)); timers.delete(id); return; }
    message.text = full.slice(0, message.text.length + 1);
    if (message.text.length >= full.length) {
      run.status = 'complete'; message.streaming = false;
      clearInterval(timers.get(id)); timers.delete(id);
      if (!state.queuePaused[id] && state.queues[id]?.length) {
        const next = state.queues[id].shift();
        appendSent(id, next.text, next.files);
      }
    }
    if (threadId() === id) {
      if (run.status === 'complete') render();
      else {
        const bubble = document.querySelector(`[data-message-id="${message.id}"] .bubble`);
        if (bubble) bubble.textContent = message.text;
        if (state.follow[id] && $('#chat-scroll')) $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
      }
    }
    updateDemoState();
  }, 75));
  if (threadId() === id) render();
}

function appendSent(id, text, files = []) {
  if (files.some((file) => file.invalid)) {
    (state.queues[id] ||= []).unshift({ id: `q${++uid}`, text, files });
    state.queuePaused[id] = 'source';
    if (threadId() === id) { render(); toast('这句附带的资料已变化，暂未继续处理。可以撤销后重新添加。'); }
    return;
  }
  state.messages[id] ||= [];
  const shown = text || (files.length ? '想给你看看这份资料。' : '');
  state.messages[id].push(makeMessage('user', shown + (files.length ? `\n\n[附上 ${files.map((file) => file.name).join('、')}]` : '')));
  const topic = topicById(id);
  if (topic) {
    if (topic.title === '新话题' && text.trim()) topic.title = text.trim().replace(/\s+/g, ' ').slice(0, 18);
    topic.excerpt = text.slice(0, 50) || '刚刚分享了一份资料。'; topic.when = '刚刚';
  }
  runReply(id, text);
}

function send() {
  const id = threadId();
  const text = (state.drafts[id] || '').trim();
  const files = [...currentFiles(id)];
  if (!id || !state.configured || state.view !== 'ready' || files.some((file) => file.invalid) || (!text && !files.length)) return;
  state.drafts[id] = ''; state.files[id] = []; state.follow[id] = true; state.menu = null;
  state.lastAction = '提交一句话（脚本模拟）';
  if (state.runs[id]?.status === 'running' || state.queuePaused[id]) {
    (state.queues[id] ||= []).push({ id: `q${++uid}`, text, files }); render();
  } else appendSent(id, text, files);
  $('#composer')?.focus({ preventScroll: true });
}

function stopReply() {
  const id = threadId(); const run = state.runs[id];
  if (!run || run.status !== 'running') return;
  clearInterval(timers.get(id)); timers.delete(id); run.status = 'stopped';
  const message = state.messages[id].find((item) => item.id === run.messageId);
  message.streaming = false; message.stopped = true;
  state.queuePaused[id] = 'stopped'; state.lastAction = '停止回应，保留已经生成的内容'; render();
  toast('这段回应已停下，已经说过的内容会保留。');
}

const dialog = $('#dialog');
function openDialog(type, id = threadId(), tab = 'models') {
  if (type === 'settings' && state.modal?.type !== 'settings') state.settingsDraft = { ...state.settings };
  state.menu = null; state.modal = { type, id, tab }; render();
  renderDialog();
  if (!dialog.open) dialog.showModal();
  if (type === 'rename') { $('#rename-title').focus(); $('#rename-title').select(); }
}
function closeDialog() { dialog.close(); state.modal = null; updateDemoState(); }
function modalHeader(title, subtitle = '') {
  return `<header class="modal-header"><div><h2 id="dialog-title">${title}</h2>${subtitle ? `<p class="modal-subtitle">${subtitle}</p>` : ''}</div><button class="icon-button" data-action="close-dialog" aria-label="关闭面板">×</button></header>`;
}

function settingsContent(tab) {
  const draft = state.settingsDraft || state.settings;
  if (tab === 'models') return `<h3>模型服务</h3><p>选一个熟悉的服务，继续和她聊。</p><div class="service-badge">${state.configured ? '示例服务已连接' : '尚未连接'}</div><label class="field" style="margin-top:18px">服务名称<input id="service-name" data-setting="serviceName" value="${esc(draft.serviceName)}" autocomplete="off"></label><label class="field">当前模型<select id="model-choice" data-setting="model">${['示例对话模型','另一个示例模型'].map((name)=>`<option ${draft.model===name?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">API Key<input type="password" placeholder="原型无需填写真实密钥" autocomplete="off"><small>此原型不发送或保存密钥。</small></label>${button(state.configured ? '保存示例配置' : '模拟连接服务', 'save-settings', 'primary-button')}`;
  if (tab === 'tools') return `<h3>工具连接</h3><p>需要帮你做具体的事时，再使用已连接的能力。</p><div class="setting-row"><span>浏览器<small>按需连接，不代表具体操作已获准</small></span>${button('查看指引', 'capability-guide', 'quiet-button')}</div><div class="setting-row"><span>资料读取<small>只读取你明确交给她的资料</small></span><span class="muted small">按需使用</span></div>`;
  if (tab === 'skills') return `<h3>技能</h3><p>帮助她理解怎样处理具体的事，不改变资料范围和行动许可。</p><div class="setting-row"><span>浏览网页<small>按需要使用</small></span><input type="checkbox" data-setting="browsing" ${draft.browsing?'checked':''} aria-label="浏览网页技能"></div><div class="setting-row"><span>阅读资料<small>内容与来源可以查看</small></span><input type="checkbox" data-setting="reading" ${draft.reading?'checked':''} aria-label="阅读资料技能"></div>${button('保存本次预览', 'save-preferences', 'outline-button', 'style="margin-top:20px"')}`;
  if (tab === 'files') return `<h3>资料授权</h3><p>移除输入区的附件不等于撤销访问。你可以在这里查看范围。</p><div class="mini-banner">本原型没有真实的文件授权，也不读取 Her 的权限记录。</div><div class="setting-row"><span>长期目录授权<small>目前没有示例授权</small></span><span class="small muted">未添加</span></div>`;
  if (tab === 'desktop') return `<h3>随时回来聊聊</h3><p>关闭窗口后留在菜单栏，需要时再唤出她。</p><div class="setting-row"><span>登录时启动<small>只影响本次演示开关</small></span><input type="checkbox" data-setting="launch" aria-label="登录时启动" ${draft.launch ? 'checked' : ''}></div><div class="setting-row"><span>轻柔过渡<small>跟随系统减少动态效果的偏好</small></span><input type="checkbox" data-setting="gentleMotion" aria-label="轻柔过渡" ${draft.gentleMotion?'checked':''}></div><label class="field" style="margin-top:18px">唤出快捷键<input data-setting="shortcut" value="${esc(draft.shortcut)}"></label>${button('保存本次预览', 'save-preferences')}`;
  return `<h3>系统提示词</h3><p>调整表达方式，仍然是与你相处的 Samantha。</p><label class="field">交流方式<textarea data-setting="prompt" rows="6">${esc(draft.prompt)}</textarea></label>${button('保存本次预览', 'save-preferences')}`;
}

function renderDialog() {
  if (!state.modal) return;
  const { type, id, tab } = state.modal;
  const topic = topicById(id) || state.trash.find((item) => item.id === id);
  dialog.className = 'modal-dialog';
  if (type === 'settings') {
    dialog.style.width = '720px';
    dialog.innerHTML = modalHeader('设置', '让这里更合你的习惯。') + `<div class="settings-grid"><nav class="settings-tabs" role="tablist" aria-label="设置类别">${[['models', '模型服务'], ['tools', 'MCP 工具'], ['skills', '技能'], ['files', '资料授权'], ['desktop', '桌面偏好'], ['prompt', '系统提示词']].map(([key, name]) => `<button role="tab" aria-selected="${tab === key}" data-settings-tab="${key}">${name}</button>`).join('')}</nav><section class="settings-content" role="tabpanel">${settingsContent(tab)}</section></div>`;
    return;
  }
  dialog.style.width = type === 'transfer' ? '620px' : '560px';
  if (type === 'rename') dialog.innerHTML = modalHeader('给这段话题换个名字') + `<div class="modal-body"><label class="field">话题名称<input id="rename-title" maxlength="80" value="${esc(topic?.title || '')}"></label><p class="dialog-note">改名不会改变已经聊过的内容。</p></div><div class="modal-footer">${button('取消', 'close-dialog', 'quiet-button')}${button('保存名称', 'save-rename', 'primary-button')}</div>`;
  if (type === 'delete') dialog.innerHTML = modalHeader('把这个话题放进回收站？') + `<div class="modal-body"><p class="modal-text">${esc(topic?.title)}</p><p class="modal-text">之后可以从回收站恢复。${state.runs[id]?.status === 'running' || state.workflow[id] ? '当前话题的办理会停止，等待的确认也会撤销；已经发生的操作不会撤销。' : '日常和其他话题不会受影响。'}</p></div><div class="modal-footer">${button('先留着', 'close-dialog', 'quiet-button')}${button('移入回收站', 'confirm-delete', 'danger-button')}</div>`;
  if (type === 'trash') dialog.innerHTML = modalHeader('回收站', '放在这里的话题，可以再找回来。') + `<div class="modal-body">${state.trash.length ? state.trash.map((item) => `<div class="trash-row"><div><strong>${esc(item.title)}</strong><small>${item.cleanupFailed ? '清理未完成，内容仍保留在回收站' : '本次演示中移入'}</small></div><div class="action-row">${button('恢复', 'restore', 'text-button', `data-id="${item.id}"`)}${button('永久删除', 'purge', 'text-button', `data-id="${item.id}"`)}</div></div>`).join('') + `<p class="dialog-note">恢复只恢复查看，不自动继续办理或重放旧确认。</p>` : '<div class="empty-list" style="padding:24px"><div class="quiet-illustration">'+icon('leaf')+'</div><h3>回收站是空的</h3><p>移入回收站的话题，会放在这里。</p></div>'}</div>${state.trash.length ? `<div class="modal-footer">${button('清空回收站', 'clear-trash', 'danger-button')}</div>` : ''}`;
  if (type === 'purge') dialog.innerHTML = modalHeader('永久删除后无法恢复') + `<div class="modal-body"><p class="modal-text">${id === 'all' ? '清空本次演示回收站里的所有话题。' : `永久删除“${esc(topic?.title)}”。`}</p><p class="dialog-note">只删除原型中的示例记录，不会删除磁盘文件或 Her 数据。</p></div><div class="modal-footer">${button('取消', 'trash', 'quiet-button')}${button('确认永久删除', 'confirm-purge', 'danger-button')}</div>`;
  if (type === 'details') dialog.innerHTML = modalHeader(id === 'daily' ? '对话详情' : esc(topic?.title || '对话详情'), '需要的时候，再看得更清楚一点。') + `<div class="modal-body"><div class="mini-banner">以下是原型示例状态，不代表 Her 正在运行这些任务。</div><dl class="details-list"><dt>模型与能力</dt><dd><select aria-label="当前模型" data-live-model="true" ${state.runs[id]?.status === 'running' ? 'disabled title="回应期间暂不能切换"' : ''}>${['示例对话模型','另一个示例模型'].map(name=>`<option ${state.settings.model===name?'selected':''}>${name}</option>`).join('')}</select></dd><dt>上下文</dt><dd>示例用量 1,240 / 128,000 tokens ${button('整理上下文', 'compact-demo', 'text-button')}</dd><dt>话题范围</dt><dd>${id === 'daily' ? '固定日常入口，普通生活交流留在这里。' : '资料只用于这个话题，进展共享暂未开放。'}</dd></dl><details class="delegation-details"><summary>原始工具与执行记录</summary><p style="margin-top:10px">此原型没有真实工具调用。需要办理时，相关确认会出现在对话旁边。</p></details></div>`;
  if (type === 'file-access') dialog.innerHTML = modalHeader('当前资料授权', '与输入区是否显示附件分别管理。') + `<div class="modal-body"><p class="modal-text">以下仅演示访问范围，不是真实系统权限。</p>${currentGrants(id).length ? currentGrants(id).map((file) => `<div class="setting-row"><span>${esc(file.name)}<small>${file.revoked ? '已撤销 · 原文件未删除' : '仅当前话题 · 演示引用'}</small></span>${button(file.revoked ? '已撤销' : '撤销', 'revoke-file', 'text-button', `data-file="${file.id}" ${file.revoked ? 'disabled' : ''}`)}</div>`).join('') : '<div class="mini-banner" style="margin-top:16px">当前没有示例资料授权。</div>'}<p class="dialog-note">撤销访问不会删除原文件；选中文件也不等于允许修改它。</p></div>`;
  if (type === 'capability') dialog.innerHTML = modalHeader('连接浏览器', '这件事获准了，能力也需要真正就绪。') + `<div class="modal-body"><p class="modal-text">连接后才能继续查看路线。打开设置或返回这个页面，不代表已经授予权限；会重新检查连接状态。</p><ol class="modal-text" style="padding-left:20px;margin-top:15px"><li>按指引建立浏览器连接。</li><li>回到这里，核对连接和当前目标。</li><li>范围没有变化时，再继续获准的部分。</li></ol><p class="dialog-note">演示按钮只切换原型状态，不会打开系统设置或连接浏览器。</p></div><div class="modal-footer">${button('以后再说', 'close-dialog', 'quiet-button')}${button('演示：连接就绪并复核', 'capability-ready', 'primary-button')}</div>`;
  if (type === 'transfer') {
    const selected = state.transferSelection || captureTransfer();
    const waiting = state.transferOp?.status === 'submitting';
    const unknown = state.transferOp?.status === 'unknown';
    dialog.innerHTML = modalHeader(unknown ? '还需要核实一下结果' : '把这件事单独聊聊', unknown ? '先查清同一次创建，不再创建一份。' : '只带上这几句话，其他日常留在原处。') + `<div class="modal-body">${unknown ? '<div class="mini-banner">确认已提交，但没有收到完整回包。话题可能已经创建，先核实结果。</div>' : ''}${selected.map((message) => `<blockquote class="transfer-quote">${esc(message.text)}<small>${message.role === 'user' ? '你' : 'Samantha'} · 来自日常 · 本次选定内容</small></blockquote>`).join('')}<div class="transfer-warning">${icon('info')}<span>只保存上面展示的背景，不自动发送新消息；不转移附件授权，也不形成长期记忆。</span></div></div><div class="modal-footer">${button(waiting || unknown ? '先回到日常' : '留在日常', 'close-dialog', 'quiet-button')}${unknown ? button('核实创建结果', 'verify-transfer', 'primary-button') : button(waiting ? '正在衔接…' : '确认并另开话题', 'confirm-transfer', 'primary-button', waiting ? 'disabled' : '')}</div>`;
  }
  if (type === 'image') {
    const file = currentFiles(id).find((entry) => entry.id === state.modal.fileId);
    dialog.innerHTML = modalHeader(esc(file?.name || '图片预览')) + `<div class="modal-body">${file?.url ? `<img class="dialog-image" alt="${esc(file.name)}" src="${file.url}">` : '<div class="empty-list">这是一张用于附件排版演示的图片占位。</div>'}</div>`;
  }
}

function addFiles(files) {
  const id = threadId(); if (!id) return;
  const added = Array.from(files).map((file) => ({ id: `f${++uid}`, name: file.name, url: /image\/(png|jpeg|gif|webp)/.test(file.type) && file.size <= 10 * 1024 * 1024 ? URL.createObjectURL(file) : null, invalid: file.size > 50 * 1024 * 1024 || (file.type.startsWith('image/') && file.size > 10 * 1024 * 1024), actual: file }));
  state.files[id] = [...currentFiles(id), ...added];
  state.grants[id] = [...currentGrants(id), ...added];
  state.lastAction = '添加本地附件引用（不上传）'; state.menu = null; render();
}

function createTransferResult() {
  const selected = state.transferSelection || captureTransfer();
  const first = selected.find((message) => message.role === 'user')?.text || '从日常接着聊';
  const id = newTopic(first.slice(0, 18), { excerpt: first.slice(0, 50) });
  state.messages[id] = selected.map((message) => makeMessage(message.role, message.text));
  state.linked[id] = true;
  return id;
}

function applyScene(key) {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
  if (dialog.open) dialog.close();
  state = initialState(); state.scene = key; state.lastAction = `切换演示：${scenes[key].title}`;
  $('#scene-picker').value = key;
  $('#scene-description').textContent = scenes[key].description;
  $('#scenes-panel').hidden = true; $('#scenes-toggle').setAttribute('aria-expanded', 'false');
  if (key.startsWith('topics')) { state.page = 'topics'; if (key === 'topics-empty') state.topics = []; }
  if (key === 'memory') state.page = 'memory';
  if (key === 'topic' || key === 'topic-empty' || ['approval', 'capability', 'paused', 'failed', 'unknown'].includes(key)) state.page = 'topic';
  if (key === 'daily-empty') state.messages.daily = [];
  if (key.endsWith('-loading')) state.view = 'loading';
  if (['daily-error', 'topics-error'].includes(key)) state.view = 'error';
  if (key === 'daily-refresh') state.view = 'refresh-error';
  if (key === 'no-model') state.configured = false;
  if (key === 'topic-empty') { const id = newTopic(); state.topicId = id; }
  if (key === 'pending') state.workflow.weekend = 'approval';
  if (key === 'stale') state.staleNotice = true;
  if (['approval', 'capability', 'paused', 'failed', 'unknown'].includes(key)) state.workflow.weekend = key;
  if (key === 'attachment-error') { const file = { id: 'changed-file', name: '周末想去的地方.txt', invalid: true }; state.files.daily = [file]; state.grants.daily = [file]; state.drafts.daily = '想给你看看这个。'; }
  if (key === 'reply-failed') state.messages.daily.push(makeMessage('assistant', '我们可以先把今天的节奏放慢一点。', { failed: true }));
  if (key === 'startup-error') state.view = 'startup-error';
  if (key === 'trash') { const topic = state.topics.pop(); state.trash.push(topic); }
  render();
  if (key === 'settings') openDialog('settings');
  if (key === 'trash' || key === 'trash-empty') openDialog('trash');
  if (key === 'transfer') { state.transferSelection = captureTransfer(); openDialog('transfer', 'daily'); }
  if (key === 'transfer-unknown') { state.transferSelection = captureTransfer(); const id = createTransferResult(); state.transferOp = { status: 'unknown', id }; openDialog('transfer', 'daily'); }
  if (key === 'replying' || key === 'queued') {
    runReply('daily', '今天有一点累。');
    if (key === 'queued') { state.queues.daily = [{ id: 'fixture-queued', text: '对了，想和你说说周末的打算。', files: [] }]; render(); }
  }
}

const actions = {
  'back-daily': () => go('daily'),
  'new-topic': () => { const id = newTopic(); go('topic', id); $('#composer')?.focus(); },
  'footer-menu': () => { state.menu = state.menu === 'footer' ? null : 'footer'; render(); },
  'head-menu': () => { state.menu = state.menu === 'head' ? null : 'head'; render(); },
  'topic-menu': (node) => { const key = `topic:${node.dataset.id}`; state.menu = state.menu === key ? null : key; render(); },
  'attachment-menu': () => { state.menu = state.menu === 'attach' ? null : 'attach'; render(); },
  'close-scenes': () => { $('#scenes-panel').hidden = true; $('#scenes-toggle').setAttribute('aria-expanded', 'false'); },
  reset: () => { applyScene('daily'); toast('已回到最初的示例。'); },
  reload: () => { state.view = 'ready'; state.lastAction = '重新读取示例内容（没有重发消息）'; render(); toast('已重新读到内容，没有重新发送消息。'); },
  settings: () => openDialog('settings'),
  trash: () => openDialog('trash'),
  rename: (node) => openDialog('rename', node.dataset.id),
  delete: (node) => openDialog('delete', node.dataset.id),
  purge: (node) => openDialog('purge', node.dataset.id),
  'clear-trash': () => openDialog('purge', 'all'),
  details: (node) => openDialog('details', node.dataset.id || threadId()),
  'file-access': () => openDialog('file-access'),
  'close-dialog': closeDialog,
  'save-rename': () => { const value = $('#rename-title').value.trim(); if (!value) { $('#rename-title').focus(); return; } const topic = topicById(state.modal.id); topic.title = value; topic.customTitle = true; state.lastAction = '重命名话题'; closeDialog(); render(); toast('名称已在本次预览中保存。'); },
  'confirm-delete': () => {
    const id = state.modal.id; const topic = topicById(id);
    state.trash.unshift({ ...topic, hadWorkflow: Boolean(state.workflow[id]) });
    state.topics = state.topics.filter((item) => item.id !== id);
    if (timers.has(id)) { clearInterval(timers.get(id)); timers.delete(id); }
    if (state.runs[id]) state.runs[id].status = 'stopped';
    state.queuePaused[id] = 'stopped'; delete state.workflow[id];
    closeDialog(); if (state.page === 'topic' && state.topicId === id) go('daily'); else render();
    toast('已移入本次预览的回收站，可以恢复。');
  },
  restore: (node) => { const index = state.trash.findIndex((item) => item.id === node.dataset.id); const [topic] = state.trash.splice(index, 1); state.topics.unshift(topic); if (topic.hadWorkflow) state.workflow[topic.id] = 'paused'; state.lastAction = '恢复话题，仅供查看'; render(); renderDialog(); toast('话题已恢复，不会自动继续办理。'); },
  'confirm-purge': () => { const id = state.modal.id; state.trash = id === 'all' ? [] : state.trash.filter((item) => item.id !== id); state.lastAction = '永久删除原型示例'; openDialog('trash'); toast('本次预览中的示例已删除。'); },
  'save-settings': () => { state.settings = { ...state.settingsDraft }; state.configured = true; state.lastAction = '保存原型示例配置'; render(); renderDialog(); toast('示例配置已生效，未修改 Her 设置。'); },
  'save-preferences': () => { state.settings = { ...state.settingsDraft }; state.lastAction = '保存原型面板偏好'; updateDemoState(); toast('仅保存到本次预览，刷新后重置。'); },
  'compact-demo': () => toast('原型仅演示整理入口，没有触发模型请求。'),
  'pick-files': () => { state.menu = null; render(); $('#file-picker').click(); },
  'demo-image': () => { const id = threadId(); const file = { id: `f${++uid}`, name: '路上那棵树.jpg', demoImage: true }; (state.files[id] ||= []).push(file); (state.grants[id] ||= []).push(file); state.menu = null; render(); },
  'demo-file': () => { const id = threadId(); const file = { id: `f${++uid}`, name: '周末的小打算.txt' }; (state.files[id] ||= []).push(file); (state.grants[id] ||= []).push(file); state.menu = null; render(); },
  'remove-file': (node) => { const id = threadId(); state.files[id] = currentFiles(id).filter((file) => file.id !== node.dataset.file); render(); toast('这次不发送该附件；没有删除原文件或撤销访问。'); },
  'preview-image': (node) => { const id = threadId(); state.modal = { type: 'image', id, fileId: node.dataset.file }; renderDialog(); dialog.showModal(); },
  'revoke-file': (node) => { const file = currentGrants(state.modal.id).find((item) => item.id === node.dataset.file); if (file) { file.invalid = true; file.revoked = true; } state.lastAction = '撤销示例资料引用'; render(); renderDialog(); toast('这份示例资料已不可继续发送；原文件未删除。'); },
  'stop-reply': stopReply,
  'cancel-queued': (node) => { const id = threadId(); const found = (state.queues[id] || []).some((item) => item.id === node.dataset.id); if (found) { state.queues[id] = state.queues[id].filter((item) => item.id !== node.dataset.id); render(); toast('这句已经撤回，不会接着处理。'); } else toast('这句已经开始处理，可以停止当前回应。'); },
  'resume-queue': () => { const id = threadId(); if (state.runs[id]?.status === 'running') return; state.queuePaused[id] = null; const next = state.queues[id]?.shift(); if (next) appendSent(id, next.text, next.files); },
  'retry-chat': () => { const id = threadId(); const message = state.messages[id].findLast((item) => item.failed || item.stopped); if (!message || state.runs[id]?.status === 'running') return; message.text = ''; runReply(id, state.messages[id].findLast((item) => item.role === 'user')?.text || '', message); },
  'open-pending': () => { if (state.staleNotice) { state.staleNotice = false; render(); toast('这件事的状态已更新。'); return; } const entry = Object.entries(state.workflow).find(([, value]) => ['approval', 'unknown', 'paused', 'failed'].includes(value)); if (entry) go('topic', entry[0]); },
  approve: () => { state.workflow[threadId()] = 'saved'; state.lastAction = '模拟批准一次保存'; render(); },
  reject: () => { state.workflow[threadId()] = 'rejected'; state.lastAction = '拒绝本次保存，其他讨论可继续'; render(); },
  'pause-workflow': () => { state.workflow[threadId()] = 'paused'; render(); },
  'cancel-workflow': () => { state.workflow[threadId()] = 'cancelled'; render(); },
  'resume-workflow': () => { state.workflow[threadId()] = 'approval'; render(); toast('已重新核对示例目标，需要新的单次确认。'); },
  'resolve-unknown': () => { if (!$('#unknown-checked')?.checked) return; state.workflow[threadId()] = 'resolved'; state.lastAction = '记录核对，未重放动作'; render(); },
  'capability-guide': () => openDialog('capability', state.modal?.id || threadId()),
  'leave-capability': () => { state.workflow[threadId()] = 'capability'; $('#composer')?.focus(); toast('可以继续聊天；需要浏览器的部分仍在等待连接。'); },
  'capability-ready': () => { const id = state.modal.id === 'daily' ? 'weekend' : state.modal.id; state.workflow[id] = 'approval'; closeDialog(); go('topic', id); toast('已模拟复核连接；这一步保存仍需独立确认。'); },
  transfer: () => { state.transferOp = null; state.transferSelection = captureTransfer(); openDialog('transfer', 'daily'); },
  'confirm-transfer': () => {
    if (state.transferOp?.status === 'submitting') return;
    const op = { status: 'submitting', id: null }; state.transferOp = op; renderDialog();
    setTimeout(() => {
      if (state.transferOp !== op) return;
      op.id = createTransferResult(); op.status = 'complete'; state.lastAction = '衔接背景成功，未发送新消息';
      if (state.modal?.type === 'transfer' && dialog.open) { closeDialog(); go('topic', op.id); toast('已经接上这几句话。想继续时，再说下一句。'); }
      else { render(); toast('话题已在本次预览中创建，可以从第二入口查看。'); }
    }, 450);
  },
  'verify-transfer': () => { const id = state.transferOp?.id; if (!id) return; state.transferOp.status = 'complete'; closeDialog(); go('topic', id); toast('核实：同一次话题已经创建，没有再建一份。'); },
  'jump-latest': () => { const id = threadId(); state.follow[id] = true; $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; },
};

document.addEventListener('click', (event) => {
  const node = event.target.closest('button');
  if (!node || node.disabled) return;
  if (node.dataset.nav) return go(node.dataset.nav);
  if (node.dataset.openTopic) return go('topic', node.dataset.openTopic);
  if (node.dataset.scene) return applyScene(node.dataset.scene);
  if (node.dataset.settingsTab) { state.modal.tab = node.dataset.settingsTab; renderDialog(); return; }
  const action = node.dataset.action;
  if (actions[action]) actions[action](node);
});
document.addEventListener('input', (event) => {
  if (event.target.dataset.setting) { state.settingsDraft[event.target.dataset.setting] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; return; }
  if (event.target.id !== 'composer') return;
  const id = threadId(); state.drafts[id] = event.target.value;
  const unavailable = !state.configured || state.view !== 'ready' || currentFiles(id).some((file) => file.invalid);
  $('#send-button').disabled = unavailable || (!event.target.value.trim() && !currentFiles(id).length);
  updateDemoState();
});
document.addEventListener('change', (event) => {
  if (event.target.dataset.liveModel) { state.settings.model = event.target.value; toast('仅切换本次预览的示例模型。'); }
  if (event.target.id === 'scene-picker') applyScene(event.target.value);
  if (event.target.id === 'file-picker') { addFiles(event.target.files); event.target.value = ''; }
  if (event.target.id === 'unknown-checked') $('#resolve-unknown').disabled = !event.target.checked;
});
document.addEventListener('submit', (event) => { if (event.target.id === 'composer-form') { event.preventDefault(); send(); } });
document.addEventListener('keydown', (event) => {
  if (event.target.id === 'composer' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); }
  if (event.key === 'Escape' && !dialog.open) { state.menu = null; $('#scenes-panel').hidden = true; $('#scenes-toggle').setAttribute('aria-expanded', 'false'); render(); }
  if (event.target.id === 'rename-title' && event.key === 'Enter') { event.preventDefault(); actions['save-rename'](); }
});
document.addEventListener('dragover', (event) => { if (event.target.closest('.composer-area')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (event.target.closest('.composer-area')) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
dialog.addEventListener('close', () => { if (!dialog.open) { state.modal = null; $('#page-title')?.focus({ preventScroll: true }); } updateDemoState(); });
dialog.addEventListener('click', (event) => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); });
$('#scenes-toggle').addEventListener('click', () => { const open = $('#scenes-panel').hidden; $('#scenes-panel').hidden = !open; $('#scenes-toggle').setAttribute('aria-expanded', String(open)); if (open) $('#scene-picker').focus(); });
$('#scene-picker').innerHTML = sceneGroups.map(([group, items]) => `<optgroup label="${group}">${items.map(([key, title]) => `<option value="${key}">${title}</option>`).join('')}</optgroup>`).join('');
$('#scene-description').textContent = scenes.daily.description;
render();
