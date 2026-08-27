const STORAGE_SALES = 'ventas';
const STORAGE_PRODUCTS = 'productos';

let ventas = loadData(STORAGE_SALES, []);
let productos = loadData(STORAGE_PRODUCTS, []);

function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

const currency = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initVentas();
  initProductos();
  initReportes();
  initExport();
  updateHeaderStats();

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('ventaFecha').value = today;
});

/* ---------------- PESTAÑAS ---------------- */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'reportes') renderReportes();
    });
  });
}

/* ---------------- VENTAS ---------------- */
function initVentas() {
  document.getElementById('btnNuevaVenta').addEventListener('click', openVentaModal);
  document.getElementById('searchVentas').addEventListener('input', renderVentas);
  document.getElementById('filterFecha').addEventListener('change', renderVentas);

  document.getElementById('formVenta').addEventListener('submit', (e) => {
    e.preventDefault();
    saveVenta();
  });

  ['ventaProducto', 'ventaCantidad', 'ventaPrecio'].forEach((id) => {
    document.getElementById(id).addEventListener('change', updateSubtotal);
    document.getElementById(id).addEventListener('input', updateSubtotal);
  });

  document.getElementById('ventaProducto').addEventListener('change', () => {
    const sel = document.getElementById('ventaProducto');
    const prod = productos.find((p) => p.id === sel.value);
    if (prod) {
      document.getElementById('ventaPrecio').value = prod.precio;
      updateSubtotal();
    }
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
}

function openVentaModal(id) {
  document.getElementById('modalVentaTitle').textContent = 'Nueva Venta';
  document.getElementById('formVenta').reset();
  document.getElementById('ventaId').value = '';
  document.getElementById('ventaFecha').value = new Date().toISOString().split('T')[0];

  const select = document.getElementById('ventaProducto');
  select.innerHTML = '<option value="">Seleccionar...</option>';
  productos.forEach((p) => {
    select.innerHTML += `<option value="${p.id}">${escapeHtml(p.nombre)} — ${currency(p.precio)}</option>`;
  });

  if (id) {
    const v = ventas.find((x) => x.id === id);
    if (!v) return;
    document.getElementById('modalVentaTitle').textContent = 'Editar Venta';
    document.getElementById('ventaId').value = v.id;
    document.getElementById('ventaProducto').value = v.productoId;
    document.getElementById('ventaCantidad').value = v.cantidad;
    document.getElementById('ventaPrecio').value = v.precio;
    document.getElementById('ventaCliente').value = v.cliente || '';
    document.getElementById('ventaFecha').value = v.fecha;
  }
  updateSubtotal();
  openModal('modalVenta');
}

function updateSubtotal() {
  const cant = parseFloat(document.getElementById('ventaCantidad').value) || 0;
  const prec = parseFloat(document.getElementById('ventaPrecio').value) || 0;
  document.getElementById('ventaSubtotal').value = currency(cant * prec);
}

function saveVenta() {
  const id = document.getElementById('ventaId').value;
  const productoId = document.getElementById('ventaProducto').value;
  const cantidad = parseFloat(document.getElementById('ventaCantidad').value);
  const precio = parseFloat(document.getElementById('ventaPrecio').value);
  const cliente = document.getElementById('ventaCliente').value.trim();
  const fecha = document.getElementById('ventaFecha').value;

  if (!productoId || !cantidad || precio === null || isNaN(precio)) return;

  const prod = productos.find((p) => p.id === productoId);
  const nombre = prod ? prod.nombre : 'Producto eliminado';

  if (id) {
    const idx = ventas.findIndex((v) => v.id === id);
    if (idx > -1) ventas[idx] = { ...ventas[idx], productoId, cantidad, precio, cliente, fecha };
    toast('Venta actualizada');
  } else {
    const nueva = {
      id: Date.now().toString(),
      fecha,
      productoId,
      productoNombre: nombre,
      cantidad,
      precio,
      cliente
    };
    ventas.push(nueva);
    if (prod) {
      prod.stock = (prod.stock || 0) - cantidad;
      if (prod.stock < 0) prod.stock = 0;
    }
    toast('Venta registrada');
  }

  saveData(STORAGE_SALES, ventas);
  saveData(STORAGE_PRODUCTS, productos);
  closeModal('modalVenta');
  renderVentas();
  updateProductosSelect();
  updateHeaderStats();
}

function renderVentas() {
  const search = document.getElementById('searchVentas').value.toLowerCase();
  const fecha = document.getElementById('filterFecha').value;

  const filtered = ventas.filter((v) => {
    const matchSearch = !search || (v.productoNombre || '').toLowerCase().includes(search) || (v.cliente || '').toLowerCase().includes(search);
    const matchFecha = !fecha || v.fecha === fecha;
    return matchSearch && matchFecha;
  }).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  const body = document.getElementById('ventasBody');
  body.innerHTML = '';

  filtered.forEach((v) => {
    const subtotal = v.cantidad * v.precio;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(v.fecha || '')}</td>
      <td>${escapeHtml(v.productoNombre || '')}</td>
      <td>${escapeHtml(v.cantidad)}</td>
      <td>${currency(v.precio)}</td>
      <td>${currency(subtotal)}</td>
      <td>${escapeHtml(v.cliente || '—')}</td>
      <td class="actions-cell">
        <button class="icon-btn edit" data-edit="${v.id}" title="Editar">✏️</button>
        <button class="icon-btn del" data-del="${v.id}" title="Eliminar">🗑️</button>
      </td>
    `;
    body.appendChild(row);
  });

  rowActions(body, 'edit', openVentaModal);
  rowActions(body, 'del', (id) => confirmDelete('venta', id, '¿Eliminar esta venta? Esta acción no se puede deshacer.'));

  document.getElementById('emptyVentas').style.display = filtered.length ? 'none' : 'block';
}

function rowActions(container, cls, handler) {
  container.querySelectorAll(`.icon-btn.${cls}`).forEach((btn) => {
    btn.addEventListener('click', () => handler(btn.dataset[cls === 'edit' ? 'edit' : 'del']));
  });
}

/* ---------------- PRODUCTOS ---------------- */
function initProductos() {
  document.getElementById('btnNuevoProducto').addEventListener('click', openProductoModal);
  document.getElementById('searchProductos').addEventListener('input', renderProductos);
  document.getElementById('formProducto').addEventListener('submit', (e) => {
    e.preventDefault();
    saveProducto();
  });
}

function openProductoModal(id) {
  document.getElementById('modalProductoTitle').textContent = 'Nuevo Producto';
  document.getElementById('formProducto').reset();
  document.getElementById('productoId').value = '';

  if (id) {
    const p = productos.find((x) => x.id === id);
    if (!p) return;
    document.getElementById('modalProductoTitle').textContent = 'Editar Producto';
    document.getElementById('productoId').value = p.id;
    document.getElementById('productoNombre').value = p.nombre;
    document.getElementById('productoPrecio').value = p.precio;
    document.getElementById('productoStock').value = p.stock || 0;
  }
  openModal('modalProducto');
}

function saveProducto() {
  const id = document.getElementById('productoId').value;
  const nombre = document.getElementById('productoNombre').value.trim();
  const precio = parseFloat(document.getElementById('productoPrecio').value);
  const stock = parseInt(document.getElementById('productoStock').value) || 0;
  if (!nombre || isNaN(precio)) return;

  if (id) {
    const idx = productos.findIndex((p) => p.id === id);
    if (idx > -1) productos[idx] = { ...productos[idx], nombre, precio, stock };
    toast('Producto actualizado');
  } else {
    productos.push({ id: Date.now().toString(), nombre, precio, stock });
    toast('Producto agregado');
  }

  saveData(STORAGE_PRODUCTS, productos);
  closeModal('modalProducto');
  renderProductos();
  updateProductosSelect();
  updateHeaderStats();
}

function renderProductos() {
  const search = document.getElementById('searchProductos').value.toLowerCase();
  const filtered = productos.filter((p) => !search || (p.nombre || '').toLowerCase().includes(search));

  const body = document.getElementById('productosBody');
  body.innerHTML = '';

  filtered.forEach((p) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(p.nombre)}</td>
      <td>${currency(p.precio)}</td>
      <td>${escapeHtml(p.stock || 0)}</td>
      <td class="actions-cell">
        <button class="icon-btn edit" data-edit="${p.id}" title="Editar">✏️</button>
        <button class="icon-btn del" data-del="${p.id}" title="Eliminar">🗑️</button>
      </td>
    `;
    body.appendChild(row);
  });

  rowActions(body, 'edit', openProductoModal);
  rowActions(body, 'del', (id) => confirmDelete('producto', id, '¿Eliminar este producto? Las ventas asociadas lo mostrarán como "Producto eliminado".'));

  document.getElementById('emptyProductos').style.display = filtered.length ? 'none' : 'block';
}

function updateProductosSelect() {
  const select = document.getElementById('ventaProducto');
  const current = select.value;
  const editing = document.getElementById('ventaId').value;
  if (!editing) {
    select.innerHTML = '<option value="">Seleccionar...</option>';
    productos.forEach((p) => {
      select.innerHTML += `<option value="${p.id}">${escapeHtml(p.nombre)} — ${currency(p.precio)}</option>`;
    });
    select.value = current;
  }
}

/* ---------------- REPORTES ---------------- */
function renderReportes() {
  const total = ventas.reduce((s, v) => s + v.cantidad * v.precio, 0);
  document.getElementById('statTotal').textContent = currency(total);

  const hoy = new Date().toISOString().split('T')[0];
  const ventasHoy = ventas.filter((v) => v.fecha === hoy);
  document.getElementById('statHoy').textContent = currency(ventasHoy.reduce((s, v) => s + v.cantidad * v.precio, 0));

  const mesActual = hoy.slice(0, 7);
  const ventasMes = ventas.filter((v) => (v.fecha || '').startsWith(mesActual));
  document.getElementById('statMes').textContent = currency(ventasMes.reduce((s, v) => s + v.cantidad * v.precio, 0));

  document.getElementById('statProductos').textContent = productos.length;

  renderMonthlyChart();
  renderTopProductos();
}

function renderMonthlyChart() {
  const byMonth = {};
  ventas.forEach((v) => {
    const month = (v.fecha || '').slice(0, 7);
    if (!month) return;
    if (!byMonth[month]) byMonth[month] = 0;
    byMonth[month] += v.cantidad * v.precio;
  });

  const months = Object.keys(byMonth).sort();
  const container = document.getElementById('monthlyChart');
  container.innerHTML = '';

  if (!months.length) {
    container.innerHTML = '<p class="muted">Sin datos.</p>';
    return;
  }

  const max = Math.max(...Object.values(byMonth));
  months.forEach((m) => {
    const value = byMonth[m];
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = Math.max(4, (value / max) * 100) + '%';
    bar.title = `${m}: ${currency(value)}`;
    const col = document.createElement('div');
    col.className = 'chart-col';
    col.innerHTML = `<div class="chart-bar-wrap"><span class="chart-value">${currency(value)}</span></div><span class="chart-label">${m}</span>`;
    col.querySelector('.chart-bar-wrap').appendChild(bar);
    container.appendChild(col);
  });
}

function renderTopProductos() {
  const byName = {};
  ventas.forEach((v) => {
    const name = v.productoNombre || 'Producto eliminado';
    if (!byName[name]) byName[name] = { unidades: 0, ingresos: 0 };
    byName[name].unidades += v.cantidad;
    byName[name].ingresos += v.cantidad * v.precio;
  });

  const sorted = Object.entries(byName).sort((a, b) => b[1].unidades - a[1].unidades).slice(0, 10);

  const body = document.getElementById('topProductosBody');
  body.innerHTML = '';
  sorted.forEach(([name, data]) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(name)}</td><td>${data.unidades}</td><td>${currency(data.ingresos)}</td>`;
    body.appendChild(row);
  });
  if (!sorted.length) body.innerHTML = '<tr><td colspan="3" class="muted">Sin datos.</td></tr>';
}

/* ---------------- EXPORT / BACKUP ---------------- */
function initExport() {
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnBackup').addEventListener('click', exportBackup);
  document.getElementById('btnImport').addEventListener('click', importBackup);
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function exportCSV() {
  const header = ['Fecha', 'Producto', 'Cantidad', 'Precio', 'Subtotal', 'Cliente'];
  const rows = ventas.map((v) => [
    v.fecha || '',
    v.productoNombre || '',
    v.cantidad,
    v.precio,
    v.cantidad * v.precio,
    v.cliente || ''
  ]);
  const content = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  const result = await window.api.exportCSV('ventas.csv', '\uFEFF' + content);
  if (result.success) toast('CSV exportado correctamente');
}

async function exportBackup() {
  const data = { productos, ventas };
  const result = await window.api.exportBackup('respaldo-ventas.json', JSON.stringify(data, null, 2));
  if (result.success) toast('Copia de seguridad guardada');
}

async function importBackup() {
  const result = await window.api.importBackup();
  if (!result.success) return;
  if (result.canceled) return;
  try {
    const data = result.data;
    if (Array.isArray(data.ventas)) ventas = data.ventas;
    if (Array.isArray(data.productos)) productos = data.productos;
    else if (Array.isArray(data)) { productos = data; ventas = []; }
    saveData(STORAGE_SALES, ventas);
    saveData(STORAGE_PRODUCTS, productos);
    renderVentas();
    renderProductos();
    updateProductosSelect();
    updateHeaderStats();
    toast('Copia importada correctamente');
  } catch (e) {
    toast('Error al importar la copia');
  }
}

/* ---------------- MODALES / COMUNES ---------------- */
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

let pendingDelete = null;

function confirmDelete(type, id, text) {
  pendingDelete = { type, id };
  document.getElementById('confirmText').textContent = text;
  openModal('modalConfirm');
}

document.getElementById('confirmYes').addEventListener('click', () => {
  if (!pendingDelete) return;
  if (pendingDelete.type === 'venta') {
    ventas = ventas.filter((v) => v.id !== pendingDelete.id);
    saveData(STORAGE_SALES, ventas);
    renderVentas();
    toast('Venta eliminada');
  } else {
    productos = productos.filter((p) => p.id !== pendingDelete.id);
    saveData(STORAGE_PRODUCTS, productos);
    renderProductos();
    updateProductosSelect();
    toast('Producto eliminado');
  }
  updateHeaderStats();
  pendingDelete = null;
  closeModal('modalConfirm');
});

function updateHeaderStats() {
  const total = ventas.reduce((s, v) => s + v.cantidad * v.precio, 0);
  document.getElementById('headerStats').innerHTML = `
    <span><strong>${ventas.length}</strong> ventas</span>
    <span><strong>${productos.length}</strong> productos</span>
    <span class="total-badge">${currency(total)}</span>
  `;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach((m) => m.classList.remove('open'));
  }
});
