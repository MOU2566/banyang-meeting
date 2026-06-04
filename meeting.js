// ============================================================
// meeting.js — ระบบประชุมออนไลน์ เทศบาลตำบลบ้านยาง
// WebRTC peer-to-peer via PeerJS (free CDN)
// ============================================================

// *** ตั้งค่าก่อนใช้งาน ***
const API_URL = 'https://script.google.com/a/~/macros/s/AKfycbxF95M6qHJZlhk7DKrlaPhMsNPKqDrXUuOgGLE-Ltw3S_YXMAEo6YSht1oHSWYNhRbj/exec'; // ใส่ URL ของ Apps Script

// ============================================================
// STATE
// ============================================================
let currentUser = null;
let authToken = null;
let currentRoomId = null;
let localStream = null;
let micEnabled = true;
let camEnabled = true;
let peer = null;
let peers = {}; // { peerId: { call, stream, userId, username } }
let pollInterval = null;
let chatPollInterval = null;
let lastChatTime = null;
let roomControls = { all_muted: false, chat_disabled: false };

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('mun_auth');
  if (saved) {
    try {
      const d = JSON.parse(saved);
      authToken = d.token;
      currentUser = d.user;
      showMainPage();
    } catch (e) { sessionStorage.removeItem('mun_auth'); }
  }
  document.getElementById('loginPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// ============================================================
// AUTH
// ============================================================
async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  if (!username || !password) { showLoginError('กรุณากรอก username และ password'); return; }
  btn.textContent = 'กำลังเข้าสู่ระบบ...'; btn.disabled = true;
  errEl.style.display = 'none';
  try {
    const res = await apiCall({ action: 'login', username, password });
    if (res.success) {
      authToken = res.token;
      currentUser = res.user;
      sessionStorage.setItem('mun_auth', JSON.stringify({ token: authToken, user: currentUser }));
      showMainPage();
    } else {
      showLoginError(res.error || 'เข้าสู่ระบบไม่สำเร็จ');
    }
  } catch (e) { showLoginError('ไม่สามารถเชื่อมต่อ server ได้'); }
  btn.textContent = 'เข้าสู่ระบบ'; btn.disabled = false;
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg; el.style.display = 'block';
}

function doLogout() {
  sessionStorage.removeItem('mun_auth');
  authToken = null; currentUser = null;
  showPage('loginPage');
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
}

// ============================================================
// PAGES
// ============================================================
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showMainPage() {
  showPage('mainPage');
  const u = currentUser;
  document.getElementById('topbarAvatar').textContent = (u.fullname || u.username).charAt(0).toUpperCase();
  document.getElementById('topbarName').textContent = u.fullname || u.username;
  const rb = document.getElementById('topbarRole');
  rb.textContent = roleLabel(u.role); rb.className = 'role-badge ' + u.role;
  // แสดง admin tab ถ้ามีสิทธิ์
  const canAdmin = ['superadmin', 'admin'].includes(u.role);
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = canAdmin ? '' : 'none');
  // แสดงปุ่มสร้างห้องถ้ามีสิทธิ์
  const canCreate = ['superadmin', 'admin', 'host'].includes(u.role);
  document.getElementById('createRoomBtn').style.display = canCreate ? '' : 'none';
  loadRooms();
}

function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'admin') { loadUsers(); loadLogs(); }
}

// ============================================================
// ROOMS
// ============================================================
async function loadRooms() {
  try {
    const res = await apiCall({ action: 'getRooms' });
    if (!res.success) return;
    const grid = document.getElementById('roomsGrid');
    if (!res.rooms.length) {
      grid.innerHTML = `<div class="no-rooms"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg><p>ยังไม่มีห้องประชุม</p></div>`;
      return;
    }
    grid.innerHTML = res.rooms.map(r => `
      <div class="room-card" onclick="joinRoom('${r.room_id}','${escHtml(r.name)}')">
        <h3>${escHtml(r.name)}</h3>
        <p>${escHtml(r.description || 'ไม่มีคำอธิบาย')}</p>
        <div class="room-meta">
          <span class="status-${r.status}">${statusLabel(r.status)}</span>
          <span style="background:#f0f4ff;color:#4a6ea8">👥 สูงสุด ${r.max_participants} คน</span>
        </div>
        <div class="room-host">🧑‍💼 สร้างโดย: ${escHtml(r.created_by_name)}</div>
      </div>`).join('');
  } catch (e) { showToast('โหลดห้องประชุมไม่สำเร็จ', true); }
}

function openCreateRoom() { openModal('createRoomModal'); }

async function createRoom() {
  const name = document.getElementById('newRoomName').value.trim();
  const desc = document.getElementById('newRoomDesc').value.trim();
  const max = parseInt(document.getElementById('newRoomMax').value) || 50;
  if (!name) { showToast('กรุณาใส่ชื่อห้องประชุม', true); return; }
  const res = await apiCall({ action: 'createRoom', name, description: desc, max_participants: max });
  if (res.success) {
    closeModal('createRoomModal');
    showToast('สร้างห้องประชุมสำเร็จ ✅');
    loadRooms();
    document.getElementById('newRoomName').value = '';
    document.getElementById('newRoomDesc').value = '';
  } else { showToast(res.error || 'ไม่สามารถสร้างห้องได้', true); }
}

// ============================================================
// JOIN / LEAVE MEETING
// ============================================================
async function joinRoom(roomId, roomName) {
  currentRoomId = roomId;
  document.getElementById('meetRoomName').textContent = '🏛 ' + roomName;
  document.getElementById('meetUserName').textContent = currentUser.fullname || currentUser.username;

  // ขอ media stream
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      showToast('ไม่พบกล้อง — ใช้เสียงอย่างเดียว');
    } catch (e2) {
      localStream = null;
      showToast('ไม่พบกล้องและไมค์');
    }
  }

  showPage('meetingPage');
  const canControl = ['superadmin', 'admin', 'host'].includes(currentUser.role);
  document.getElementById('hostControls').className = 'host-controls' + (canControl ? ' visible' : '');

  renderSelfTile();
  initPeerJS();
  await apiCall({ action: 'joinRoom', room_id: roomId });
  await refreshRoomState();
  startPolling();
}

async function leaveRoom() {
  stopPolling();
  if (peer) { peer.destroy(); peer = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.keys(peers).forEach(id => { if (peers[id].call) peers[id].call.close(); });
  peers = {};
  if (currentRoomId) await apiCall({ action: 'leaveRoom', room_id: currentRoomId });
  currentRoomId = null;
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('participantList').innerHTML = '';
  lastChatTime = null;
  showMainPage();
}

// ============================================================
// PEERJS (WebRTC)
// ============================================================
function initPeerJS() {
  // โหลด PeerJS จาก CDN
  if (!window.Peer) {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = () => setupPeer();
    document.head.appendChild(s);
  } else { setupPeer(); }
}

function setupPeer() {
  const peerId = 'mun_' + currentRoomId + '_' + currentUser.user_id + '_' + Date.now();
  peer = new Peer(peerId, { debug: 0 });
  peer.on('open', id => { console.log('PeerJS connected:', id); });
  peer.on('call', call => {
    call.answer(localStream);
    call.on('stream', remoteStream => {
      const meta = call.metadata || {};
      addRemoteTile(call.peer, remoteStream, meta.fullname || 'ผู้เข้าร่วม', meta.userId);
      peers[call.peer] = { call, stream: remoteStream, userId: meta.userId, username: meta.fullname };
    });
    call.on('close', () => removeRemoteTile(call.peer));
  });
  peer.on('error', err => console.warn('PeerJS error:', err));
}

function connectToPeer(remotePeerId, remoteUserId, remoteFullname) {
  if (!peer || peers[remotePeerId]) return;
  const call = peer.call(remotePeerId, localStream, {
    metadata: { fullname: currentUser.fullname, userId: currentUser.user_id }
  });
  call.on('stream', remoteStream => {
    addRemoteTile(remotePeerId, remoteStream, remoteFullname, remoteUserId);
    peers[remotePeerId] = { call, stream: remoteStream, userId: remoteUserId, username: remoteFullname };
  });
  call.on('close', () => removeRemoteTile(remotePeerId));
}

// ============================================================
// VIDEO TILES
// ============================================================
function renderSelfTile() {
  const grid = document.getElementById('videoGrid');
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-self';
  if (localStream && localStream.getVideoTracks().length > 0) {
    const video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.srcObject = localStream;
    tile.appendChild(video);
  } else {
    const av = document.createElement('div');
    av.className = 'avatar-bg';
    av.textContent = (currentUser.fullname || currentUser.username).charAt(0).toUpperCase();
    tile.appendChild(av);
  }
  tile.innerHTML += `<div class="tile-name">👤 ${escHtml(currentUser.fullname || currentUser.username)} (คุณ)</div>
    <div class="tile-muted">🔇</div>`;
  grid.appendChild(tile);
}

function addRemoteTile(peerId, stream, name, userId) {
  if (document.getElementById('tile-' + peerId)) return;
  const grid = document.getElementById('videoGrid');
  const tile = document.createElement('div');
  tile.className = 'video-tile'; tile.id = 'tile-' + peerId;
  tile.setAttribute('data-user-id', userId || '');
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  video.srcObject = stream;
  tile.appendChild(video);
  tile.innerHTML += `<div class="tile-name">${escHtml(name)}</div><div class="tile-muted">🔇</div>`;
  grid.appendChild(tile);
}

function removeRemoteTile(peerId) {
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.remove();
  delete peers[peerId];
}

// ============================================================
// MIC / CAM CONTROLS
// ============================================================
function toggleMic() {
  micEnabled = !micEnabled;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('micBtn');
  btn.textContent = micEnabled ? '🎤' : '🔇';
  btn.className = 'ctrl-btn' + (micEnabled ? '' : ' off');
  btn.querySelector('label').textContent = micEnabled ? 'ไมค์' : 'ปิดไมค์';
  const selfTile = document.getElementById('tile-self');
  if (selfTile) selfTile.classList.toggle('muted', !micEnabled);
}

function toggleCam() {
  camEnabled = !camEnabled;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('camBtn');
  btn.textContent = camEnabled ? '📷' : '📵';
  btn.className = 'ctrl-btn' + (camEnabled ? '' : ' off');
  btn.querySelector('label').textContent = camEnabled ? 'กล้อง' : 'ปิดกล้อง';
}

// ============================================================
// SIDE PANEL
// ============================================================
function toggleSidePanel(tab) {
  switchSideTab(tab);
}

function switchSideTab(tab) {
  document.querySelectorAll('.side-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'chat') || (i === 1 && tab === 'participants'));
  });
  document.getElementById('panelChat').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('panelParticipants').style.display = tab === 'participants' ? 'flex' : 'none';
  document.getElementById('panelParticipants').style.flexDirection = 'column';
  document.getElementById('panelParticipants').style.height = '100%';
}

// ============================================================
// CHAT
// ============================================================
async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !currentRoomId) return;
  if (roomControls.chat_disabled) { showToast('แชทถูกปิดโดยผู้ดูแล', true); return; }
  const res = await apiCall({ action: 'sendChat', room_id: currentRoomId, message: msg });
  if (res.success) {
    input.value = '';
    appendChatMessage({ user_id: currentUser.user_id, fullname: currentUser.fullname, message: msg, timestamp: res.timestamp }, true);
    lastChatTime = res.timestamp;
  } else { showToast(res.error || 'ส่งไม่ได้', true); }
}

async function loadChatHistory() {
  const res = await apiCall({ action: 'getChatHistory', room_id: currentRoomId, since: lastChatTime || '' });
  if (res.success && res.messages.length) {
    res.messages.filter(m => !m.msg_id.startsWith('sys_')).forEach(m => {
      appendChatMessage(m, m.user_id === currentUser.user_id);
    });
    if (res.messages.length) lastChatTime = res.messages[res.messages.length - 1].timestamp;
  }
}

function appendChatMessage(msg, isSelf) {
  const el = document.createElement('div');
  el.className = 'chat-msg' + (isSelf ? ' self' : '');
  const t = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = `<div class="msg-sender">${escHtml(msg.fullname || msg.username || '?')}</div>
    <div class="msg-text">${escHtml(msg.message)}</div>
    <div class="msg-time">${t}</div>`;
  const box = document.getElementById('chatMessages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ============================================================
// HOST CONTROLS
// ============================================================
async function toggleMuteAll() {
  const newVal = !roomControls.all_muted;
  const res = await apiCall({ action: 'updateRoomControl', room_id: currentRoomId, all_muted: newVal });
  if (res.success) {
    roomControls.all_muted = newVal;
    const btn = document.getElementById('muteAllBtn');
    btn.textContent = newVal ? '🔊 เปิดไมค์ทั้งหมด' : '🔇 ปิดไมค์ทั้งหมด';
    btn.className = 'host-ctrl-btn' + (newVal ? ' active' : '');
    showToast(newVal ? 'ปิดไมค์ทุกคนแล้ว' : 'เปิดไมค์ทุกคนแล้ว');
  }
}

async function toggleChatLock() {
  const newVal = !roomControls.chat_disabled;
  const res = await apiCall({ action: 'disableChat', room_id: currentRoomId, disabled: newVal });
  if (res.success) {
    roomControls.chat_disabled = newVal;
    updateChatUI();
    const btn = document.getElementById('chatLockBtn');
    btn.textContent = newVal ? '🔓 ปลดล็อกแชท' : '🔒 ล็อกแชท';
    btn.className = 'host-ctrl-btn' + (newVal ? ' active' : '');
    showToast(newVal ? 'ล็อกแชทแล้ว' : 'ปลดล็อกแชทแล้ว');
  }
}

async function muteParticipant(userId, muted) {
  const res = await apiCall({ action: 'muteUser', room_id: currentRoomId, target_user_id: userId, muted });
  if (res.success) showToast(muted ? 'ปิดไมค์แล้ว' : 'เปิดไมค์แล้ว');
  else showToast(res.error, true);
}

async function kickParticipant(userId, name) {
  if (!confirm(`ต้องการนำ "${name}" ออกจากห้องประชุม?`)) return;
  const res = await apiCall({ action: 'kickUser', room_id: currentRoomId, target_user_id: userId });
  if (res.success) showToast('นำออกจากห้องแล้ว');
  else showToast(res.error, true);
}

function updateChatUI() {
  const input = document.getElementById('chatInput');
  const disabledMsg = document.getElementById('chatDisabledMsg');
  const chatInputArea = input.closest('.chat-input-area');
  input.disabled = roomControls.chat_disabled;
  disabledMsg.style.display = roomControls.chat_disabled ? 'block' : 'none';
  chatInputArea.style.display = roomControls.chat_disabled ? 'none' : '';
}

// ============================================================
// POLLING (refresh state ทุก 3 วินาที)
// ============================================================
function startPolling() {
  pollInterval = setInterval(refreshRoomState, 3000);
  chatPollInterval = setInterval(loadChatHistory, 2000);
}

function stopPolling() {
  clearInterval(pollInterval);
  clearInterval(chatPollInterval);
}

async function refreshRoomState() {
  if (!currentRoomId) return;
  try {
    const res = await apiCall({ action: 'getRoomState', room_id: currentRoomId });
    if (!res.success) return;
    roomControls = res.controls || roomControls;
    updateChatUI();

    // ตรวจสอบว่าถูก kick ไหม
    const self = (res.participants || []).find(p => p.user_id === currentUser.user_id);
    if (self && (self.is_kicked === true || self.is_kicked === 'TRUE')) {
      stopPolling();
      alert('คุณถูกนำออกจากห้องประชุมโดยผู้ดูแล');
      leaveRoom();
      return;
    }

    // อัปเดต all_muted
    if (roomControls.all_muted && micEnabled) {
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
      const btn = document.getElementById('micBtn');
      btn.textContent = '🔇'; btn.className = 'ctrl-btn off';
    }

    renderParticipants(res.participants || []);
  } catch (e) { /* silent fail */ }
}

function renderParticipants(participants) {
  const canControl = ['superadmin', 'admin', 'host'].includes(currentUser.role);
  const list = document.getElementById('participantList');
  list.innerHTML = participants.filter(p => p.is_active === true || p.is_active === 'TRUE').map(p => {
    const isMuted = p.is_muted === true || p.is_muted === 'TRUE';
    const isSelf = p.user_id === currentUser.user_id;
    const actions = canControl && !isSelf ? `
      <button class="p-action-btn" onclick="muteParticipant('${p.user_id}',${!isMuted})" title="${isMuted ? 'เปิดไมค์' : 'ปิดไมค์'}">${isMuted ? '🔊' : '🔇'}</button>
      <button class="p-action-btn danger" onclick="kickParticipant('${p.user_id}','${escHtml(p.fullname)}')" title="นำออก">🚫</button>` : '';
    return `<div class="participant-item">
      <div class="p-avatar">${(p.fullname || p.username || '?').charAt(0).toUpperCase()}</div>
      <div class="p-info">
        <div class="p-name">${escHtml(p.fullname || p.username)}${isSelf ? ' (คุณ)' : ''}</div>
        <div class="p-role">${roleLabel(p.role)}${isMuted ? ' · 🔇 ปิดไมค์' : ''}</div>
      </div>
      <div class="p-actions">${actions}</div>
    </div>`;
  }).join('') || '<div style="text-align:center;padding:2rem;color:rgba(255,255,255,0.3)">ยังไม่มีผู้เข้าร่วม</div>';
}

// ============================================================
// ADMIN - USERS
// ============================================================
async function loadUsers() {
  const res = await apiCall({ action: 'getUsers' });
  if (!res.success) return;
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = res.users.map(u => `
    <tr>
      <td>${escHtml(u.fullname)}</td>
      <td><code style="background:#f0f4ff;padding:2px 6px;border-radius:4px;font-size:0.82rem">${escHtml(u.username)}</code></td>
      <td>${escHtml(u.department || '—')}</td>
      <td><span class="role-badge ${u.role}" style="display:inline-block">${roleLabel(u.role)}</span></td>
      <td>${u.is_active === true || u.is_active === 'TRUE' ?
        '<span style="color:var(--c-green);font-size:0.82rem">✅ ใช้งาน</span>' :
        '<span style="color:var(--c-red);font-size:0.82rem">❌ ระงับ</span>'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-sm ${u.is_active === true || u.is_active === 'TRUE' ? 'toggle-on' : 'toggle-off'}"
          onclick="toggleUserActive('${u.user_id}',${!(u.is_active === true || u.is_active === 'TRUE')})">
          ${u.is_active === true || u.is_active === 'TRUE' ? 'ระงับ' : 'เปิดใช้'}
        </button>
      </td>
    </tr>`).join('');
}

async function toggleUserActive(userId, newStatus) {
  const res = await apiCall({ action: 'updateUser', user_id: userId, is_active: newStatus });
  if (res.success) { showToast('อัปเดตสำเร็จ'); loadUsers(); }
  else showToast(res.error, true);
}

function openAddUser() { openModal('addUserModal'); }

async function createUser() {
  const fullname = document.getElementById('newUserFullname').value.trim();
  const username = document.getElementById('newUserUsername').value.trim();
  const dept = document.getElementById('newUserDept').value.trim();
  const role = document.getElementById('newUserRole').value;
  const password = document.getElementById('newUserPassword').value;
  if (!fullname || !username || !password) { showToast('กรุณากรอกข้อมูลให้ครบ', true); return; }
  const res = await apiCall({ action: 'createUser', fullname, username, department: dept, role, password });
  if (res.success) { closeModal('addUserModal'); showToast('เพิ่มพนักงานสำเร็จ ✅'); loadUsers(); }
  else showToast(res.error || 'ไม่สามารถเพิ่มได้', true);
}

async function loadLogs() {
  const res = await apiCall({ action: 'getLogs', room_id: '' });
  if (!res.success) return;
  const tbody = document.getElementById('logsTableBody');
  tbody.innerHTML = res.logs.slice(-50).reverse().map(l => `
    <tr>
      <td style="font-size:0.82rem;color:var(--c-muted)">${escHtml(l.room_id)}</td>
      <td>${escHtml(l.fullname)}</td>
      <td style="font-size:0.82rem">${l.joined_at ? new Date(l.joined_at).toLocaleString('th-TH') : '—'}</td>
      <td style="font-size:0.82rem">${l.left_at ? new Date(l.left_at).toLocaleString('th-TH') : '—'}</td>
    </tr>`).join('');
}

// ============================================================
// UTILITIES
// ============================================================
async function apiCall(body) {
  if (authToken) body.token = authToken;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, // Apps Script ต้องการ text/plain
    body: JSON.stringify(body)
  });
  return res.json();
}

function roleLabel(role) {
  const map = { superadmin: 'SuperAdmin', admin: 'Admin', host: 'Host', member: 'สมาชิก' };
  return map[role] || role;
}

function statusLabel(status) {
  const map = { waiting: '⏳ รอเริ่ม', active: '🟢 กำลังประชุม', ended: '⏹ สิ้นสุดแล้ว' };
  return map[status] || status;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

let toastTimeout;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.className = '', 3000);
}

// ปิด modal เมื่อคลิกพื้นหลัง
document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
});
