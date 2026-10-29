'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const state = {resources: [], bridge: '', view: 'home', room: null, busy: false};
let toastTimer;

async function api(path, method = 'GET', body) {
  const options = {method, headers: {}};
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(`/api/${path}`, options);
  let result;
  try { result = await response.json(); } catch { throw new Error('Unexpected response from the app.'); }
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function items(type) { return state.resources.filter(r => r.type === type); }
function byId(id) { return state.resources.find(r => r.id === id); }
function nameOf(resource, fallback = 'Untitled') { return resource?.metadata?.name || fallback; }
function roomLights(room) {
  const devices = new Set((room?.children || []).filter(c => c.rtype === 'device').map(c => c.rid));
  return items('light').filter(light => light.owner?.rtype === 'device' && devices.has(light.owner.rid));
}
function lightRoom(light) { return items('room').find(room => (room.children || []).some(c => c.rtype === 'device' && c.rid === light.owner?.rid)); }
function roomScenes(room) { return items('scene').filter(s => s.group?.rid === room.id && s.group?.rtype === 'room'); }
function countLabel(n, singular, plural = singular + 's') { return `${n} ${n === 1 ? singular : plural}`; }
function sorted(arr) { return [...arr].sort((a,b) => nameOf(a).localeCompare(nameOf(b))); }
function showSetup() { $('#app').hidden = true; $('#setup').hidden = false; }
function showApp() { $('#setup').hidden = true; $('#app').hidden = false; $('#bridge-address').textContent = state.bridge; }

async function loadResources() {
  const result = await api('resources');
  if (!Array.isArray(result.data)) throw new Error('The bridge returned invalid resource data.');
  state.resources = result.data;
  if (state.view === 'room' && !items('room').some(r => r.id === state.room)) { state.view = 'home'; state.room = null; }
  render();
}
async function refresh(quiet = false) {
  try { await loadResources(); if (!quiet) toast('Your lights are up to date.'); }
  catch (e) { toast(e.message); }
}
function navigate(view, room = null) { state.view = view; state.room = room; render(); window.scrollTo(0, 0); }
function navigation() {
  const nav = $('#navigation');
  const link = (view, label, ico) => `<button class="nav-item ${state.view === view ? 'active' : ''}" data-nav="${view}">${icon(ico)} ${label}</button>`;
  nav.innerHTML = link('home','Overview','home') + link('lights','All lights','bulb') + link('scenes','Scenes','grid') +
    `<div class="nav-caption">ROOMS <button data-action="new-room" title="Add room" aria-label="Add room">+</button></div>` +
    sorted(items('room')).map(r => `<button class="nav-item nav-room ${state.view === 'room' && state.room === r.id ? 'active' : ''}" data-room="${esc(r.id)}">${icon('home')} ${esc(nameOf(r))}</button>`).join('');
}
function heading(kicker, title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}<span class="accent">.</span></h1><p>${esc(subtitle)}</p></div>${action}</div>`;
}
function sectionHead(kicker, title, action = '', subtitle = '') {
  return `<div class="section-head"><div><div class="section-kicker">${esc(kicker)}</div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${action}</div>`;
}
function roomCards() {
  return `<div class="room-grid">${sorted(items('room')).map(room => {
    const lights = roomLights(room), on = lights.filter(l => l.on?.on).length;
    return `<button class="room-card" data-room="${esc(room.id)}"><div class="room-card-top"><span class="room-icon">${icon('home')}</span><span class="room-arrow">↗</span></div><h3>${esc(nameOf(room))}</h3><p><span class="mini-dot"></span>${countLabel(lights.length, 'light')} · ${on} on</p></button>`;
  }).join('')}<button class="room-card add-room-card" data-action="new-room"><span class="plus-circle">+</span> Add a room</button></div>`;
}
function sceneCards(scenes) {
  if (!scenes.length) return '<div class="empty">No scenes yet. Set your lights just the way you like them, then save the moment as a scene.</div>';
  return `<div class="scenes-grid">${sorted(scenes).map(scene => {
    const group = byId(scene.group?.rid);
    return `<div class="scene-wrap"><button class="scene-card" data-recall="${esc(scene.id)}" title="Activate ${esc(nameOf(scene))}">${icon('spark')}<h3>${esc(nameOf(scene))}</h3><p>${esc(nameOf(group, 'Group'))}${scene.status?.active && scene.status.active !== 'inactive' ? ' · Active' : ''}</p><span class="play">▶</span></button><button class="scene-delete" data-delete-scene="${esc(scene.id)}" title="Delete scene" aria-label="Delete ${esc(nameOf(scene))}">${icon('close')}</button></div>`;
  }).join('')}</div>`;
}
function lightCards(lights) {
  if (!lights.length) return '<div class="empty">No lights here yet. Add bulbs to this room to see them here.</div>';
  return `<div class="light-grid">${sorted(lights).map(light => {
    const room = lightRoom(light), on = !!light.on?.on;
    const connectivity = items('zigbee_connectivity').find(c => c.owner?.rid === light.owner?.rid);
    const status = connectivity?.status === 'connectivity_issue' ? 'Unreachable' : on ? 'On' : 'Off';
    let controls = '';
    if (light.dimming) controls += `<div class="control-row"><div class="control-label"><span>Brightness</span><span>${Math.round(light.dimming.brightness || 0)}%</span></div><input type="range" min="${Math.max(1, Math.ceil(light.dimming.min_dim_level || 1))}" max="100" step="1" value="${Math.max(1, light.dimming.brightness || 1)}" data-control="brightness" data-id="${esc(light.id)}" aria-label="${esc(nameOf(light))} brightness"></div>`;
    if (light.color_temperature) {
      const ct = light.color_temperature, min = ct.mirek_schema?.mirek_minimum || 153, max = ct.mirek_schema?.mirek_maximum || 500;
      const value = Math.max(min, Math.min(max, ct.mirek || Math.round((min + max)/2)));
      controls += `<div class="control-row"><div class="control-label"><span>Color temperature</span><span>${ct.mirek_valid && ct.mirek ? `${Math.round(1000000/ct.mirek)} K` : 'Cool ↔ warm'}</span></div><input class="temp-range" type="range" min="${min}" max="${max}" step="1" value="${value}" data-control="temperature" data-id="${esc(light.id)}" aria-label="${esc(nameOf(light))} color temperature"></div>`;
    }
    if (light.color?.xy) controls += `<div class="control-row color-control"><div class="control-label">Color</div><input class="color-picker" type="color" value="${xyToHex(light.color.xy)}" data-control="color" data-id="${esc(light.id)}" aria-label="${esc(nameOf(light))} color"></div>`;
    return `<article class="light-card ${on ? 'is-on' : ''}"><div class="light-top"><span class="light-icon">${icon('bulb')}</span><div class="light-title"><h3>${esc(nameOf(light, nameOf(byId(light.owner?.rid), 'Light')))}</h3><p>${esc(status)}${room ? ` · ${esc(nameOf(room))}` : ' · Unassigned'}</p></div><label class="switch"><input type="checkbox" data-control="power" data-id="${esc(light.id)}" ${on ? 'checked' : ''} aria-label="Turn ${esc(nameOf(light))} on or off"><span></span></label></div>${controls ? `<div class="light-controls">${controls}</div>` : ''}</article>`;
  }).join('')}</div>`;
}
function render() {
  navigation();
  const content = $('#content'), lights = items('light'), rooms = items('room');
  let html = '';
  if (state.view === 'home') {
    $('#breadcrumb').textContent = 'OVERVIEW';
    const hour = new Date().getHours(), greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const date = new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());
    html = heading('A LITTLE LIGHT GOES A LONG WAY', greeting, 'Welcome home. Let’s set the right mood.', `<div class="date-chip">✳ &nbsp; ${esc(date)}</div>`) +
      `<div class="hero"><div class="hero-copy"><span class="eyebrow">YOUR HOME, YOUR ATMOSPHERE</span><h2>Make room<br>for the moment.</h2><p>From slow mornings to cozy evenings, the right light makes all the difference.</p></div><div class="hero-orb">${icon('bulb')}</div><span class="hero-index">01 / YOUR SPACE</span></div>` +
      `<section class="section">${sectionHead('EXPLORE YOUR SPACE','Your rooms', `<button class="text-button" data-action="new-room">Add room <span>↗</span></button>`)}${roomCards()}</section>` +
      `<section class="section">${sectionHead('SET THE MOOD','Scenes', `<button class="text-button" data-nav="scenes">View all <span>↗</span></button>`)}${sceneCards(items('scene').slice(0,4))}</section>` +
      `<section class="section">${sectionHead('AT A GLANCE','Your lights', `<button class="text-button" data-nav="lights">View all <span>↗</span></button>`, `${lights.filter(l => l.on?.on).length} of ${countLabel(lights.length, 'light')} on`)}${lightCards(lights.slice(0,4))}</section>`;
  } else if (state.view === 'lights') {
    $('#breadcrumb').textContent = 'ALL LIGHTS';
    html = heading('YOUR HOME, ILLUMINATED','All lights', `${countLabel(lights.length, 'light')} across your home`) + `<section class="section">${lightCards(lights)}</section>`;
  } else if (state.view === 'scenes') {
    $('#breadcrumb').textContent = 'SCENES';
    html = heading('THE PERFECT AMBIENCE','Your scenes', 'A favorite feeling, ready whenever you are.', `<button class="button button-dark" data-action="new-scene">${icon('plus')} Create scene</button>`) + `<section class="section">${sceneCards(items('scene'))}</section>`;
  } else if (state.view === 'room') {
    const room = byId(state.room); if (!room) return navigate('home');
    $('#breadcrumb').textContent = nameOf(room).toUpperCase();
    const group = (room.services || []).find(s => s.rtype === 'grouped_light');
    html = `<button class="text-button back-button" data-nav="home">← &nbsp; All rooms</button>` + heading('YOUR SPACE',nameOf(room), `${countLabel(roomLights(room).length, 'light')} · ${countLabel(roomScenes(room).length, 'scene')}`, `<div class="room-actions">${group ? `<button class="button button-outline" data-group="${esc(group.rid)}" data-on="true">All on</button><button class="button button-outline" data-group="${esc(group.rid)}" data-on="false">All off</button>` : ''}<button class="button button-light" data-action="edit-room">Edit room</button></div>`) +
      `<section class="section">${sectionHead('MAKE IT YOURS','Lights')}${lightCards(roomLights(room))}</section>` +
      `<section class="section">${sectionHead('SET THE MOOD','Scenes', `<button class="text-button" data-action="new-scene">Create scene <span>↗</span></button>`)}${sceneCards(roomScenes(room))}</section>`;
  }
  content.innerHTML = html;
}

function openModal(content) { $('#dialog-content').innerHTML = `<div class="modal">${content}</div>`; $('#dialog').showModal(); }
function modalHead(kicker, title, description) { return `<div class="modal-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2><p>${description}</p></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button></div>`; }
function roomModal(room = null) {
  const devices = items('device').filter(d => items('light').some(l => l.owner?.rid === d.id));
  const selected = new Set((room?.children || []).filter(c => c.rtype === 'device').map(c => c.rid));
  const archetypes = ['living_room','kitchen','dining','bedroom','kids_bedroom','bathroom','office','hallway','garage','garden','other'];
  const archetype = room?.metadata?.archetype || 'other';
  if (!archetypes.includes(archetype)) archetypes.push(archetype);
  const list = sorted(devices).map(device => {
    const other = items('room').find(r => r.id !== room?.id && (r.children || []).some(c => c.rtype === 'device' && c.rid === device.id));
    const deviceLights = items('light').filter(l => l.owner?.rid === device.id);
    return `<label class="check-item"><input type="checkbox" name="device" value="${esc(device.id)}" ${selected.has(device.id) ? 'checked' : ''} ${other ? 'disabled' : ''}><span>${esc(nameOf(device, nameOf(deviceLights[0], 'Light')))}</span><small>${other ? `In ${esc(nameOf(other))}` : countLabel(deviceLights.length, 'light')}</small></label>`;
  }).join('');
  openModal(modalHead('YOUR SPACE',room ? 'Edit room' : 'Create a room','Group your lights by the spaces they belong to.') + `<form id="room-form" data-id="${esc(room?.id || '')}"><div class="field"><label for="room-name">ROOM NAME</label><input id="room-name" name="name" required maxlength="32" value="${esc(nameOf(room,''))}" placeholder="e.g. Living room"></div><div class="field"><label for="room-type">ROOM TYPE</label><select id="room-type" name="archetype">${archetypes.map(a => `<option value="${esc(a)}" ${a === archetype ? 'selected' : ''}>${esc(a.replaceAll('_',' ').replace(/\b\w/g,c => c.toUpperCase()))}</option>`).join('')}</select></div><div class="field"><label>LIGHT DEVICES</label><div class="check-list">${list || '<div class="check-item">No light devices found.</div>'}</div><p>Devices can belong to one room. Remove a device from its current room before moving it.</p></div><div class="form-message" role="alert"></div><div class="modal-actions">${room ? '<button type="button" class="button button-danger" data-action="delete-room">Delete room</button>' : ''}<button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-dark" type="submit">${room ? 'Save changes' : 'Create room'}</button></div></form>`);
}
function sceneModal() {
  const rooms = sorted(items('room'));
  if (!rooms.length) { toast('Create a room before saving a scene.'); return; }
  openModal(modalHead('SAVE THE MOMENT','Create a scene','We’ll capture the current state of the lights in your room. Set them how you like first.') + `<form id="scene-form"><div class="field"><label for="scene-name">SCENE NAME</label><input id="scene-name" name="name" required maxlength="32" placeholder="e.g. Movie night"></div><div class="field"><label for="scene-room">ROOM</label><select id="scene-room" name="room">${rooms.map(r => `<option value="${esc(r.id)}" ${r.id === state.room ? 'selected' : ''}>${esc(nameOf(r))} · ${countLabel(roomLights(r).length,'light')}</option>`).join('')}</select></div><div class="form-message" role="alert"></div><div class="modal-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-dark">Save scene</button></div></form>`);
}
function settingsModal() {
  openModal(modalHead('YOUR CONNECTION','Bridge settings',`Connected to ${esc(state.bridge)}. Your application key is stored on this computer.`) + `<p>Disconnecting removes the saved connection from this app. It does not remove lights or scenes from your bridge.</p><div class="modal-actions"><button class="button button-outline" data-action="close-modal">Close</button><button class="button button-danger" data-action="disconnect">Disconnect bridge</button></div>`);
}
async function runMutation(path, method, body, success) {
  try { await api(path, method, body); await loadResources(); if (success) toast(success); return true; }
  catch (e) { toast(e.message); await refresh(true); return false; }
}

document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.nav) return navigate(el.dataset.nav);
  if (el.dataset.room) return navigate('room', el.dataset.room);
  if (el.dataset.recall) return runMutation(`scene/${el.dataset.recall}`, 'PUT', {recall:{action:'active'}}, 'Scene activated.');
  if (el.dataset.deleteScene) {
    const scene = byId(el.dataset.deleteScene);
    if (confirm(`Delete “${nameOf(scene)}”? This removes it from your Hue bridge.`)) await runMutation(`scene/${el.dataset.deleteScene}`, 'DELETE', undefined, 'Scene deleted.');
    return;
  }
  if (el.dataset.group) return runMutation(`grouped_light/${el.dataset.group}`, 'PUT', {on:{on:el.dataset.on === 'true'}}, 'Room updated.');
  switch (el.dataset.action) {
    case 'new-room': roomModal(); break;
    case 'edit-room': roomModal(byId(state.room)); break;
    case 'new-scene': sceneModal(); break;
    case 'close-modal': $('#dialog').close(); break;
    case 'delete-room': {
      const room = byId(state.room);
      if (confirm(`Delete “${nameOf(room)}”? The bridge may also remove its scenes. Your lights will not be deleted.`)) {
        if (await runMutation(`room/${room.id}`, 'DELETE', undefined, 'Room deleted.')) $('#dialog').close();
      }
      break;
    }
    case 'disconnect':
      if (confirm('Disconnect this bridge from Glow?')) { try { await api('disconnect','POST',{}); $('#dialog').close(); state.resources = []; state.view = 'home'; showSetup(); } catch(e) { toast(e.message); } }
      break;
  }
});
$('#settings-btn').addEventListener('click', settingsModal);
$('#mobile-settings-btn').addEventListener('click', settingsModal);
$('#refresh-btn').addEventListener('click', () => refresh());
$('#dialog').addEventListener('click', e => { if (e.target === $('#dialog')) $('#dialog').close(); });
document.addEventListener('change', async event => {
  const input = event.target, type = input.dataset.control; if (!type) return;
  let body;
  if (type === 'power') body = {on:{on:input.checked}};
  if (type === 'brightness') body = {dimming:{brightness:Number(input.value)}};
  if (type === 'temperature') body = {color_temperature:{mirek:Number(input.value)}};
  if (type === 'color') body = {color:{xy:hexToXY(input.value, byId(input.dataset.id)?.color?.gamut)}};
  if (body) await runMutation(`light/${input.dataset.id}`, 'PUT', body);
});
document.addEventListener('input', event => {
  const input = event.target, label = input.closest('.control-row')?.querySelector('.control-label span:last-child');
  if (!label) return;
  if (input.dataset.control === 'brightness') label.textContent = `${input.value}%`;
  if (input.dataset.control === 'temperature') label.textContent = `${Math.round(1000000/Number(input.value))} K`;
});
document.addEventListener('submit', async event => {
  const form = event.target; if (!['room-form','scene-form'].includes(form.id)) return;
  event.preventDefault(); const button = $('button[type=submit]', form), error = $('.form-message', form); button.disabled = true; error.textContent = '';
  try {
    const data = new FormData(form), name = String(data.get('name')).trim();
    if (!name) throw new Error('Please enter a name.');
    if (form.id === 'room-form') {
      const room = byId(form.dataset.id);
      const children = data.getAll('device').map(rid => ({rid, rtype:'device'}));
      // Keep non-light children, such as switches and sensors, when editing a room.
      if (room) for (const child of room.children || []) if (!items('light').some(l => l.owner?.rid === child.rid)) children.push(child);
      const payload = {metadata:{name,archetype:data.get('archetype')},children};
      await api(room ? `room/${room.id}` : 'room', room ? 'PUT' : 'POST', payload);
    } else {
      // Refresh before capturing so scenes reflect the bridge's actual current state.
      const fresh = await api('resources'); state.resources = fresh.data;
      const room = byId(data.get('room')); if (!room) throw new Error('That room no longer exists.');
      const lights = roomLights(room); if (!lights.length) throw new Error('Add lights to this room before creating a scene.');
      const actions = lights.map(light => {
        const action = {on:{on:!!light.on?.on}};
        if (light.dimming && Number.isFinite(light.dimming.brightness)) action.dimming = {brightness:Math.max(0.1,light.dimming.brightness)};
        if (light.color_temperature?.mirek_valid && light.color_temperature.mirek != null) action.color_temperature = {mirek:light.color_temperature.mirek};
        else if (light.color?.xy) action.color = {xy:light.color.xy};
        return {target:{rid:light.id,rtype:'light'},action};
      });
      await api('scene','POST',{metadata:{name},group:{rid:room.id,rtype:'room'},actions});
    }
    $('#dialog').close(); await loadResources(); toast(form.id === 'room-form' ? 'Room saved.' : 'Scene saved.');
  } catch (e) { error.textContent = e.message; } finally { button.disabled = false; }
});

// sRGB <-> CIE xy; clamp requests to the gamut reported by each light.
function hexToXY(hex, gamut) {
  const rgb = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(v => v > .04045 ? ((v+.055)/1.055)**2.4 : v/12.92);
  const [r,g,b] = rgb, X = r*.664511+g*.154324+b*.162028, Y = r*.283881+g*.668433+b*.047685, Z = r*.000088+g*.072310+b*.986039;
  let point = X+Y+Z ? {x:X/(X+Y+Z),y:Y/(X+Y+Z)} : {x:.3127,y:.329};
  if (gamut?.red && gamut?.green && gamut?.blue) point = clampGamut(point,gamut.red,gamut.green,gamut.blue);
  return {x:Number(point.x.toFixed(4)),y:Number(point.y.toFixed(4))};
}
function clampGamut(p,a,b,c) {
  const cross = (p1,p2,p3) => (p2.x-p1.x)*(p3.y-p1.y)-(p2.y-p1.y)*(p3.x-p1.x);
  const d1=cross(a,b,p),d2=cross(b,c,p),d3=cross(c,a,p);
  if ((d1>=0&&d2>=0&&d3>=0)||(d1<=0&&d2<=0&&d3<=0)) return p;
  const nearest = (v,w) => { const dx=w.x-v.x,dy=w.y-v.y,den=dx*dx+dy*dy; const t=den ? Math.max(0,Math.min(1,((p.x-v.x)*dx+(p.y-v.y)*dy)/den)) : 0; return {x:v.x+t*dx,y:v.y+t*dy}; };
  return [nearest(a,b),nearest(b,c),nearest(c,a)].sort((v,w) => (v.x-p.x)**2+(v.y-p.y)**2-((w.x-p.x)**2+(w.y-p.y)**2))[0];
}
function xyToHex(xy) {
  if (!xy || !xy.y) return '#ffffff';
  const X=xy.x/xy.y, Y=1, Z=(1-xy.x-xy.y)/xy.y;
  let rgb=[X*1.656492-Y*.354851-Z*.255038,-X*.707196+Y*1.655397+Z*.036152,X*.051713-Y*.121364+Z*1.011530].map(v=>Math.max(0,v));
  const max=Math.max(...rgb,1); rgb=rgb.map(v=>v/max).map(v=>v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055);
  return '#'+rgb.map(v=>Math.round(Math.min(1,Math.max(0,v))*255).toString(16).padStart(2,'0')).join('');
}

$('#discover-btn').addEventListener('click', async event => {
  const button = event.currentTarget, msg = $('#setup-message'); button.disabled = true; msg.textContent = 'Looking for bridges…';
  try {
    const bridges = await api('discover');
    if (!bridges.length) { msg.textContent = 'No bridge found. You can enter its IP address manually.'; return; }
    $('#bridge-input').value = bridges[0].internalipaddress;
    msg.textContent = bridges.length > 1 ? 'Multiple bridges found; using the first. You can change the IP address.' : 'Bridge found. Press its button, then connect.';
  } catch(e) { msg.textContent = e.message; } finally { button.disabled = false; }
});
$('#connect-btn').addEventListener('click', async event => {
  const button = event.currentTarget, msg = $('#setup-message'); button.disabled = true; msg.textContent = 'Connecting…';
  try { const bridge = $('#bridge-input').value.trim(); await api('connect','POST',{bridge}); state.bridge = bridge; showApp(); await loadResources(); msg.textContent = ''; }
  catch(e) { if ($('#setup').hidden) toast(e.message); else msg.textContent = e.message; } finally { button.disabled = false; }
});
async function init() {
  try { const status = await api('status'); if (!status.configured) return showSetup(); state.bridge = status.bridge; showApp(); await loadResources(); }
  catch(e) { if (state.bridge) toast(e.message); else { showSetup(); $('#setup-message').textContent = e.message; } }
}
init();
