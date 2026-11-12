const scopes = 'https://www.googleapis.com/auth/drive.file';
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets';
const drive = 'https://www.googleapis.com/drive/v3/files';
const defaults = ['General','Audio','Lighting','Video','Rigging','Scenic / Fabrication','Power','Logistics','Shop Runs','Other'];
const user = {id:'owner',name:'Me'};

function error(status, message) {
  return Object.assign(new Error(message),{status});
}

export function replay(rows) {
  const boards = new Map();
  const seen = new Set();
  const outcomes = new Map();
  for (const [serialized] of rows) {
    const entry = JSON.parse(serialized);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    try {
      outcomes.set(entry.id, apply(boards,entry));
    } catch (failure) {
      outcomes.set(entry.id,failure);
    }
  }
  return {boards,outcomes};
}

function apply(boards, {id,path,data,time}) {
  if (path === 'events') {
    const event = {id,...eventDetails(data),archived:0,runner:null,role:'manager'};
    const categories = defaults.map((name,index) => ({
      id:String(index),name,kind:index === 0 ? 'general' : name === 'Shop Runs' ? 'shop' : 'custom'
    }));
    boards.set(id,{event,categories,tasks:[],members:[{...user,role:'manager'}]});
    return {id};
  }
  const [,target,resource,key] = path.split('/');
  const board = boards.get(target);
  if (!board) throw error(404,'Event unavailable.');
  const {event,categories,tasks} = board;
  if (resource === 'settings' && ['archive','restore'].includes(key)) {
    event.archived = Number(key === 'archive');
    return {};
  }
  if (event.archived) throw error(409,'Restore this event to make changes.');
  if (resource === 'settings' && key === 'details') {
    Object.assign(event,eventDetails(data));
    return {};
  }
  if (resource === 'run' && ['claim','release'].includes(key)) {
    event.runner = key === 'claim' ? user.id : null;
    return {};
  }
  if (resource === 'categories') {
    if (key === 'merge') {
      const source = categories.find(item => item.id === data.source);
      if (source?.kind !== 'custom' || data.source === data.target || !categories.some(item => item.id === data.target)) {
        throw error(400,'Choose a custom category and a different destination.');
      }
      for (const task of tasks.filter(item => item.category === data.source)) {
        task.category = data.target;
        task.version++;
      }
      categories.splice(categories.indexOf(source),1);
    } else {
      const name = data.name.trim();
      if (!name || categories.some(item => item.id !== key && item.name.toLowerCase() === name.toLowerCase())) {
        throw error(409,'Enter a unique category name.');
      }
      if (key === 'new') categories.push({id,name,kind:'custom'});
      else {
        const category = categories.find(item => item.id === key);
        if (!category) throw error(404,'Category unavailable.');
        category.name = name;
      }
    }
    return {};
  }
  if (resource !== 'tasks') throw error(404,'Action unavailable.');
  if (key === 'new') {
    const kind = data.pickup ? 'pickup' : 'task';
    const category = data.pickup ? categories.find(item => item.kind === 'shop').id : data.category || '0';
    if (!categories.some(item => item.id === category)) throw error(400,'Choose a valid category.');
    const description = data.description.trim();
    if (!description) throw error(400,'Enter a task description.');
    tasks.unshift({id,category,kind,description,created:time,version:0,deleted:0,
      status:data.assignee ? 'progress' : 'open',assignee:data.assignee || null});
    return {id};
  }
  const task = tasks.find(item => item.id === key);
  if (!task || Boolean(task.deleted) !== (data.action === 'undo')) throw error(404,'Task unavailable.');
  if (task.version !== data.version) throw error(409,'This task changed. Review the updated task and try again.');
  switch (data.action) {
    case 'edit': {
      const description = data.description.trim();
      if (!description || !categories.some(item => item.id === data.category)) throw error(400,'Enter a description and choose a category.');
      task.description = description;
      task.category = data.category;
      if (task.status !== 'complete') {
        task.assignee = data.assignee || null;
        task.status = task.assignee ? 'progress' : 'open';
      }
      break;
    }
    case 'claim':
      task.assignee = user.id;
      task.status = 'progress';
      break;
    case 'release':
    case 'reopen':
      Object.assign(task,{status:'open',assignee:null,completed_at:null,completed_name:null});
      break;
    case 'complete':
      Object.assign(task,{status:'complete',completed_at:time,completed_name:user.name});
      break;
    case 'delete':
    case 'undo':
      task.deleted = Number(data.action === 'delete');
      break;
    default:
      throw error(400,'Unknown task action.');
  }
  return {version:++task.version};
}

function eventDetails(data) {
  const {name,location='',start='',end=''} = data;
  if (!name.trim() || start && end && start > end) throw error(400,'Enter a name and check the event dates.');
  return {name:name.trim(),location:location.trim(),start,end};
}

export function createSheetWorkspace(clientId) {
  let token, expires, sheetId, script;
  const ready = () => Boolean(token && Date.now() < expires && sheetId);

  async function request(url, body) {
    const response = await fetch(url,{
      headers:{Authorization:'Bearer '+token,...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {method:'POST',body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(15000)
    });
    if (response.status === 401) {
      token = null;
      throw error(401,'Your Google session expired. Connect Google again.');
    }
    if (!response.ok) throw error(response.status,'Google Sheets could not save or load the workspace. Try again.');
    return response.json();
  }
  const values = () => sheets+'/'+sheetId+'/values/Changes!A2:A';
  function load() {
    script ||= new Promise((resolve,reject) => {
      const element = document.createElement('script');
      element.src = 'https://accounts.google.com/gsi/client';
      element.onload = resolve;
      element.onerror = () => reject(new Error('Could not load Google sign-in. Reload and try again.'));
      document.head.append(element);
    });
    return script;
  }
  async function connect(create = false) {
    await load();
    if (!token || Date.now() >= expires) {
      const auth = await new Promise((resolve,reject) => {
        google.accounts.oauth2.initTokenClient({
          client_id:clientId,scope:scopes,
          callback: result => result.error ? reject(new Error(result.error_description || result.error)) : resolve(result),
          error_callback: () => reject(new Error('Google sign-in did not finish. Allow the pop-up and try again.'))
        }).requestAccessToken({prompt:''});
      });
      token = auth.access_token;
      expires = Date.now() + Math.max(0, Number(auth.expires_in)-30)*1000;
    }
    const params = new URLSearchParams({
      q:"trashed = false and name = 'Majic Crew Tasks Workspace' and mimeType = 'application/vnd.google-apps.spreadsheet'",
      fields:'files(id),nextPageToken',pageSize:'100'
    });
    const result = await request(drive+'?'+params);
    if (result.files.length > 1 || result.nextPageToken) {
      throw new Error('More than one workspace Sheet is available. Keep one named Majic Crew Tasks Workspace in Google Drive.');
    }
    sheetId = result.files[0]?.id;
    if (!sheetId && create) {
      const sheet = await request(sheets,{
        properties:{title:'Majic Crew Tasks Workspace'},
        sheets:[{properties:{title:'Changes'},data:[{rowData:[{values:[{userEnteredValue:{stringValue:'Crew Tasks changes (managed by the app)'}}]}]}]}]
      });
      sheetId = sheet.spreadsheetId;
    }
    return {found:Boolean(sheetId)};
  }
  async function api(path, data) {
    if (path === 'me') return {user:ready() ? user : null};
    if (!ready()) throw error(401,'Connect Google to open the workspace.');
    const entry = data === undefined ? null : {id:crypto.randomUUID(),path,data,time:new Date().toISOString()};
    if (entry) {
      // Avoid appending edits already known to be invalid. Replay also checks concurrent edits.
      const existing = replay((await request(values())).values || []);
      apply(existing.boards,entry);
      await request(sheets+'/'+sheetId+'/values/Changes!A:A:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',{
        values:[[JSON.stringify(entry)]]
      });
    }
    const {boards,outcomes} = replay((await request(values())).values || []);
    if (entry) {
      const outcome = outcomes.get(entry.id);
      if (!outcome || outcome instanceof Error) throw outcome || error(409,'Refresh to check whether your change was saved.');
      return outcome;
    }
    if (path === 'events') return [...boards.values()].reverse().map(board => board.event);
    const board = boards.get(path.split('/')[1]);
    if (!board) throw error(404,'Event unavailable.');
    return {...board,tasks:board.tasks.filter(task => !task.deleted)};
  }
  return {api,connect,load};
}
