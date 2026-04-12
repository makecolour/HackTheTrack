/**
 * Delivery Bot — SE Preliminary Frontend
 * Competitor interface (staff role only — order pushed from AllAboutHack)
 */

// ── State ──
let token = localStorage.getItem('token');
let currentUser = null;
let socket = null;
let mapPoints = [];
let currentOrder = null;
let vehiclePos = { pointId: 'S', positionType: 'unknown' };
let sessionConfig = null;
let keysDown = {};
let sessionTimer = null;
let allOrdersCache = [];
let crossedLines = new Set();
let driveLocked = false;

const API = '';

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    if (token) {
        verifyToken();
    }
});

// ── Auth ──
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    try {
        const res = await fetch(`${API}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        token = data.data.token;
        localStorage.setItem('token', token);
        currentUser = data.data.user;
        enterApp();
    } catch (err) {
        const el = document.getElementById('login-error');
        el.textContent = err.message;
        el.classList.remove('hidden');
    }
}

async function verifyToken() {
    try {
        const res = await fetch(`${API}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!data.success) throw new Error();
        currentUser = data.data;
        enterApp();
    } catch {
        localStorage.removeItem('token');
        token = null;
    }
}

function logout() {
    localStorage.removeItem('token');
    token = null;
    currentUser = null;
    if (socket) socket.disconnect();
    location.reload();
}

function enterApp() {
    document.getElementById('login-screen').classList.add('hidden');
    connectSocket();
    loadMapPoints();

    document.getElementById('staff-page').classList.remove('hidden');
    document.getElementById('staff-name').textContent = currentUser.displayName || currentUser.username;
    loadCurrentOrder();
    loadAllOrders();
    loadSessionConfig();
    showTab('orders');
}

// ── Socket.IO ──
function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        console.log('Socket connected');
        socket.emit('join-room', 'staff');
    });

    // Real-time events
    socket.on('new-order', (order) => {
        currentOrder = order;
        renderCurrentOrder();
        loadAllOrders();
        showNotification('📦 New order received from AllAboutHack!');
    });
    socket.on('order-accepted', (data) => {
        loadAllOrders();
        if (data.path) drawPathOnMap(data.path);
    });
    socket.on('order-arrived', (data) => {
        if (data.order) {
            currentOrder = data.order;
            renderCurrentOrder();
        }
        loadAllOrders();
        showNotification(data.message || 'Order arrived!');
    });
    socket.on('order-delivered', (order) => {
        currentOrder = order;
        renderCurrentOrder();
        loadAllOrders();
        showNotification(`Order #${order.id} delivered!`);
    });
    socket.on('vehicle-position', (data) => {
        vehiclePos = data;
        updateVehicleUI();
        drawMap();
        drawMinimap();
    });
    socket.on('vehicle-position-estimate', (data) => {
        if (data.x !== undefined) drawVehicleEstimate(data.x, data.y);
    });
    socket.on('vehicle-returned', () => {
        vehiclePos = { pointId: 'S', positionType: 'confirmed' };
        updateVehicleUI();
        drawMap();
        drawMinimap();
    });
    socket.on('navigation-log', (data) => {
        addNavLog(data);
    });
    socket.on('hardware-status-update', (data) => {
        document.getElementById('hw-status').textContent = `HW: ${data.status || 'connected'}`;
        document.getElementById('hw-status').className = 'text-xs px-2 py-1 rounded-full ' +
            (data.status === 'disconnected' ? 'bg-red-900 text-red-400' : 'bg-green-900 text-green-400');
    });
    socket.on('rfid-scanned', (data) => {
        document.getElementById('rfid-result').textContent = `RFID: ${data.uid || data.rfidId || JSON.stringify(data)}`;
    });
    socket.on('lines-crossed', (data) => {
        if (data.lines && Array.isArray(data.lines)) {
            data.lines.forEach(l => crossedLines.add(l.lineKey));
            drawMap();
            drawMinimap();
        }
    });
    socket.on('session-configured', (data) => {
        showNotification(`Session configured: ${data.targetPointA || '?'} → ${data.targetPointB || '?'}`);
        crossedLines = new Set();
        loadMapPoints();
        loadSessionConfig();
        loadCurrentOrder();
    });
    socket.on('session-started', () => {
        showNotification('🏁 Session started!');
        driveLocked = true;
        vehiclePos = { pointId: 'S', positionType: 'confirmed' };
        crossedLines = new Set();
        currentPath = null;
        currentOrder = null;
        updateVehicleUI();
        renderCurrentOrder();
        loadSessionConfig();
        loadAllOrders();
        drawMap();
        drawMinimap();
        showTab('orders');
    });
    socket.on('session-ended', () => {
        showNotification('⏹️ Session ended!');
        if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
        loadSessionConfig();
    });
    socket.on('order-cancelled', () => {
        currentOrder = null;
        renderCurrentOrder();
        loadAllOrders();
    });
}

// ── Data Loading ──
async function apiFetch(url, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${url}`, { ...opts, headers });
    return res.json();
}

async function loadMapPoints() {
    const data = await apiFetch('/api/map/points');
    if (data.success) {
        mapPoints = data.data;
        drawMap();
        drawMinimap();
    }
}

async function loadSessionConfig() {
    const data = await apiFetch('/api/session');
    if (data.success && data.data) {
        sessionConfig = data.data;
        updateSessionUI();
        drawMinimap();

        // Lock drive if session is running and no active order yet
        if (sessionConfig.status === 'running') {
            if (!currentOrder || currentOrder.status === 'pending') {
                driveLocked = true;
            }
        }

        // Start timer if running
        if (sessionConfig.status === 'running' && sessionConfig.started_at && sessionConfig.run_time_seconds) {
            startSessionTimer();
        }
    }
}

async function loadCurrentOrder() {
    const data = await apiFetch('/api/orders/current');
    if (data.success) {
        currentOrder = data.data;
        renderCurrentOrder();
        // Unlock drive if there's an active order past pending
        if (currentOrder && currentOrder.status !== 'pending') {
            driveLocked = false;
        }
    }
}

async function loadAllOrders() {
    const data = await apiFetch('/api/orders');
    if (data.success) {
        allOrdersCache = data.data;
        renderAllOrders(data.data);
    }
}

// ── Session UI ──
function updateSessionUI() {
    if (!sessionConfig) return;
    const badge = document.getElementById('session-status-badge');
    const statusColors = {
        idle: 'bg-zinc-700 text-zinc-400',
        configured: 'bg-yellow-900 text-yellow-300',
        running: 'bg-green-900 text-green-300',
        ended: 'bg-red-900 text-red-300'
    };
    badge.textContent = sessionConfig.status || 'idle';
    badge.className = `text-xs px-2 py-1 rounded-full ${statusColors[sessionConfig.status] || statusColors.idle}`;

    const team = document.getElementById('session-team');
    const phase = document.getElementById('session-phase');
    const targetA = document.getElementById('session-target-a');
    const targetB = document.getElementById('session-target-b');
    if (team) team.textContent = sessionConfig.team_code || '—';
    if (phase) phase.textContent = sessionConfig.phase || '—';
    if (targetA) targetA.textContent = sessionConfig.target_point_a || '—';
    if (targetB) targetB.textContent = sessionConfig.target_point_b || '—';
}

function startSessionTimer() {
    if (sessionTimer) clearInterval(sessionTimer);
    const timerEl = document.getElementById('session-timer');
    if (!timerEl || !sessionConfig) return;

    const startTime = new Date(sessionConfig.started_at).getTime();
    const duration = (sessionConfig.run_time_seconds || 300) * 1000;

    sessionTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, duration - elapsed);
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (remaining <= 0) {
            clearInterval(sessionTimer);
            sessionTimer = null;
            timerEl.textContent = '00:00';
        }
    }, 1000);
}

// ── Order UI ──
function renderCurrentOrder() {
    const orderEl = document.getElementById('current-order');
    const noOrderEl = document.getElementById('no-order');
    const acceptBtn = document.getElementById('accept-order-btn');

    if (!currentOrder || currentOrder.status === 'delivered' || currentOrder.status === 'cancelled') {
        orderEl.classList.add('hidden');
        noOrderEl.classList.remove('hidden');
        return;
    }

    orderEl.classList.remove('hidden');
    noOrderEl.classList.add('hidden');

    document.getElementById('order-dest-a').textContent = currentOrder.destination_a || '—';
    document.getElementById('order-dest-b').textContent = currentOrder.destination_b || '(return only)';

    const badge = document.getElementById('order-status-badge');
    badge.textContent = currentOrder.status;
    badge.className = `text-xs px-2 py-1 rounded-full ${statusColor(currentOrder.status)}`;

    // Show accept button only when pending
    if (currentOrder.status === 'pending') {
        acceptBtn.classList.remove('hidden');
    } else {
        acceptBtn.classList.add('hidden');
    }
}

async function acceptOrder() {
    if (!currentOrder) return;
    const data = await apiFetch(`/api/orders/${currentOrder.id}/accept`, { method: 'PUT' });
    if (data.success) {
        currentOrder = data.data.order;
        renderCurrentOrder();
        loadAllOrders();
        if (data.data.path) drawPathOnMap(data.data.path);
        showNotification('✓ Order accepted — delivery starting!');
        driveLocked = false;
        showTab('drive');
    }
}

async function cancelOrder(id) {
    await apiFetch(`/api/orders/${id}/cancel`, { method: 'PUT' });
    loadCurrentOrder();
    loadAllOrders();
}

function renderAllOrders(orders) {
    const container = document.getElementById('all-order-list');
    if (!container) return;
    container.innerHTML = orders.slice(0, 20).map(o => `
        <div class="flex items-center justify-between bg-zinc-800 rounded-lg px-4 py-2 text-sm">
            <span class="font-mono">#${o.id}</span>
            <span>${escapeHtml(o.destination_a)}${o.destination_b ? ' → ' + escapeHtml(o.destination_b) : ''}</span>
            <span class="px-2 py-0.5 rounded-full text-xs ${statusColor(o.status)}">${o.status}</span>
        </div>
    `).join('') || '<div class="text-zinc-500 text-sm text-center py-4">No orders yet</div>';
}

// ── Staff UI: Drive ──
function motorCmd(command) {
    if (driveLocked) {
        showNotification('🔒 Accept an order first to unlock drive!');
        return;
    }
    if (socket) socket.emit('motor-control', { command, speed: 50 });
}

function stopNavigation() {
    if (socket) socket.emit('stop-navigation');
    addNavLog({ message: 'Navigation stopped' });
}

function addNavLog(data) {
    const container = document.getElementById('nav-log');
    if (!container) return;
    const time = new Date().toLocaleTimeString();
    const msg = data.message || `${data.event || data.eventType || ''}: ${JSON.stringify(data).slice(0, 80)}`;
    container.insertAdjacentHTML('afterbegin',
        `<div class="text-zinc-400"><span class="text-zinc-600">${time}</span> ${escapeHtml(msg)}</div>`
    );
    // Keep last 50 entries
    while (container.children.length > 50) container.lastChild.remove();
}

function updateVehicleUI() {
    const posEl = document.getElementById('vehicle-position');
    const statusEl = document.getElementById('vehicle-status');
    if (posEl) posEl.textContent = vehiclePos.pointId || '?';
    if (statusEl) statusEl.textContent = vehiclePos.positionType || 'unknown';
}

// ── Camera Feed ──
let cameraRetryTimer = null;
function initCamera() {
    const img = document.getElementById('camera-feed');
    const placeholder = document.getElementById('camera-placeholder');
    if (!img) return;

    if (cameraRetryTimer) clearTimeout(cameraRetryTimer);

    // Check if stream is available first via snapshot probe
    fetch('/snapshot').then(resp => {
        if (resp.ok) {
            // Camera is available — start MJPEG stream
            img.src = '/stream';
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
            img.onerror = () => {
                img.classList.add('hidden');
                placeholder.textContent = 'Camera stream interrupted — retrying...';
                placeholder.classList.remove('hidden');
                cameraRetryTimer = setTimeout(initCamera, 5000);
            };
        } else {
            img.classList.add('hidden');
            placeholder.textContent = 'Camera not connected — ensure rpicam-vid is running on Pi';
            placeholder.classList.remove('hidden');
            cameraRetryTimer = setTimeout(initCamera, 5000);
        }
    }).catch(() => {
        img.classList.add('hidden');
        placeholder.textContent = 'Hardware daemon not reachable';
        placeholder.classList.remove('hidden');
        cameraRetryTimer = setTimeout(initCamera, 5000);
    });
}

// ── Map Canvas ──
let currentPath = null;
let vehicleEstimate = null;

function drawMap() {
    const canvas = document.getElementById('map-canvas');
    if (!canvas || mapPoints.length === 0) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    // Scale factor (map coordinates to canvas)
    const padding = 50;
    const scaleX = (W - padding * 2) / 600;
    const scaleY = (H - padding * 2) / 700;
    const tx = (id) => {
        const p = mapPoints.find(m => m.pointId === id);
        return p ? { x: p.x * scaleX + padding, y: p.y * scaleY + padding } : null;
    };

    ctx.clearRect(0, 0, W, H);

    // Draw connections (roads) — crossed lines shown in green
    const drawnRoad = new Set();
    mapPoints.forEach(p => {
        const from = tx(p.pointId);
        if (!from) return;
        p.connections.forEach(cId => {
            const key = [p.pointId, cId].sort().join('-');
            if (drawnRoad.has(key)) return;
            drawnRoad.add(key);
            const to = tx(cId);
            if (!to) return;
            const isCrossed = crossedLines.has(key);
            ctx.strokeStyle = isCrossed ? '#22c55e' : '#3f3f46';
            ctx.lineWidth = isCrossed ? 5 : 3;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
        });
    });

    // Draw path
    if (currentPath && currentPath.length > 1) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 4;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        currentPath.forEach((p, i) => {
            const pos = tx(p.pointId);
            if (!pos) return;
            if (i === 0) ctx.moveTo(pos.x, pos.y);
            else ctx.lineTo(pos.x, pos.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Draw points
    mapPoints.forEach(p => {
        const pos = tx(p.pointId);
        if (!pos) return;
        const color = p.type === 'start' ? '#22c55e' :
                      p.type === 'destination' ? '#3b82f6' :
                      p.type === 'intersection' ? '#eab308' :
                      p.type === 'stop' ? '#ef4444' : '#71717a';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(p.pointId, pos.x, pos.y - 18);

        // RFID indicator
        if (p.rfidTagId) {
            ctx.font = '8px sans-serif';
            ctx.fillStyle = '#a78bfa';
            ctx.fillText('RFID', pos.x, pos.y + 24);
        }
    });

    // Draw vehicle
    const vPos = tx(vehiclePos.pointId);
    if (vPos) {
        ctx.beginPath();
        ctx.arc(vPos.x, vPos.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    // Draw estimated position
    if (vehicleEstimate) {
        const ePos = { x: vehicleEstimate.x * scaleX + padding, y: vehicleEstimate.y * scaleY + padding };
        ctx.beginPath();
        ctx.arc(ePos.x, ePos.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.5)';
        ctx.fill();
    }
}

function drawPathOnMap(path) {
    currentPath = path;
    drawMap();
}

function drawVehicleEstimate(x, y) {
    vehicleEstimate = { x, y };
    drawMap();
}

// ── Tabs ──
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('bg-zinc-700'));
    const tab = document.getElementById(`tab-${tabName}`);
    if (tab) tab.classList.remove('hidden');
    const btn = document.querySelector(`[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('bg-zinc-700');

    if (tabName === 'drive') {
        initCamera();
        initKeyboardControls();
        drawMinimap();
    }
    if (tabName === 'map') setTimeout(drawMap, 100);
}

// ── Helpers ──
function statusColor(status) {
    const colors = {
        pending: 'bg-yellow-900 text-yellow-300',
        accepted: 'bg-blue-900 text-blue-300',
        delivering: 'bg-purple-900 text-purple-300',
        arrived_a: 'bg-green-900 text-green-300',
        arrived_b: 'bg-green-900 text-green-300',
        returning: 'bg-orange-900 text-orange-300',
        delivered: 'bg-zinc-700 text-zinc-300',
        cancelled: 'bg-red-900 text-red-300'
    };
    return colors[status] || 'bg-zinc-700 text-zinc-300';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showNotification(message) {
    const el = document.createElement('div');
    el.className = 'fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-[100] transition-opacity';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ── WASD Keyboard Controls ──
let keyboardInitialized = false;
function initKeyboardControls() {
    if (keyboardInitialized) return;
    keyboardInitialized = true;

    const keyMap = {
        'w': 'forward', 'arrowup': 'forward',
        's': 'backward', 'arrowdown': 'backward',
        'a': 'left', 'arrowleft': 'left',
        'd': 'right', 'arrowright': 'right',
    };

    document.addEventListener('keydown', (e) => {
        // Don't capture when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        const key = e.key.toLowerCase();
        const cmd = keyMap[key];
        if (!cmd) return;
        e.preventDefault();
        if (keysDown[key]) return; // Already held
        keysDown[key] = true;
        motorCmd(cmd);
    });

    document.addEventListener('keyup', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        const key = e.key.toLowerCase();
        if (!keyMap[key]) return;
        e.preventDefault();
        delete keysDown[key];
        // Only stop if no other movement keys held
        const anyHeld = Object.keys(keysDown).some(k => keyMap[k]);
        if (!anyHeld) motorCmd('stop');
    });
}

// ── Camera Expand ──
let cameraExpanded = false;
function toggleCameraExpand() {
    cameraExpanded = !cameraExpanded;
    const container = document.getElementById('camera-container');
    const nav = document.querySelector('#staff-page > nav');
    const btn = document.getElementById('camera-expand-btn');

    if (cameraExpanded) {
        container.classList.add('fixed', 'inset-0', 'z-50');
        if (nav) nav.classList.add('hidden');
        btn.textContent = '✕';
    } else {
        container.classList.remove('fixed', 'inset-0', 'z-50');
        if (nav) nav.classList.remove('hidden');
        btn.textContent = '⛶';
    }
}

// ── Minimap ──
function drawMinimap() {
    const canvas = document.getElementById('minimap-canvas');
    if (!canvas || mapPoints.length === 0) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    const padding = 20;
    const scaleX = (W - padding * 2) / 600;
    const scaleY = (H - padding * 2) / 700;
    const tx = (id) => {
        const p = mapPoints.find(m => m.pointId === id);
        return p ? { x: p.x * scaleX + padding, y: p.y * scaleY + padding } : null;
    };

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = 'rgba(24, 24, 27, 0.8)';
    ctx.fillRect(0, 0, W, H);

    // Draw connections — crossed lines shown in green
    const drawnMini = new Set();
    mapPoints.forEach(p => {
        const from = tx(p.pointId);
        if (!from) return;
        (p.connections || []).forEach(cId => {
            const key = [p.pointId, cId].sort().join('-');
            if (drawnMini.has(key)) return;
            drawnMini.add(key);
            const to = tx(cId);
            if (!to) return;
            const isCrossed = crossedLines.has(key);
            ctx.strokeStyle = isCrossed ? '#22c55e' : '#3f3f46';
            ctx.lineWidth = isCrossed ? 3 : 2;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
        });
    });

    // Highlight target A and B
    const targetA = sessionConfig?.target_point_a;
    const targetB = sessionConfig?.target_point_b;

    // Draw points
    mapPoints.forEach(p => {
        const pos = tx(p.pointId);
        if (!pos) return;

        const isTargetA = targetA && p.pointId === targetA;
        const isTargetB = targetB && p.pointId === targetB;

        let color = p.type === 'start' ? '#22c55e' :
                    p.type === 'destination' ? '#3b82f6' :
                    p.type === 'intersection' ? '#eab308' :
                    p.type === 'stop' ? '#ef4444' : '#71717a';

        const radius = (isTargetA || isTargetB) ? 10 : 7;

        // Glow ring for targets
        if (isTargetA || isTargetB) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
            ctx.strokeStyle = isTargetA ? '#f97316' : '#a855f7';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Label
        ctx.font = 'bold 8px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(p.pointId, pos.x, pos.y - radius - 3);

        // Target badge
        if (isTargetA) {
            ctx.font = 'bold 7px sans-serif';
            ctx.fillStyle = '#f97316';
            ctx.fillText('A ★', pos.x, pos.y + radius + 9);
        }
        if (isTargetB) {
            ctx.font = 'bold 7px sans-serif';
            ctx.fillStyle = '#a855f7';
            ctx.fillText('B ★', pos.x, pos.y + radius + 9);
        }
    });

    // Draw vehicle
    const vPos = tx(vehiclePos.pointId);
    if (vPos) {
        ctx.beginPath();
        ctx.arc(vPos.x, vPos.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}
