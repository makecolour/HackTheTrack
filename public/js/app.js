/**
 * Delivery Bot — SE Preliminary Frontend
 * Single-page app with role-based views (Customer / Staff)
 */

// ── State ──
let token = localStorage.getItem('token');
let currentUser = null;
let socket = null;
let mapPoints = [];
let products = [];
let cart = {};
let myOrders = [];
let rfidScanning = false;
let vehiclePos = { pointId: 'S', positionType: 'unknown' };
let sessionConfig = null;
let keysDown = {};

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

    if (currentUser.role === 'customer') {
        document.getElementById('customer-page').classList.remove('hidden');
        document.getElementById('customer-name').textContent = currentUser.displayName || currentUser.username;
        loadProducts();
        loadMyOrders();
    } else {
        document.getElementById('staff-page').classList.remove('hidden');
        document.getElementById('staff-name').textContent = currentUser.displayName || currentUser.username;
        loadAllOrders();
        loadSessionConfig();
        showTab('orders');
    }
}

// ── Socket.IO ──
function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        console.log('Socket connected');
        if (currentUser.role === 'staff') {
            socket.emit('join-room', 'staff');
        } else {
            socket.emit('join-room', 'customer');
            socket.emit('join-customer', currentUser.id);
        }
    });

    // Real-time events
    socket.on('new-order', () => { if (currentUser.role === 'staff') loadAllOrders(); });
    socket.on('order-confirmed', (data) => {
        if (currentUser.role === 'staff') loadAllOrders();
        if (currentUser.role === 'customer') loadMyOrders();
        if (data.path) drawPathOnMap(data.path);
    });
    socket.on('order-arrived', (data) => {
        if (currentUser.role === 'customer') {
            loadMyOrders();
            showNotification(`Order #${data.order.id} arrived at ${data.order.destination_point}!`);
        }
        if (currentUser.role === 'staff') loadAllOrders();
    });
    socket.on('order-delivered', () => {
        if (currentUser.role === 'staff') loadAllOrders();
        if (currentUser.role === 'customer') loadMyOrders();
    });
    socket.on('vehicle-position', (data) => {
        vehiclePos = data;
        updateVehicleUI();
        drawMap();
        drawMinimap();
    });
    socket.on('vehicle-position-estimate', (data) => {
        // Interpolated position for smooth map rendering
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
    socket.on('session-configured', (data) => {
        showNotification(`Session configured: ${data.targetPointA || '?'} → ${data.targetPointB || '?'}`);
        loadMapPoints(); // Reload map points after sync
        loadSessionConfig(); // Update minimap targets
    });
    socket.on('payment-confirmed', (data) => {
        showNotification(`Payment confirmed for order #${data.orderId}`);
        if (currentUser.role === 'staff') loadAllOrders();
    });
    socket.on('invoice-ready', (invoice) => {
        showReceiptModal(invoice);
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
        populateDestinations();
        drawMap();
        drawMinimap();
    }
}

async function loadSessionConfig() {
    const data = await apiFetch('/api/session');
    if (data.success && data.data) {
        sessionConfig = data.data;
        drawMinimap();
    }
}

async function loadProducts() {
    const data = await apiFetch('/api/products');
    if (data.success) {
        products = data.data;
        renderProducts();
    }
}

async function loadMyOrders() {
    const data = await apiFetch('/api/orders/my');
    if (data.success) {
        myOrders = data.data;
        renderMyOrders();
    }
}

async function loadAllOrders() {
    const [pending, all] = await Promise.all([
        apiFetch('/api/orders/pending'),
        apiFetch('/api/orders')
    ]);
    if (pending.success) renderPendingOrders(pending.data);
    if (all.success) {
        allOrdersCache = all.data;
        renderAllOrders(all.data);
    }
}

// ── Customer UI ──
function populateDestinations() {
    const sel = document.getElementById('destination-select');
    if (!sel) return;
    const destinations = mapPoints.filter(p => p.type === 'destination');
    destinations.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.pointId;
        opt.textContent = `${p.pointId} — ${p.label}`;
        sel.appendChild(opt);
    });
}

function renderProducts() {
    const container = document.getElementById('product-list');
    if (!container) return;
    container.innerHTML = products.map(p => `
        <div class="bg-zinc-800 rounded-lg p-3 flex items-center justify-between">
            <div>
                <div class="font-bold text-sm">${escapeHtml(p.name)}</div>
                <div class="text-xs text-zinc-400">${escapeHtml(p.description || '')}</div>
                <div class="text-green-400 text-sm font-bold">${formatPrice(p.price)}</div>
            </div>
            <div class="flex items-center gap-2">
                <button onclick="changeQty(${p.id}, -1)" class="bg-zinc-700 hover:bg-zinc-600 w-8 h-8 rounded-lg font-bold">−</button>
                <span id="qty-${p.id}" class="w-8 text-center font-mono">${cart[p.id] || 0}</span>
                <button onclick="changeQty(${p.id}, 1)" class="bg-zinc-700 hover:bg-zinc-600 w-8 h-8 rounded-lg font-bold">+</button>
            </div>
        </div>
    `).join('');
}

function changeQty(productId, delta) {
    cart[productId] = Math.max(0, (cart[productId] || 0) + delta);
    document.getElementById(`qty-${productId}`).textContent = cart[productId];
    updateCartSummary();
}

function updateCartSummary() {
    const hasItems = Object.values(cart).some(q => q > 0);
    const summaryEl = document.getElementById('cart-summary');
    const btnEl = document.getElementById('place-order-btn');
    const dest = document.getElementById('destination-select').value;

    summaryEl.classList.toggle('hidden', !hasItems);
    btnEl.disabled = !hasItems || !dest;

    if (!hasItems) return;

    const itemsEl = document.getElementById('cart-items');
    let total = 0;
    itemsEl.innerHTML = '';
    for (const [pid, qty] of Object.entries(cart)) {
        if (qty <= 0) continue;
        const prod = products.find(p => p.id === Number(pid));
        if (!prod) continue;
        const subtotal = prod.price * qty;
        total += subtotal;
        itemsEl.innerHTML += `<div class="flex justify-between text-zinc-300"><span>${escapeHtml(prod.name)} x${qty}</span><span>${formatPrice(subtotal)}</span></div>`;
    }
    document.getElementById('cart-total').textContent = formatPrice(total);
}

// Listen for destination change
document.addEventListener('change', (e) => {
    if (e.target.id === 'destination-select') updateCartSummary();
});

async function placeOrder() {
    const dest = document.getElementById('destination-select').value;
    if (!dest) return;
    const items = [];
    for (const [pid, qty] of Object.entries(cart)) {
        if (qty <= 0) continue;
        const prod = products.find(p => p.id === Number(pid));
        if (prod) items.push({ productId: prod.id, name: prod.name, price: prod.price, quantity: qty });
    }
    if (items.length === 0) return;

    const data = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ items, destinationPoint: dest })
    });

    if (data.success) {
        cart = {};
        renderProducts();
        updateCartSummary();
        loadMyOrders();
        showNotification('Order placed!');
    }
}

function renderMyOrders() {
    const container = document.getElementById('order-tracking');
    const list = document.getElementById('order-status-list');
    if (!list || myOrders.length === 0) {
        if (container) container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    list.innerHTML = myOrders.slice(0, 10).map(o => `
        <div class="flex items-center justify-between bg-zinc-700 rounded-lg px-3 py-2">
            <div>
                <span class="font-mono text-xs">#${o.id}</span>
                <span class="ml-2">${escapeHtml(o.destination_point)}</span>
            </div>
            <span class="text-xs px-2 py-0.5 rounded-full ${statusColor(o.status)}">${o.status}</span>
            ${o.status === 'arrived' ? `<button onclick="confirmReceipt(${o.id})" class="ml-2 bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-xs font-bold">Received</button>` : ''}
        </div>
    `).join('');
}

async function confirmReceipt(orderId) {
    await apiFetch(`/api/orders/${orderId}/customer-confirm`, { method: 'PUT' });
    loadMyOrders();
    // Show payment modal
    openPaymentModal(orderId);
}

// ── Staff UI: Orders ──
function renderPendingOrders(orders) {
    document.getElementById('pending-count').textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;
    const container = document.getElementById('order-list');
    if (!container) return;
    container.innerHTML = orders.map(o => `
        <div class="bg-zinc-800 rounded-xl p-4">
            <div class="flex items-center justify-between mb-2">
                <span class="font-mono text-sm">#${o.id}</span>
                <span class="text-xs text-zinc-400">${o.customer_name || 'Guest'}</span>
            </div>
            <div class="text-sm mb-1">→ <strong>${escapeHtml(o.destination_point)}</strong></div>
            <div class="text-xs text-zinc-400 mb-2">${(o.items || []).map(i => `${escapeHtml(i.name)} x${i.quantity}`).join(', ')}</div>
            <div class="flex gap-2">
                <button onclick="confirmOrder(${o.id})" class="flex-1 bg-green-600 hover:bg-green-500 py-2 rounded-lg font-bold text-sm transition-colors">
                    Confirm & Deliver
                </button>
                <button onclick="cancelOrder(${o.id})" class="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-lg text-sm transition-colors">
                    Cancel
                </button>
            </div>
        </div>
    `).join('') || '<div class="text-zinc-500 text-sm text-center py-4">No pending orders</div>';
}

function renderAllOrders(orders) {
    const container = document.getElementById('all-order-list');
    if (!container) return;
    container.innerHTML = orders.slice(0, 20).map(o => `
        <div class="flex items-center justify-between bg-zinc-800 rounded-lg px-4 py-2 text-sm">
            <span class="font-mono">#${o.id}</span>
            <span>${escapeHtml(o.destination_point)}</span>
            <span class="text-xs">${o.customer_name || '-'}</span>
            <span class="px-2 py-0.5 rounded-full text-xs ${statusColor(o.status)}">${o.status}</span>
            ${o.status === 'delivered' ? `<button onclick="openPaymentModal(${o.id})" class="bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-xs font-bold">💳 Pay</button>` : ''}
        </div>
    `).join('');
}

async function confirmOrder(id) {
    await apiFetch(`/api/orders/${id}/confirm`, { method: 'PUT' });
    loadAllOrders();
}

async function cancelOrder(id) {
    await apiFetch(`/api/orders/${id}/cancel`, { method: 'PUT' });
    loadAllOrders();
}

// ── Staff UI: Drive ──
function motorCmd(command) {
    if (socket) socket.emit('motor-control', { command, speed: 50 });
}

function stopNavigation() {
    if (socket) socket.emit('stop-navigation');
    addNavLog({ message: 'Navigation stopped' });
}

function toggleRfid() {
    rfidScanning = !rfidScanning;
    if (socket) socket.emit(rfidScanning ? 'rfid-start-scan' : 'rfid-stop-scan');
    document.getElementById('rfid-btn').textContent = rfidScanning ? 'Stop RFID Scan' : 'Start RFID Scan';
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

    // Draw connections (roads)
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 3;
    const drawn = new Set();
    mapPoints.forEach(p => {
        const from = tx(p.pointId);
        if (!from) return;
        p.connections.forEach(cId => {
            const key = [p.pointId, cId].sort().join('-');
            if (drawn.has(key)) return;
            drawn.add(key);
            const to = tx(cId);
            if (!to) return;
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
        confirmed: 'bg-blue-900 text-blue-300',
        delivering: 'bg-purple-900 text-purple-300',
        arrived: 'bg-green-900 text-green-300',
        delivered: 'bg-zinc-700 text-zinc-300',
        cancelled: 'bg-red-900 text-red-300'
    };
    return colors[status] || 'bg-zinc-700 text-zinc-300';
}

function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + '₫';
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

// ── Payment & Invoice ──
let paymentOrderId = null;

function openPaymentModal(orderId) {
    paymentOrderId = orderId;
    const order = myOrders.find(o => o.id === orderId) || allOrdersCache.find(o => o.id === orderId);
    const body = document.getElementById('invoice-body');
    if (!order) {
        body.innerHTML = '<p class="text-zinc-400">Order not found</p>';
    } else {
        body.innerHTML = `
            <div class="space-y-3">
                <div class="flex justify-between text-sm">
                    <span class="text-zinc-400">Order</span>
                    <span class="font-mono font-bold">#${order.id}</span>
                </div>
                <div class="flex justify-between text-sm">
                    <span class="text-zinc-400">Customer</span>
                    <span>${escapeHtml(order.customer_name || 'Guest')}</span>
                </div>
                <div class="flex justify-between text-sm">
                    <span class="text-zinc-400">Destination</span>
                    <span class="font-bold">${escapeHtml(order.destination_point)}</span>
                </div>
                <hr class="border-zinc-700">
                <div class="space-y-1">
                    ${(order.items || []).map(i => `
                        <div class="flex justify-between text-sm">
                            <span>${escapeHtml(i.name)} × ${i.quantity}</span>
                            <span>${formatPrice(i.price * i.quantity)}</span>
                        </div>
                    `).join('')}
                </div>
                <hr class="border-zinc-700">
                <div class="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span class="text-green-400">${formatPrice(order.total_price)}</span>
                </div>
            </div>
        `;
    }
    document.getElementById('payment-modal').classList.remove('hidden');
}

function closePaymentModal() {
    document.getElementById('payment-modal').classList.add('hidden');
    paymentOrderId = null;
}

async function processPayment(method) {
    if (!paymentOrderId) return;
    const data = await apiFetch(`/api/orders/${paymentOrderId}/payment`, {
        method: 'POST',
        body: JSON.stringify({ method })
    });
    closePaymentModal();
    if (data.success) {
        showReceiptModal(data.data);
        showNotification(`Payment successful — ${method.toUpperCase()}`);
    }
    loadMyOrders();
}

function showReceiptModal(invoice) {
    const content = document.getElementById('receipt-content');
    content.innerHTML = `
        <div class="text-center mb-4">
            <div class="text-lg font-bold">🤖 Delivery Bot</div>
            <div class="text-xs text-gray-500">SE Preliminary — Invoice</div>
            <div class="text-xs text-gray-400 mt-1">${invoice.paidAt ? new Date(invoice.paidAt).toLocaleString('vi-VN') : ''}</div>
        </div>
        <div class="border-t border-dashed border-gray-300 my-2"></div>
        <div class="text-xs space-y-1">
            <div class="flex justify-between"><span>Invoice</span><span class="font-bold">${escapeHtml(invoice.invoiceId)}</span></div>
            <div class="flex justify-between"><span>Order</span><span>#${invoice.orderId}</span></div>
            <div class="flex justify-between"><span>Customer</span><span>${escapeHtml(invoice.customerName || '')}</span></div>
            <div class="flex justify-between"><span>Dest.</span><span>${escapeHtml(invoice.destination || '')}</span></div>
        </div>
        <div class="border-t border-dashed border-gray-300 my-2"></div>
        <div class="text-xs space-y-1">
            ${(invoice.items || []).map(i => `
                <div class="flex justify-between">
                    <span>${escapeHtml(i.name)} × ${i.quantity}</span>
                    <span>${formatPrice(i.subtotal || i.price * i.quantity)}</span>
                </div>
            `).join('')}
        </div>
        <div class="border-t border-dashed border-gray-300 my-2"></div>
        <div class="flex justify-between font-bold text-base">
            <span>TOTAL</span>
            <span>${formatPrice(invoice.totalPrice)}</span>
        </div>
        <div class="flex justify-between text-xs mt-1">
            <span>Method</span>
            <span class="uppercase font-bold">${escapeHtml(invoice.paymentMethod || 'cash')}</span>
        </div>
        <div class="text-center text-xs text-gray-400 mt-4">
            ✅ PAID — Thank you!
        </div>
    `;
    document.getElementById('receipt-modal').classList.remove('hidden');
}

function closeReceiptModal() {
    document.getElementById('receipt-modal').classList.add('hidden');
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

    // Draw connections
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 2;
    const drawn = new Set();
    mapPoints.forEach(p => {
        const from = tx(p.pointId);
        if (!from) return;
        (p.connections || []).forEach(cId => {
            const key = [p.pointId, cId].sort().join('-');
            if (drawn.has(key)) return;
            drawn.add(key);
            const to = tx(cId);
            if (!to) return;
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

// Track all orders for staff payment processing
let allOrdersCache = [];
