const ADMIN_TOKEN_STORAGE_KEY = 'neighbourbites_admin_token';
const LOCAL_ADMIN_API_BASE = 'http://localhost:3000/api/admin';
const LIVE_ADMIN_API_BASE = 'https://foodsood.onrender.com/api/admin';
const hostname = window.location.hostname;
const API_BASE = hostname === 'localhost' || hostname === '127.0.0.1'
  ? LOCAL_ADMIN_API_BASE
  : LIVE_ADMIN_API_BASE;

const state = {
  adminToken: localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '',
  activeTab: 'overview',
};

const els = {
  loginView: document.getElementById('login-view'),
  dashboardView: document.getElementById('dashboard-view'),
  loginForm: document.getElementById('login-form'),
  adminUsername: document.getElementById('admin-username'),
  adminPassword: document.getElementById('admin-password'),
  loginError: document.getElementById('login-error'),
  logoutBtn: document.getElementById('logout-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  pageTitle: document.getElementById('page-title'),
  globalError: document.getElementById('global-error'),
  metricsGrid: document.getElementById('metrics-grid'),
  recentUsers: document.getElementById('recent-users'),
  recentRequests: document.getElementById('recent-requests'),
  recentOrders: document.getElementById('recent-orders'),
  liveOrdersGrid: document.getElementById('live-orders-grid'),
  usersTable: document.getElementById('users-table'),
  requestsTable: document.getElementById('requests-table'),
  ordersTable: document.getElementById('orders-table'),
  offersTable: document.getElementById('offers-table'),
  dishesTable: document.getElementById('dishes-table'),
};

function setError(message = '') {
  if (!message) {
    els.globalError.classList.add('hidden');
    els.globalError.textContent = '';
    return;
  }
  els.globalError.textContent = message;
  els.globalError.classList.remove('hidden');
}

async function adminFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.adminToken ? { Authorization: `Bearer ${state.adminToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-link').forEach((node) => {
    node.classList.toggle('active', node.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((node) => {
    node.classList.toggle('hidden', node.id !== `tab-${tab}`);
  });
  const active = document.querySelector(`.nav-link[data-tab="${tab}"]`);
  els.pageTitle.textContent = active ? active.textContent : 'Overview';
}

function pillClass(status) {
  const value = String(status || '').toUpperCase();
  if (['PAID', 'DELIVERED', 'ACTIVE', 'READY', 'COMPLETED', 'TRUE'].includes(value)) return 'green';
  if (['HOLD', 'PENDING', 'OPEN', 'NEGOTIATING', 'CONFIRMED', 'COOKING'].includes(value)) return 'amber';
  if (['OUT_FOR_DELIVERY', 'BOTH'].includes(value)) return 'blue';
  if (['CANCELLED', 'REJECTED', 'EXPIRED', 'FALSE'].includes(value)) return 'red';
  return 'neutral';
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMetrics(metrics) {
  const items = [
    ['Users', metrics.users],
    ['Requests', metrics.requests],
    ['Open Requests', metrics.openRequests],
    ['Quotes', metrics.quotes],
    ['Orders', metrics.orders],
    ['Paid Orders', metrics.paidOrders],
    ['Active Orders', metrics.activeOrders],
    ['Today Board Dishes', metrics.liveDishes],
    ['Direct Offers', metrics.offers],
    ['Active Offers', metrics.activeOffers],
  ];
  els.metricsGrid.innerHTML = items.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </article>
  `).join('');
}

function renderCards(target, items, getHtml) {
  if (!items.length) {
    target.innerHTML = '<div class="empty-state">Nothing to show here yet.</div>';
    return;
  }
  target.innerHTML = items.map(getHtml).join('');
}

function renderTable(target, headers, rows, minWidth = 860) {
  if (!rows.length) {
    target.innerHTML = '<div class="empty-state">No matching records found.</div>';
    return;
  }
  target.innerHTML = `
    <table style="min-width:${minWidth}px">
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

async function loadOverview() {
  const data = await adminFetch('/dashboard');
  renderMetrics(data.metrics);
  renderCards(els.recentUsers, data.recentUsers, (item) => `
    <article class="list-card">
      <h4>${escapeHtml(item.name)}</h4>
      <div class="meta-row">
        <span class="pill ${pillClass(item.role)}">${escapeHtml(item.role)}</span>
        <span class="pill ${pillClass(String(item.isActive).toUpperCase())}">${item.isActive ? 'Active' : 'Disabled'}</span>
      </div>
      <p class="muted">${escapeHtml(item.city || 'No city')} · Joined ${escapeHtml(fmtDate(item.createdAt))}</p>
    </article>
  `);
  renderCards(els.recentRequests, data.recentRequests, (item) => `
    <article class="list-card">
      <h4>${escapeHtml(item.dishName)}</h4>
      <p>${escapeHtml(item.buyerName)} · ${escapeHtml(item.city || 'No city')}</p>
      <div class="meta-row">
        <span class="pill ${pillClass(item.status)}">${escapeHtml(item.status)}</span>
        <span class="pill neutral">₹${escapeHtml(item.budget)}</span>
        <span class="pill neutral">${escapeHtml(item.quotesCount)} quotes</span>
      </div>
    </article>
  `);
  renderTable(
    els.recentOrders,
    ['Dish', 'Buyer', 'Chef', 'Status', 'Payment', 'Price', 'Updated'],
    data.recentOrders.map((item) => `
      <tr>
        <td>${escapeHtml(item.dishName)}<div class="muted">${escapeHtml(item.delivery)}</div></td>
        <td>${escapeHtml(item.buyerName)}</td>
        <td>${escapeHtml(item.chefName)}</td>
        <td><span class="pill ${pillClass(item.status)}">${escapeHtml(item.status)}</span></td>
        <td><span class="pill ${pillClass(item.paymentStatus)}">${escapeHtml(item.paymentStatus)}</span></td>
        <td>₹${escapeHtml(item.finalPrice)}</td>
        <td>${escapeHtml(fmtDate(item.updatedAt))}</td>
      </tr>
    `),
    760,
  );
}

async function loadUsers() {
  const q = document.getElementById('users-search').value.trim();
  const role = document.getElementById('users-role').value;
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if (role) params.set('role', role);
  const data = await adminFetch(`/users?${params.toString()}`);
  renderTable(
    els.usersTable,
    ['User', 'Role', 'Status', 'City', 'Activity', 'Rating', 'Joined', 'Actions'],
    data.map((item) => `
      <tr>
        <td>
          <strong>${escapeHtml(item.name)}</strong>
          <div class="muted">${escapeHtml(item.phone)}</div>
          <div class="muted">${escapeHtml(item.email || 'No email')}</div>
        </td>
        <td><span class="pill ${pillClass(item.role)}">${escapeHtml(item.role)}</span></td>
        <td><span class="pill ${pillClass(String(item.isActive).toUpperCase())}">${item.isActive ? 'Active' : 'Disabled'}</span></td>
        <td>${escapeHtml(item.city || '—')}</td>
        <td>
          Buyer orders: ${escapeHtml(item.buyerOrdersCount)}<br />
          Chef orders: ${escapeHtml(item.chefOrdersCount)}<br />
          Requests: ${escapeHtml(item.requestsCount)}<br />
          Quotes: ${escapeHtml(item.quotesCount)}
        </td>
        <td>${escapeHtml(item.rating.toFixed(1))} (${escapeHtml(item.ratingCount)})</td>
        <td>${escapeHtml(fmtDate(item.createdAt))}</td>
        <td>
          <div class="table-actions">
            <button class="mini-btn ${item.isActive ? 'warn' : 'ok'}" data-action="toggle-user" data-id="${item.id}" data-active="${item.isActive}">
              ${item.isActive ? 'Disable' : 'Enable'}
            </button>
            <button class="mini-btn" data-action="change-role" data-id="${item.id}" data-role="${item.role}">
              Change Role
            </button>
          </div>
        </td>
      </tr>
    `),
    1180,
  );
}

function renderLiveOrders(items) {
  if (!items.length) {
    els.liveOrdersGrid.innerHTML = '<div class="empty-state">No active paid orders right now.</div>';
    return;
  }

  els.liveOrdersGrid.innerHTML = items.map((item) => `
    <article class="live-order-card">
      <div class="live-order-head">
        <div>
          <h3 class="live-order-title">${escapeHtml(item.food.dishName)}</h3>
          <div class="live-order-id">Order ${escapeHtml(item.id)}</div>
        </div>
        <div class="meta-row">
          <span class="pill ${pillClass(item.status.orderStatus)}">${escapeHtml(item.status.orderStatus)}</span>
          <span class="pill ${pillClass(item.status.paymentStatus)}">${escapeHtml(item.status.paymentStatus)}</span>
        </div>
      </div>

      <div class="live-order-section">
        <h4>Food</h4>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Category</span><span class="detail-value">${escapeHtml(item.food.category)}</span></div>
          <div class="detail-item"><span class="detail-label">Qty</span><span class="detail-value">${escapeHtml(item.food.qty)}</span></div>
          <div class="detail-item"><span class="detail-label">People</span><span class="detail-value">${escapeHtml(item.food.people)}</span></div>
          <div class="detail-item"><span class="detail-label">Spice</span><span class="detail-value">${escapeHtml(item.food.spiceLevel)}</span></div>
          <div class="detail-item full"><span class="detail-label">Preferences</span><span class="detail-value">${escapeHtml((item.food.preferences || []).join(', ') || '—')}</span></div>
          <div class="detail-item full"><span class="detail-label">Notes</span><span class="detail-value">${escapeHtml(item.food.notes || '—')}</span></div>
        </div>
      </div>

      <div class="live-order-section">
        <h4>Pricing</h4>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Starting Price</span><span class="detail-value">₹${escapeHtml(item.pricing.startingPrice)}</span></div>
          <div class="detail-item"><span class="detail-label">Quoted Price</span><span class="detail-value">₹${escapeHtml(item.pricing.quotedPrice)}</span></div>
          <div class="detail-item"><span class="detail-label">Last Counter</span><span class="detail-value">${item.pricing.lastCounterOffer ? `₹${escapeHtml(item.pricing.lastCounterOffer)}` : '—'}</span></div>
          <div class="detail-item"><span class="detail-label">Negotiated Price</span><span class="detail-value">₹${escapeHtml(item.pricing.negotiatedPrice)}</span></div>
        </div>
      </div>

      <div class="live-order-section">
        <h4>Buyer</h4>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Name</span><span class="detail-value">${escapeHtml(item.buyer.name)}</span></div>
          <div class="detail-item"><span class="detail-label">Phone</span><span class="detail-value">${escapeHtml(item.buyer.phone || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">Email</span><span class="detail-value">${escapeHtml(item.buyer.email || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">City</span><span class="detail-value">${escapeHtml(item.fulfillment.buyerCity || item.buyer.city || '—')}</span></div>
          <div class="detail-item full"><span class="detail-label">Address</span><span class="detail-value">${escapeHtml(item.fulfillment.buyerAddress || '—')}</span></div>
        </div>
      </div>

      <div class="live-order-section">
        <h4>Chef</h4>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Name</span><span class="detail-value">${escapeHtml(item.chef.name)}</span></div>
          <div class="detail-item"><span class="detail-label">Phone</span><span class="detail-value">${escapeHtml(item.chef.phone || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">Email</span><span class="detail-value">${escapeHtml(item.chef.email || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">Rating</span><span class="detail-value">${escapeHtml(item.chef.rating ?? '—')}</span></div>
          <div class="detail-item full"><span class="detail-label">Kitchen Address</span><span class="detail-value">${escapeHtml(item.fulfillment.chefAddress || item.chef.location || '—')}</span></div>
        </div>
      </div>

      <div class="live-order-section">
        <h4>Fulfillment</h4>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-label">Pickup / Delivery</span><span class="detail-value">${escapeHtml(item.fulfillment.deliveryMode)}</span></div>
          <div class="detail-item"><span class="detail-label">Quote Delivery</span><span class="detail-value">${escapeHtml(item.fulfillment.quoteDelivery)}</span></div>
          <div class="detail-item"><span class="detail-label">Cook Time</span><span class="detail-value">${escapeHtml(item.status.cookTime || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">Payment Ref</span><span class="detail-value">${escapeHtml(item.status.paymentRef || '—')}</span></div>
          <div class="detail-item"><span class="detail-label">Paid At</span><span class="detail-value">${escapeHtml(fmtDate(item.status.paidAt))}</span></div>
          <div class="detail-item"><span class="detail-label">Cooking Started</span><span class="detail-value">${escapeHtml(fmtDate(item.status.cookingStartedAt))}</span></div>
          <div class="detail-item"><span class="detail-label">Ready At</span><span class="detail-value">${escapeHtml(fmtDate(item.status.readyAt))}</span></div>
          <div class="detail-item full"><span class="detail-label">Chef Message</span><span class="detail-value">${escapeHtml(item.chefNote || '—')}</span></div>
        </div>
      </div>
    </article>
  `).join('');
}

async function loadRequests() {
  const q = document.getElementById('requests-search').value.trim();
  const status = document.getElementById('requests-status').value;
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const data = await adminFetch(`/requests?${params.toString()}`);
  renderTable(
    els.requestsTable,
    ['Dish', 'Buyer', 'Location', 'Budget', 'Delivery', 'Status', 'Quotes', 'Order', 'Created'],
    data.map((item) => `
      <tr>
        <td>
          <strong>${escapeHtml(item.dishName)}</strong>
          <div class="muted">${escapeHtml(item.category)} · ${escapeHtml(item.people)} people</div>
        </td>
        <td>${escapeHtml(item.buyerName)}<div class="muted">${escapeHtml(item.buyerPhone)}</div></td>
        <td>${escapeHtml(item.city || '—')}</td>
        <td>₹${escapeHtml(item.budget)}</td>
        <td>${escapeHtml(item.delivery)}</td>
        <td><span class="pill ${pillClass(item.status)}">${escapeHtml(item.status)}</span></td>
        <td>${escapeHtml(item.quotesCount)}</td>
        <td>${item.order ? `<span class="pill ${pillClass(item.order.status)}">${escapeHtml(item.order.status)}</span>` : '—'}</td>
        <td>${escapeHtml(fmtDate(item.createdAt))}</td>
      </tr>
    `),
    1120,
  );
}

async function loadOrders() {
  const q = document.getElementById('orders-search').value.trim();
  const status = document.getElementById('orders-status').value;
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const data = await adminFetch(`/orders?${params.toString()}`);
  renderTable(
    els.ordersTable,
    ['Dish', 'Buyer', 'Chef', 'Status', 'Payment', 'Cook Time', 'Delivery', 'Price', 'Updated'],
    data.map((item) => `
      <tr>
        <td>
          <strong>${escapeHtml(item.request.dishName)}</strong>
          <div class="muted">${escapeHtml(item.request.category)}</div>
        </td>
        <td>${escapeHtml(item.buyer.name)}<div class="muted">${escapeHtml(item.buyer.phone)}</div></td>
        <td>${escapeHtml(item.chef.name)}<div class="muted">${escapeHtml(item.chef.phone)}</div></td>
        <td><span class="pill ${pillClass(item.status)}">${escapeHtml(item.status)}</span></td>
        <td><span class="pill ${pillClass(item.paymentStatus)}">${escapeHtml(item.paymentStatus)}</span></td>
        <td>${escapeHtml(item.quote.cookTime || '—')}</td>
        <td>${escapeHtml(item.request.delivery)}</td>
        <td>₹${escapeHtml(item.finalPrice)}</td>
        <td>${escapeHtml(fmtDate(item.updatedAt))}</td>
      </tr>
    `),
    1200,
  );
}

async function loadLiveOrders() {
  const data = await adminFetch('/live-orders');
  renderLiveOrders(data);
}

async function loadOffers() {
  const q = document.getElementById('offers-search').value.trim();
  const status = document.getElementById('offers-status').value;
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const data = await adminFetch(`/offers?${params.toString()}`);
  renderTable(
    els.offersTable,
    ['Dish', 'Buyer', 'Status', 'Offer', 'Counter', 'Delivery', 'Payment Ref', 'Updated'],
    data.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.dishName)}</strong><div class="muted">${escapeHtml(item.dishEmoji)}</div></td>
        <td>${escapeHtml(item.buyerName)}</td>
        <td><span class="pill ${pillClass(item.status)}">${escapeHtml(item.status)}</span></td>
        <td>₹${escapeHtml(item.offerPrice)}</td>
        <td>${item.counterPrice ? `₹${escapeHtml(item.counterPrice)}` : '—'}</td>
        <td>${escapeHtml(item.deliveryMode || '—')}</td>
        <td>${escapeHtml(item.paymentRef || '—')}</td>
        <td>${escapeHtml(fmtDate(item.updatedAt))}</td>
      </tr>
    `),
    1000,
  );
}

async function loadDishes() {
  const q = document.getElementById('dishes-search').value.trim();
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  const data = await adminFetch(`/dishes?${params.toString()}`);
  renderTable(
    els.dishesTable,
    ['Dish', 'Chef', 'Cuisine', 'Tags', 'Price', 'Plates', 'Ready In', 'Created'],
    data.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.emoji)} ${escapeHtml(item.dishName)}</strong></td>
        <td>${escapeHtml(item.chef.name)}<div class="muted">${escapeHtml(item.chef.city || '—')}</div></td>
        <td>${escapeHtml(item.cuisine)}</td>
        <td>${escapeHtml((item.tags || []).join(', ') || '—')}</td>
        <td>₹${escapeHtml(item.pricePerPlate)}</td>
        <td>${escapeHtml(item.plates)}</td>
        <td>${escapeHtml(item.readyInMinutes)} min</td>
        <td>${escapeHtml(fmtDate(item.createdAt))}</td>
      </tr>
    `),
    1080,
  );
}

async function loadActiveTab() {
  setError('');
  try {
    if (state.activeTab === 'overview') await loadOverview();
    if (state.activeTab === 'live-orders') await loadLiveOrders();
    if (state.activeTab === 'users') await loadUsers();
    if (state.activeTab === 'requests') await loadRequests();
    if (state.activeTab === 'orders') await loadOrders();
    if (state.activeTab === 'offers') await loadOffers();
    if (state.activeTab === 'dishes') await loadDishes();
  } catch (error) {
    setError(error.message || 'Failed to load admin data.');
  }
}

async function bootDashboard() {
  await adminFetch('/me');
  els.loginView.classList.add('hidden');
  els.dashboardView.classList.remove('hidden');
  switchTab(state.activeTab);
  await loadActiveTab();
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.textContent = '';
  const username = els.adminUsername.value.trim();
  const password = els.adminPassword.value;
  if (!username || !password) {
    els.loginError.textContent = 'Username and password are required.';
    return;
  }
  try {
    const data = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(async (res) => {
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Login failed');
      return payload;
    });
    state.adminToken = data.token;
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, data.token);
    els.adminPassword.value = '';
    await bootDashboard();
  } catch (error) {
    els.loginError.textContent = error.message || 'Login failed';
  }
});

document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', async () => {
    switchTab(button.dataset.tab);
    await loadActiveTab();
  });
});

els.refreshBtn.addEventListener('click', loadActiveTab);
els.logoutBtn.addEventListener('click', () => {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  state.adminToken = '';
  els.dashboardView.classList.add('hidden');
  els.loginView.classList.remove('hidden');
});

document.getElementById('users-load').addEventListener('click', loadUsers);
document.getElementById('requests-load').addEventListener('click', loadRequests);
document.getElementById('orders-load').addEventListener('click', loadOrders);
document.getElementById('offers-load').addEventListener('click', loadOffers);
document.getElementById('dishes-load').addEventListener('click', loadDishes);

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    if (action === 'toggle-user') {
      const current = button.dataset.active === 'true';
      await adminFetch(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !current }),
      });
      await loadUsers();
      await loadOverview();
    }
    if (action === 'change-role') {
      const currentRole = button.dataset.role || 'BUYER';
      const nextRole = window.prompt('Enter new role: BUYER, CHEF, or BOTH', currentRole);
      if (!nextRole || !['BUYER', 'CHEF', 'BOTH'].includes(nextRole.toUpperCase())) return;
      await adminFetch(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole.toUpperCase() }),
      });
      await loadUsers();
      await loadOverview();
    }
  } catch (error) {
    setError(error.message || 'Action failed');
  }
});

if (state.adminToken) {
  bootDashboard().catch((error) => {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    state.adminToken = '';
    els.loginError.textContent = error.message || 'Session expired';
  });
}
