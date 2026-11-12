const app = document.querySelector('#app');
const dialog = document.querySelector('#modal');
const toast = document.querySelector('#toast');
const profile = document.querySelector('#profile');
const eventNavigation = document.querySelector('#event-navigation');
const eventTabs = document.querySelector('#event-tabs');
const query = new URLSearchParams(location.search);
const homeUrl = new URL('./', location.href);
const apiOrigin = document.querySelector('meta[name="majic-api"]')?.content;
const googleClient = document.querySelector('meta[name="majic-google-client"]')?.content;
const solo = googleClient !== undefined;
const hosted = apiOrigin !== undefined || solo;
let workspace;
const sessionKey = 'majic-session:' + homeUrl.pathname + ':' + apiOrigin;
let invitation = query.get('invite');
let user, eventId, board, stream, tab, toastTimer;
let routeVersion = 0;
let refreshVersion = 0;
let filters = {};
let events = [];
const statusLabels = {open:'Open',progress:'In progress',complete:'Complete'};
const views = {outstanding:'Outstanding',unclaimed:'Unclaimed',mine:'My tasks',progress:'In progress',complete:'Completed',all:'All tasks'};

function escape(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[char]);
}
function options(values, selected = '') {
  return values.map(([id,label]) => `<option value="${escape(id)}"${id === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
}
function button(label, action, style = '', key = '') {
  return `<button type="button" class="${style}" data-action="${action}" data-key="${escape(key)}">${label}</button>`;
}
function pickupCheckbox(task) {
  const checked = task.status === 'complete';
  return `<button type="button" class="check" role="checkbox" aria-checked="${checked}"
    data-action="${checked ? 'reopen' : 'complete'}" data-key="${task.id}">
    <span aria-hidden="true">${checked ? '☑' : '☐'}</span> Collected</button>`;
}
function dateLabel(event) {
  const format = date => new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(date));
  return [event.location, event.start && event.end && event.start !== event.end
    ? `${format(event.start)} – ${format(event.end)}` : (event.start || event.end) && format(event.start || event.end)]
    .filter(Boolean).map(escape).join(' · ');
}
async function api(path, data) {
  if (solo) return workspace.api(path,data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const session = hosted && localStorage.getItem(sessionKey);
    const response = await fetch((apiOrigin || '') + '/api/' + path, {
      signal: controller.signal,
      credentials: hosted ? 'omit' : 'same-origin',
      headers: {
        ...(session ? {Authorization:'Bearer '+session} : {}),
        ...(data === undefined ? {} : {'Content-Type':'application/json'})
      },
      ...(data === undefined ? {} : {
        method:'POST',body:JSON.stringify(data)
      })
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  } catch (error) {
    if (controller.signal.aborted || error instanceof TypeError) {
      throw new Error('Could not connect to the workspace. Check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function showToast(message, undo) {
  clearTimeout(toastTimer);
  toast.replaceChildren(document.createTextNode(message));
  toast.hidden = false;
  if (undo) {
    const control = document.createElement('button');
    control.textContent = 'Undo';
    control.addEventListener('click', async () => {
      control.disabled = true;
      try { await undo(); showToast('Task restored.'); }
      catch (error) { showToast(error.message); }
    });
    toast.append(control);
  }
  toastTimer = setTimeout(() => {toast.hidden = true;}, undo ? 20000 : 5000);
}
function showDialog(title, fields, submit, label = 'Save', extra = '') {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="row dialog-head"><h2 id="dialog-title">${escape(title)}</h2>
    ${button('Close','close','ghost')}</div>${submit ? `<form>${fields}<p class="error" role="alert"></p>
    <div class="dialog-actions">${extra}<button type="submit" class="primary">${label}</button></div></form>` : fields}`;
  dialog.showModal();
  const form = dialog.querySelector('form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('[type=submit]');
    submitButton.disabled = true;
    form.querySelector('.error').textContent = '';
    try {
      await submit(Object.fromEntries(new FormData(form)));
      if (form.isConnected) dialog.close();
    } catch (error) {
      form.querySelector('.error').textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}
function renderIdentity() {
  if (solo) {
    profile.innerHTML = user ? button('Connect Google','google-connect','ghost') : '';
    return;
  }
  profile.innerHTML = user ? `<div class="identity" title="${escape(user.name)}"><span class="avatar">${escape(user.name.slice(0,2).toUpperCase())}</span><span class="display-name">${escape(user.name)}</span></div>` : '';
}
function renderSignin() {
  if (solo) {
    app.innerHTML = `<section class="panel welcome"><div class="title"><h1>Crew workspace</h1>
      <p class="muted">Use the same Google account on your computer and phone to open your private task boards.</p></div>
      ${button('Connect Google','google-connect','primary')}</section>`;
    return;
  }
  app.innerHTML = `<section class="panel welcome">
    <div class="title"><p class="eyebrow">Majic Productions</p><h1>${invitation ? 'Join the crew' : 'Crew workspace'}</h1>
    <p class="muted">${invitation ? 'Enter the name your crew knows you by to open the event board.' : 'Enter your name to create an event or join from an invitation link.'}</p></div>
    <form id="signin"><label>Your name<input name="name" autocomplete="name" maxlength="60" required placeholder="First and last name"></label>
    <button class="primary">${invitation ? 'Join event' : 'Continue'}</button><p class="error" role="alert"></p></form>
    </section>`;
}
async function join() {
  try {
    const joined = await api('join',{invite:invitation});
    history.replaceState(null,'',new URL('#'+joined.id,homeUrl));
  } catch (error) {
    history.replaceState(null,'',homeUrl);
    showToast(error.message);
  }
  invitation = null;
}
function eventCard(event) {
  return `<a class="panel event-link" href="#${event.id}">
    <span class="row"><span class="tag ${event.archived ? '' : 'open'}">${event.archived ? 'Archived' : 'Active'}</span><span class="arrow" aria-hidden="true">↗</span></span>
    <strong>${escape(event.name)}</strong>${dateLabel(event) ? `<span class="muted small">${dateLabel(event)}</span>` : ''}
  </a>`;
}
function renderEventNavigation() {
  eventNavigation.hidden = !user;
  if (!user) return;
  const home = eventNavigation.querySelector('.event-home');
  eventNavigation.querySelector('.new-event-tab').hidden = !eventId;
  if (eventId) home.removeAttribute('aria-current');
  else home.setAttribute('aria-current','page');
  const visible = events.filter(event => !event.archived || event.id === eventId);
  const markup = visible.map(event => `<a class="event-tab" href="#${event.id}"
    ${event.id === eventId ? 'aria-current="page"' : ''}>${escape(event.name)}${event.archived ? ' (archived)' : ''}</a>`).join('');
  if (eventTabs.dataset.markup === markup) return;
  eventTabs.innerHTML = markup;
  eventTabs.dataset.markup = markup;
  eventTabs.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function renderEvents() {
  const active = events.filter(event => !event.archived);
  const archived = events.filter(event => event.archived);
  app.innerHTML = `<div class="intro"><div class="title"><h1>Events</h1><p class="muted">Start a new event or choose an existing task board.</p></div>
    ${button('+ New Event','create-event','primary')}</div>
    <div class="section-head"><h2>Active events</h2><span class="muted small">${active.length} active</span></div>
    <div class="events">${active.map(eventCard).join('') || '<div class="panel empty">Create an event to start a task board, or open a crew invitation link.</div>'}</div>
    ${archived.length ? `<div class="section-head"><h2>Past events</h2></div><div class="events">${archived.map(eventCard).join('')}</div>` : ''}`;
}
function detailsFields(event = {}) {
  return `<label>Event name<input name="name" maxlength="100" required value="${escape(event.name)}" placeholder="e.g. Summer stage setup"></label>
    <label>Location <span class="small">(optional)</span><input name="location" maxlength="150" value="${escape(event.location)}" placeholder="Venue or address"></label>
    <div class="date-fields"><label>Start date<input name="start" type="date" value="${escape(event.start)}"></label>
    <label>End date<input name="end" type="date" value="${escape(event.end)}"></label></div>`;
}
function memberName(id) {
  return escape(board.members.find(member => member.id === id)?.name || (id ? 'Former crew member' : ''));
}
function taskCard(task) {
  const category = board.categories.find(item => item.id === task.category);
  const completed = task.status === 'complete';
  const pickup = task.kind === 'pickup';
  const canRelease = task.assignee === user.id || board.event.role === 'manager';
  const stamp = task.completed_at ? new Date(task.completed_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const key = task.id;
  const controls = pickup ? pickupCheckbox(task) : completed
    ? button('Reopen','reopen','ghost',key)
    : (task.status === 'open' ? button('Claim','claim','',key) : canRelease ? button('Release','release','ghost',key) : '')
      + button('Complete','complete','ghost',key);
  return `<article class="panel task"><div>
    <span class="tag ${task.status}"><i></i>${pickup ? completed ? 'Collected' : 'Outstanding' : statusLabels[task.status]}</span>
    ${pickup ? '' : `<span class="tag">${escape(category?.name)}</span>`}
    <h3>${escape(task.description)}</h3>
    ${completed ? `<p class="small muted">${pickup ? 'Collected' : 'Completed'} by ${escape(task.completed_name)} · ${escape(stamp)}</p>`
      : task.assignee ? `<p class="small muted">${memberName(task.assignee)}</p>` : ''}
    </div>${board.event.archived ? '' : `<div class="actions">${controls}${button('Edit','edit-task','ghost',key)}</div>`}</article>`;
}
function quickEntry(pickup) {
  const noun = pickup ? 'Pickup item' : 'Task description';
  return `<form class="quick" id="${pickup ? 'quick-pickup' : 'quick-task'}">
    <input name="description" aria-label="${noun}" placeholder="${pickup ? 'Add an item to pick up…' : 'What needs to get done?'}" maxlength="500" required>
    <button class="primary">${pickup ? '+ Add Item' : '+ Add Task'}</button></form>`;
}
function renderBoard() {
  const event = board.event;
  app.innerHTML = `<div class="intro"><div class="title"><p class="eyebrow">${event.archived ? 'Archived event' : 'Event workspace'}</p>
    <h1 id="event-name">${escape(event.name)}</h1><p class="muted" id="event-meta">${dateLabel(event)}</p></div>
    <span id="live" class="live" role="status">Connecting</span></div>
    <nav class="tabs" aria-label="Event views">
    ${[['tasks','Task Board'],['shop','Shop Runs'],['settings','Event Settings']].map(([key,label]) =>
      `<button type="button" data-action="tab" data-key="${key}"${tab === key ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
    <div id="view" class="stack"></div>`;
  const view = app.querySelector('#view');
  if (tab === 'tasks') {
    view.innerHTML = `<div class="metrics" id="metrics"></div>
      ${event.archived ? '' : `<div>${quickEntry(false)}${button('Task details','new-task','ghost small')}</div>`}
      <div class="filters">
      <label>Search<input id="search" type="search" placeholder="Search tasks" value="${escape(filters.search)}"></label>
      <label>Status<select id="status">${options(Object.entries(views),filters.status)}</select></label>
      <label>Category<select id="category"></select></label>
      <label>Sort<select id="sort">${options([['status','Status'],['recent','Newest first'],['oldest','Oldest first'],['category','Category']],filters.sort)}</select></label>
      </div><div class="section-head"><h2 id="list-title"></h2><span id="count" class="muted small"></span></div><div id="task-list" class="stack"></div>`;
  }
  if (tab === 'shop') {
    view.innerHTML = `<div id="runner"></div>${event.archived ? '' : quickEntry(true)}
      <div id="pickup-lists" class="stack"></div>`;
  }
  paintLive(stream?.readyState === EventSource.OPEN);
  updateBoard();
}
function paintLive(online) {
  const indicator = document.querySelector('#live');
  if (indicator) {
    indicator.dataset.live = online ? 'online' : 'offline';
    indicator.textContent = online ? 'Live updates' : 'Reconnecting';
  }
}
function updateBoard() {
  document.querySelector('#event-name').textContent = board.event.name;
  document.querySelector('#event-meta').innerHTML = dateLabel(board.event);
  if (tab === 'settings') return renderSettings();
  if (tab === 'shop') {
    const runner = board.event.runner;
    const release = runner && (runner === user.id || board.event.role === 'manager');
    document.querySelector('#runner').innerHTML = `<section class="panel row wrap"><div class="title"><h2>Shop Run</h2>
      <p class="muted">${runner ? `Claimed by ${memberName(runner)}` : 'No runner assigned'}</p></div>
      ${board.event.archived ? '' : release ? button('Release Run','run-release') : runner ? '' : button('Claim Run','run-claim','primary')}</section>`;
    const items = board.tasks.filter(task => task.kind === 'pickup');
    document.querySelector('#pickup-lists').innerHTML = [['Outstanding',items.filter(task => task.status !== 'complete')],['Collected',items.filter(task => task.status === 'complete')]]
      .map(([title,list]) => `<section><div class="section-head"><h2>${title}</h2><span class="muted small">${list.length} ${list.length === 1 ? 'item' : 'items'}</span></div>
        <div class="stack">${list.map(taskCard).join('') || `<div class="panel empty">${title === 'Outstanding' ? 'No pickups waiting.' : 'No items collected yet.'}</div>`}</div></section>`).join('');
    return;
  }
  const tasks = board.tasks.filter(task => task.kind !== 'pickup');
  const outstanding = tasks.filter(task => task.status !== 'complete');
  const unclaimed = tasks.filter(task => task.status === 'open');
  const mine = outstanding.filter(task => task.assignee === user.id);
  const complete = tasks.filter(task => task.status === 'complete');
  document.querySelector('#metrics').innerHTML = [['outstanding','Outstanding',outstanding.length],['unclaimed','Unclaimed',unclaimed.length],['mine','My tasks',mine.length],['complete','Completed',complete.length]]
    .map(([key,label,count]) => `<button type="button" class="metric" data-action="status" data-key="${key}" aria-pressed="${filters.status === key}">
      <strong>${count}</strong><span>${label}</span></button>`).join('');
  const category = document.querySelector('#category');
  if (!board.categories.some(item => item.id === filters.category)) filters.category = '';
  const categoryOptions = options([['','All categories'],...board.categories.map(item => [item.id,item.name])],filters.category);
  if (category.dataset.options !== categoryOptions) {
    category.innerHTML = categoryOptions;
    category.dataset.options = categoryOptions;
  }
  const visible = ({outstanding,unclaimed,mine,progress:tasks.filter(task => task.status === 'progress'),
    complete,all:tasks})[filters.status]
    .filter(task => (!filters.category || task.category === filters.category) &&
      task.description.toLowerCase().includes(filters.search.trim().toLowerCase()));
  if (filters.sort === 'oldest') visible.reverse();
  if (filters.sort === 'status') {
    const rank = {open:0,progress:1,complete:2};
    visible.sort((a,b) => rank[a.status] - rank[b.status]);
  }
  if (filters.sort === 'category') {
    const names = new Map(board.categories.map(item => [item.id,item.name]));
    visible.sort((a,b) => names.get(a.category).localeCompare(names.get(b.category)));
  }
  document.querySelector('#list-title').textContent = views[filters.status];
  document.querySelector('#count').textContent = `${visible.length} ${visible.length === 1 ? 'task' : 'tasks'}`;
  const list = document.querySelector('#task-list');
  const markup = visible.map(taskCard).join('') || '<div class="panel empty">No tasks match this view.</div>';
  if (list.dataset.markup !== markup) {
    list.innerHTML = markup;
    list.dataset.markup = markup;
  }
}
function renderSettings() {
  const {event,categories,members} = board;
  const manager = event.role === 'manager';
  const editable = manager && !event.archived;
  document.querySelector('#view').innerHTML = `<section class="panel stack">
    <div class="row wrap"><h2>Event details</h2>${editable ? button('Edit Event','event-details') : ''}</div>
    <p class="muted">${dateLabel(event) || 'No location or dates entered.'}</p>
    ${manager ? `<div>${button(event.archived ? 'Restore Event' : 'Archive Event','archive','ghost')}</div>` : ''}
    </section><section class="panel stack"><div class="row wrap"><h2>Participants</h2>
    ${editable && !solo ? button('Create Invite Link','invite','primary') : ''}</div>
    ${members.map(member => `<div class="setting-row row"><span>${escape(member.name)} <span class="muted small">${member.role === 'manager' ? '· Manager' : ''}</span></span>
      ${editable && member.role === 'crew' ? button('Remove','remove','ghost danger',member.id) : ''}</div>`).join('')}</section>
    <section class="panel stack"><div class="row wrap"><h2>Categories</h2>${event.archived ? '' : button('+ Add Category','new-category')}</div>
    ${categories.map(category => `<div class="row setting-row"><span>${escape(category.name)}</span><span class="actions">
      ${event.archived ? '' : button('Rename','rename-category','ghost',category.id) + (category.kind === 'custom' ? button('Merge','merge-category','ghost',category.id) : '')}</span></div>`).join('')}</section>`;
}
async function refresh(target = eventId) {
  const version = ++refreshVersion;
  const next = await api('events/'+target);
  if (target !== eventId || version !== refreshVersion) return;
  const changedArchive = board && board.event.archived !== next.event.archived;
  board = next;
  events = events.map(event => event.id === target ? next.event : event);
  renderEventNavigation();
  if (changedArchive) renderBoard();
  else updateBoard();
}
function connect(target) {
  if (hosted) {
    let pending = false;
    const timer = setInterval(async () => {
      if (pending || document.hidden || target !== eventId) return;
      pending = true;
      try {
        await refresh(target);
        if (target === eventId) paintLive(true);
      } catch (error) {
        if (target !== eventId) return;
        paintLive(false);
        if ([401,404].includes(error.status)) {
          location.hash = '';
          showToast(error.message);
        }
      } finally {
        pending = false;
      }
    },solo ? 10000 : 4000);
    stream = {close: () => clearInterval(timer), readyState:EventSource.OPEN};
    paintLive(true);
    return;
  }
  stream = new EventSource(`/api/events/${target}/live`);
  stream.onopen = () => paintLive(true);
  stream.onerror = () => {
    paintLive(false);
    refresh(target).catch(error => {
      if ([401,404].includes(error.status) && target === eventId) {
        stream?.close();
        location.hash = '';
        showToast(error.message);
      }
    });
  };
  stream.onmessage = () => refresh(target).catch(error => {
    if (target === eventId) showToast(error.message);
  });
}
async function route() {
  const version = ++routeVersion;
  stream?.close();
  stream = null;
  if (dialog.open) dialog.close();
  eventId = location.hash.slice(1);
  board = null;
  tab = 'tasks';
  filters = {status:'outstanding',category:'',search:'',sort:'status'};
  app.innerHTML = '<p class="muted">Loading…</p>';
  app.setAttribute('aria-busy','true');
  renderEventNavigation();
  try {
    if (!user) renderSignin();
    else {
      const target = eventId;
      const [available, next] = await Promise.all([
        api('events'),
        target ? api('events/'+encodeURIComponent(target)).catch(error => error) : null
      ]);
      if (version !== routeVersion) return;
      events = available;
      renderEventNavigation();
      if (next instanceof Error) throw next;
      if (next) {
        board = next;
        renderBoard();
        connect(target);
      } else {
        renderEvents();
      }
    }
  } catch (error) {
    if (version === routeVersion) app.innerHTML = `<section class="panel empty"><p>${escape(error.message)}</p><a class="back" href="#">← All events</a>${button('Retry','retry')}</section>`;
  } finally {
    if (version === routeVersion) app.removeAttribute('aria-busy');
  }
}
async function mutate(path, data, target = eventId) {
  try {
    const result = await api(`events/${target}/${path}`,data);
    if (target === eventId) await refresh(target).catch(() => {});
    return result;
  } catch (error) {
    if (error.status === 409 && target === eventId) await refresh(target).catch(() => {});
    throw error;
  }
}
function taskEditor(task) {
  const pickup = task?.kind === 'pickup';
  const categories = board.categories.filter(item => !pickup || item.id === task.category);
  const selected = task?.category || categories.find(item => item.kind === 'general').id;
  const lockAssignment = task?.status === 'complete' || Boolean(task?.assignee && task.assignee !== user.id && board.event.role !== 'manager');
  showDialog(task ? pickup ? 'Edit pickup item' : 'Edit task' : 'Add task', `
    <label>Description<input name="description" required maxlength="500" value="${escape(task?.description)}"></label>
    <label>Category<select name="category">${options(categories.map(item => [item.id,item.name]),selected)}</select></label>
    ${pickup ? '' : `<label>Assigned to<select name="assignee"${lockAssignment ? ' disabled' : ''}>${options([['','Unassigned'],...board.members.map(member => [member.id,member.name])],task?.assignee || '')}</select></label>`}`,
    data => mutate('tasks/'+(task?.id || 'new'), task ? {...data,assignee:lockAssignment || pickup ? task.assignee : data.assignee,action:'edit',version:task.version} : data),
    task ? 'Save' : 'Add Task', task ? button('Delete','delete','danger ghost',task.id) : '');
  if (task) dialog.querySelector('[data-action=delete]').dataset.version = task.version;
}
async function copyInvite(input) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(input.value);
  } else {
    input.select();
    if (!document.execCommand('copy')) {
      showToast('Select and copy the invitation link.');
      return;
    }
  }
  showToast('Invitation copied.');
}

document.addEventListener('click',async event => {
  const control = event.target.closest('button[data-action]');
  if (!control) return;
  const {action,key} = control.dataset;
  const task = board?.tasks.find(item => item.id === key);
  const target = eventId;
  try {
    if (action === 'close') dialog.close();
    if (action === 'google-connect' || action === 'google-create') {
      control.disabled = true;
      const {found} = await workspace.connect(action === 'google-create');
      if (!found) {
        showDialog('Create your workspace',`<div class="stack"><p class="muted">Create a private Google Sheet to save your jobs and tasks.</p>
          ${button('Create Workspace','google-create','primary')}</div>`);
      } else {
        ({user} = await api('me'));
        renderIdentity();
        await route();
      }
    }
    if (action === 'retry') await route();
    if (action === 'tab') {tab = key; renderBoard();}
    if (action === 'status') {
      filters.status = key;
      document.querySelector('#status').value = key;
      updateBoard();
    }
    if (action === 'create-event') showDialog('New event',detailsFields(), async data => {
      const created = await api('events',data);
      location.hash = created.id;
    },'Create Event');
    if (action === 'new-task') taskEditor();
    if (action === 'edit-task' && task) taskEditor(task);
    if (task && ['claim','release','complete','reopen','delete'].includes(action)) {
      control.disabled = true;
      const result = await mutate('tasks/'+key,{action,version:action === 'delete' ? Number(control.dataset.version) : task.version});
      if (action === 'delete') {
        dialog.close();
        showToast('Task removed.',() => mutate('tasks/'+key,{action:'undo',version:result.version},target));
      }
    }
    if (action === 'run-claim' || action === 'run-release') {
      control.disabled = true;
      await mutate('run/'+action.slice(4),{});
    }
    if (action === 'event-details') showDialog('Edit event',detailsFields(board.event),data => mutate('settings/details',data));
    if (action === 'archive') {
      const archived = board.event.archived;
      showDialog(archived ? 'Restore event' : 'Archive event',
        `<p class="muted">${archived ? 'Move the event back to Active Events.' : 'Move the board to Past Events, freeze changes, and close existing invitation links.'}</p>`,
        () => mutate('settings/'+(archived ? 'restore' : 'archive'),{}),archived ? 'Restore Event' : 'Archive Event');
    }
    if (action === 'invite') {
      showDialog('Create invitation', '<p class="muted">Anyone with the link can join for seven days. Creating a link replaces the previous one.</p>',
        async () => {
          const {invite} = await mutate('settings/invite',{});
          const url = new URL(homeUrl);
          url.searchParams.set('invite',invite);
          showDialog('Share invitation',`<div class="stack"><label>Invitation link<input id="invite-link" readonly value="${escape(url.href)}"></label>
            ${button('Copy Link','copy','primary')}<p class="muted small">For phone access, open this app using the same network or public address the crew will use before creating a link.</p></div>`);
        },'Create Link');
    }
    if (action === 'copy') await copyInvite(dialog.querySelector('#invite-link'));
    if (action === 'remove') showDialog('Remove participant',
      `<p class="muted">Remove ${memberName(key)} from this event, release their outstanding work, and invalidate the current invitation link.</p>`,
      () => mutate('settings/remove',{user:key}),'Remove Participant');
    if (action === 'new-category' || action === 'rename-category') {
      const current = board.categories.find(item => item.id === key);
      showDialog(current ? 'Rename category' : 'Add category',
        `<label>Category name<input name="name" required maxlength="60" value="${escape(current?.name)}"></label>`,
        data => mutate('categories/'+(key || 'new'),data),current ? 'Rename' : 'Add Category');
    }
    if (action === 'merge-category') {
      const current = board.categories.find(item => item.id === key);
      showDialog('Merge category',`<p class="muted">Move all tasks in ${escape(current.name)} to the selected category and remove ${escape(current.name)}.</p>
        <label>Move tasks to<select name="target">${options(board.categories.filter(item => item.id !== key).map(item => [item.id,item.name]))}</select></label>`,
        data => mutate('categories/merge',{source:key,...data}),'Merge Category');
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    control.disabled = false;
  }
});
app.addEventListener('input',event => {
  if (event.target.id !== 'search') return;
  filters.search = event.target.value;
  updateBoard();
});
app.addEventListener('change',event => {
  if (!['status','category','sort'].includes(event.target.id)) return;
  filters[event.target.id] = event.target.value;
  updateBoard();
});
app.addEventListener('submit',async event => {
  const form = event.target;
  if (!['signin','quick-task','quick-pickup'].includes(form.id)) return;
  event.preventDefault();
  const control = form.querySelector('button');
  control.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'signin') {
      const signedIn = await api('signin',data);
      if (hosted && signedIn.session) localStorage.setItem(sessionKey,signedIn.session);
      user = signedIn.user;
      renderIdentity();
      if (invitation) await join();
      await route();
    } else {
      await mutate('tasks/new',{...data,pickup:form.id === 'quick-pickup'});
      const input = form.elements.description;
      if (input.value === data.description) input.value = '';
      if (window.matchMedia('(pointer:fine)').matches) input.focus();
    }
  } catch (error) {
    if (form.id === 'signin') form.querySelector('.error').textContent = error.message;
    else showToast(error.message);
  } finally {
    control.disabled = false;
  }
});
window.addEventListener('hashchange',route);
async function start() {
  try {
    if (solo) {
      if (!googleClient) throw new Error('Google sign-in has not been configured yet.');
      const {createSheetWorkspace} = await import('./sheets.mjs');
      workspace = createSheetWorkspace(googleClient);
      await workspace.load();
    } else if (hosted && !apiOrigin) throw new Error('The shared task server has not been connected yet.');
    ({user} = await api('me'));
    renderIdentity();
    if (user && invitation) await join();
    await route();
  } catch (error) {
    app.innerHTML = `<section class="panel welcome"><h1>Workspace unavailable</h1>
      <p class="muted">${escape(error.message)}</p><a class="button" href="">Reload workspace</a></section>`;
    app.removeAttribute('aria-busy');
  }
}
start();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(console.warn);
