const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { WILAYAS } = require('./wilayas');
const chatbot = require('./chatbot');

const app = express();
const PORT = process.env.PORT || 3000;
const STORE_PHONE = '0779562200';
// Categories are dynamic (admin-managed) but cached in memory for synchronous validation.
// The cache is refreshed at boot and after every add/delete.
let CATEGORIES = ['سراويل', 'تيشرت', 'جوارب', 'قبعات', 'أحذية'];
async function refreshCategories() {
  try { CATEGORIES = await db.listCategories(); } catch (e) { console.error('categories load failed:', e.message); }
  return CATEGORIES;
}

app.use(express.json({ limit: '6mb' })); // large enough for an embedded product image (data URL)
app.use(express.static(path.join(__dirname, 'public')));

// --- Session helpers (token in HttpOnly cookie) ------------------------------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// --- Stateless signed tokens (survive server restarts / cold starts) ----------
// A token is  base64url(payload).base64url(HMAC-SHA256(payload))
// The signing secret is stable (env var), so tokens stay valid across restarts.
const SESSION_TTL = 30 * 24 * 3600; // 30 days
const SESSION_SECRET = process.env.SESSION_SECRET || 'n1-mounib-fallback-secret-change-me';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = str => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function signToken(userId) {
  const payload = b64url(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch { return null; }
  if (!data || !data.u || !data.e || data.e < Math.floor(Date.now() / 1000)) return null;
  return data.u;
}

async function currentUser(req) {
  const uid = verifyToken(parseCookies(req).session);
  if (!uid) return null;
  const u = await db.getUserById(uid);
  return u || null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

async function requireAdmin(req, res, next) {
  const u = await currentUser(req);
  if (!u || !u.is_admin) return res.status(403).json({ error: 'غير مصرح — هذه الصفحة خاصة بالمسؤول' });
  req.user = u;
  next();
}

// --- Auth --------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 6 أحرف على الأقل' });
    const existing = await db.getUserByEmail(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'هذا البريد مسجل مسبقاً — جرّب تسجيل الدخول' });
    const hash = bcrypt.hashSync(password, 10);
    const id = await db.createUser(email.toLowerCase(), hash, (name || '').slice(0, 100));
    setSessionCookie(res, signToken(id));
    res.json({ user: { email: email.toLowerCase(), name: name || '', isAdmin: false } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'أدخل البريد وكلمة السر' });
    const u = await db.getUserByEmail(String(email).toLowerCase());
    if (!u || !bcrypt.compareSync(password, u.password_hash)) {
      return res.status(401).json({ error: 'البريد أو كلمة السر غير صحيحة' });
    }
    setSessionCookie(res, signToken(u.id));
    res.json({ user: { email: u.email, name: u.name, isAdmin: !!u.is_admin } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: { email: u.email, name: u.name, isAdmin: !!u.is_admin } });
});

// --- Shipping rates (base list + admin overrides stored in the DB) --------------
async function effectiveWilayas() {
  let overrides = {};
  try { overrides = await db.getShippingOverrides(); } catch (e) { console.error('shipping overrides load failed:', e.message); }
  return WILAYAS.map(w => (overrides[w.code] != null ? { ...w, shipping: overrides[w.code] } : w));
}

// --- Public data ---------------------------------------------------------------
app.get('/api/meta', async (req, res) => {
  res.json({ wilayas: await effectiveWilayas(), categories: CATEGORIES, phone: STORE_PHONE, demo: db.demo });
});

app.get('/api/products', async (req, res) => {
  try {
    const category = req.query.category && CATEGORIES.includes(req.query.category) ? req.query.category : null;
    res.json({ products: await db.listProducts(category) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// --- Chat assistant (self-contained; no external service) -----------------------
app.post('/api/chat', async (req, res) => {
  try {
    const message = String((req.body || {}).message || '').slice(0, 500);
    const [products, wilayas] = await Promise.all([db.listProducts(null), effectiveWilayas()]);
    const answer = chatbot.reply(message, { products, categories: CATEGORIES, wilayas, phone: STORE_PHONE });
    res.json({ reply: answer.text });
  } catch (e) {
    console.error(e);
    res.json({ reply: `يمكنك التواصل مع المسؤول مباشرةً على ${STORE_PHONE} (واتساب متاح).` });
  }
});

// --- Orders (public create, prices validated server-side) -----------------------
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, address, wilayaCode, deliveryType, items } = req.body || {};
    if (!customerName || String(customerName).trim().length < 2) return res.status(400).json({ error: 'أدخل الاسم الكامل' });
    if (!phone || !/^0[567]\d{8}$/.test(String(phone).trim())) return res.status(400).json({ error: 'أدخل رقم هاتف جزائري صحيح (يبدأ بـ 05 أو 06 أو 07)' });
    const wilaya = (await effectiveWilayas()).find(w => w.code === Number(wilayaCode));
    if (!wilaya) return res.status(400).json({ error: 'اختر الولاية' });
    const delivery = deliveryType === 'office' ? 'office' : 'home';
    // Office (stop-desk) delivery is 200 DZD cheaper than home, with a 200 DZD floor
    const shipping = delivery === 'office' ? Math.max(wilaya.shipping - 200, 200) : wilaya.shipping;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'السلة فارغة' });
    if (items.length > 50) return res.status(400).json({ error: 'عدد المنتجات كبير جداً' });

    // Re-price everything on the server — never trust client totals
    const orderItems = [];
    let itemsTotal = 0;
    for (const it of items) {
      const p = await db.getProduct(Number(it.productId));
      if (!p) return res.status(400).json({ error: 'منتج غير موجود في السلة' });
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 20);
      // Validate variant choices against what the product actually offers.
      const colors = Array.isArray(p.colors) ? p.colors : [];
      const sizes = Array.isArray(p.sizes) ? p.sizes : [];
      let color = null, size = null;
      if (colors.length) {
        color = String(it.color || '').trim();
        if (!colors.includes(color)) return res.status(400).json({ error: `اختر اللون للمنتج «${p.name}»` });
      }
      if (sizes.length) {
        size = String(it.size || '').trim();
        if (!sizes.includes(size)) return res.status(400).json({ error: `اختر المقاس للمنتج «${p.name}»` });
      }
      orderItems.push({ product_id: p.id, product_name: p.name, price: p.price, qty, color, size });
      itemsTotal += p.price * qty;
    }

    const u = await currentUser(req);
    const orderId = await db.createOrder({
      customer_name: String(customerName).trim().slice(0, 100),
      phone: String(phone).trim(),
      address: String(address || '').trim().slice(0, 300),
      wilaya_code: wilaya.code,
      wilaya_name: wilaya.name,
      delivery_type: delivery,
      shipping,
      items_total: itemsTotal,
      total: itemsTotal + shipping,
      user_email: u ? u.email : null
    }, orderItems);

    res.json({ orderId, total: itemsTotal + shipping, shipping, deliveryType: delivery, phone: STORE_PHONE });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// --- Admin: products -------------------------------------------------------------
// Normalize an incoming variant list (colors/sizes): trim, drop blanks,
// de-duplicate, cap each label length and the number of options.
function cleanVariants(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= 30) break;
  }
  return out;
}

function validateProductBody(body) {
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const price = Math.round(Number(body.price));
  const image_url = String(body.imageUrl || '').trim();
  const description = String(body.description || '').trim().slice(0, 500);
  const colors = cleanVariants(body.colors);
  const sizes = cleanVariants(body.sizes);
  if (name.length < 2) return { error: 'أدخل اسم المنتج' };
  if (!CATEGORIES.includes(category)) return { error: 'فئة غير صالحة' };
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) return { error: 'أدخل سعراً صحيحاً' };
  // image can be either an https URL or an uploaded image embedded as a data URL
  let img = null;
  if (image_url) {
    if (/^https:\/\//.test(image_url)) {
      img = image_url.slice(0, 500);
    } else if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image_url)) {
      if (image_url.length > 4_500_000) return { error: 'حجم الصورة كبير جداً — اختر صورة أصغر' };
      img = image_url;
    } else {
      return { error: 'صورة غير صالحة — ارفع ملف صورة أو أدخل رابطاً يبدأ بـ https://' };
    }
  }
  return { value: { name: name.slice(0, 190), category, price, image_url: img, description, colors, sizes } };
}

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const v = validateProductBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const id = await db.createProduct(v.value);
  res.json({ id });
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const v = validateProductBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  await db.updateProduct(Number(req.params.id), v.value);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await db.deleteProduct(Number(req.params.id));
  res.json({ ok: true });
});

// --- Admin: orders -----------------------------------------------------------------
const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  res.json({ orders: await db.listOrders() });
});

app.put('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  await db.updateOrderStatus(Number(req.params.id), status);
  res.json({ ok: true });
});

// --- Admin: shipping rates ---------------------------------------------------------
app.get('/api/admin/shipping', requireAdmin, async (req, res) => {
  res.json({ wilayas: await effectiveWilayas() });
});

app.put('/api/admin/shipping/:code', requireAdmin, async (req, res) => {
  const code = Number(req.params.code);
  if (!WILAYAS.some(w => w.code === code)) return res.status(400).json({ error: 'ولاية غير صالحة' });
  const shipping = Math.round(Number((req.body || {}).shipping));
  if (!Number.isFinite(shipping) || shipping < 0 || shipping > 100000) {
    return res.status(400).json({ error: 'أدخل سعر توصيل صحيحاً (0 إلى 100000)' });
  }
  await db.setShippingRate(code, shipping);
  res.json({ ok: true, code, shipping });
});

// --- Admin: categories -------------------------------------------------------------
app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'اسم الفئة يجب أن يكون بين 2 و40 حرفاً' });
  if (CATEGORIES.includes(name)) return res.status(409).json({ error: 'هذه الفئة موجودة مسبقاً' });
  await db.addCategory(name);
  await refreshCategories();
  res.json({ ok: true, categories: CATEGORIES });
});

app.delete('/api/admin/categories/:name', requireAdmin, async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!CATEGORIES.includes(name)) return res.status(404).json({ error: 'الفئة غير موجودة' });
  const count = await db.countActiveProductsInCategory(name);
  if (count > 0) return res.status(409).json({ error: `لا يمكن حذف الفئة — بها ${count} منتج. احذف أو انقل منتجاتها أولاً` });
  await db.deleteCategory(name);
  await refreshCategories();
  res.json({ ok: true, categories: CATEGORIES });
});

// --- Boot ---------------------------------------------------------------------------
(async () => {
  await db.init();
  await refreshCategories();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MB1_shoop store running on 0.0.0.0:${PORT} (${process.env.DATABASE_URL ? 'MySQL' : 'file-storage'} mode)`);
  });
})();
