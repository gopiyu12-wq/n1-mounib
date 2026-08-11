const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { WILAYAS } = require('./wilayas');

const app = express();
const PORT = process.env.PORT || 3000;
const STORE_PHONE = '0779562200';
const CATEGORIES = ['ملابس داخلية', 'سراويل', 'تيشرت', 'جوارب', 'قبعات', 'أحذية'];

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

async function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await db.getSession(token);
  if (!s) return null;
  const u = await db.getUserById(s.user_id);
  return u || null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
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
    const token = crypto.randomBytes(32).toString('hex');
    await db.createSession(token, id, new Date(Date.now() + 7 * 24 * 3600 * 1000));
    setSessionCookie(res, token);
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
    const token = crypto.randomBytes(32).toString('hex');
    await db.createSession(token, u.id, new Date(Date.now() + 7 * 24 * 3600 * 1000));
    setSessionCookie(res, token);
    res.json({ user: { email: u.email, name: u.name, isAdmin: !!u.is_admin } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).session;
  if (token) await db.deleteSession(token).catch(() => {});
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: { email: u.email, name: u.name, isAdmin: !!u.is_admin } });
});

// --- Public data ---------------------------------------------------------------
app.get('/api/meta', (req, res) => {
  res.json({ wilayas: WILAYAS, categories: CATEGORIES, phone: STORE_PHONE, demo: db.demo });
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

// --- Orders (public create, prices validated server-side) -----------------------
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, address, wilayaCode, items } = req.body || {};
    if (!customerName || String(customerName).trim().length < 2) return res.status(400).json({ error: 'أدخل الاسم الكامل' });
    if (!phone || !/^0[567]\d{8}$/.test(String(phone).trim())) return res.status(400).json({ error: 'أدخل رقم هاتف جزائري صحيح (يبدأ بـ 05 أو 06 أو 07)' });
    const wilaya = WILAYAS.find(w => w.code === Number(wilayaCode));
    if (!wilaya) return res.status(400).json({ error: 'اختر الولاية' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'السلة فارغة' });
    if (items.length > 50) return res.status(400).json({ error: 'عدد المنتجات كبير جداً' });

    // Re-price everything on the server — never trust client totals
    const orderItems = [];
    let itemsTotal = 0;
    for (const it of items) {
      const p = await db.getProduct(Number(it.productId));
      if (!p) return res.status(400).json({ error: 'منتج غير موجود في السلة' });
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 20);
      orderItems.push({ product_id: p.id, product_name: p.name, price: p.price, qty });
      itemsTotal += p.price * qty;
    }

    const u = await currentUser(req);
    const orderId = await db.createOrder({
      customer_name: String(customerName).trim().slice(0, 100),
      phone: String(phone).trim(),
      address: String(address || '').trim().slice(0, 300),
      wilaya_code: wilaya.code,
      wilaya_name: wilaya.name,
      shipping: wilaya.shipping,
      items_total: itemsTotal,
      total: itemsTotal + wilaya.shipping,
      user_email: u ? u.email : null
    }, orderItems);

    res.json({ orderId, total: itemsTotal + wilaya.shipping, shipping: wilaya.shipping, phone: STORE_PHONE });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// --- Admin: products -------------------------------------------------------------
function validateProductBody(body) {
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const price = Math.round(Number(body.price));
  const image_url = String(body.imageUrl || '').trim();
  const description = String(body.description || '').trim().slice(0, 500);
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
  return { value: { name: name.slice(0, 190), category, price, image_url: img, description } };
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

// --- Boot ---------------------------------------------------------------------------
(async () => {
  await db.init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`N1|Mounib store running on 0.0.0.0:${PORT} (${process.env.DATABASE_URL ? 'MySQL' : 'file-storage'} mode)`);
  });
})();
