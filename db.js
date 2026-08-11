// Data-access layer: MySQL (production, via DATABASE_URL) or in-memory (sandbox demo preview)
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = 'fopilu12@gmail.com';
const ADMIN_PW = 'Qusar2006';

const SEED_PRODUCTS = [
  { name: 'تيشرت قطني N1 كلاسيك', category: 'تيشرت', price: 2500, description: 'قطن 100% خامة ثقيلة' },
  { name: 'تيشرت أوفرسايز أسود', category: 'تيشرت', price: 2900, description: 'قصّة عصرية واسعة' },
  { name: 'سروال جينز سليم', category: 'سراويل', price: 4500, description: 'جينز مرن مريح' },
  { name: 'سروال كارغو رمادي', category: 'سراويل', price: 5200, description: 'جيوب جانبية عملية' },
  { name: 'حذاء رياضي N1 رانر', category: 'أحذية', price: 6800, description: 'نعل خفيف مضاد للانزلاق' },
  { name: 'حذاء كاجوال جلد', category: 'أحذية', price: 7900, description: 'جلد طبيعي صناعة محلية' },
  { name: 'طقم جوارب رياضية (3 أزواج)', category: 'جوارب', price: 900, description: 'قطن ممتص للعرق' },
  { name: 'قبعة N1 سناباك', category: 'قبعات', price: 1500, description: 'تطريز شعار المتجر' },
  { name: 'طقم ملابس داخلية قطنية', category: 'ملابس داخلية', price: 1800, description: 'قطن ناعم عالي الجودة' }
];

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------
function mysqlImpl(url) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool(url);

  async function init() {
    await pool.execute(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(190) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT '',
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS sessions (
      token CHAR(64) PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at DATETIME NOT NULL
    )`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(190) NOT NULL,
      category VARCHAR(60) NOT NULL,
      price INT NOT NULL,
      image_url LONGTEXT DEFAULT NULL,
      description VARCHAR(500) DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_name VARCHAR(100) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      address VARCHAR(300) NOT NULL DEFAULT '',
      wilaya_code INT NOT NULL,
      wilaya_name VARCHAR(60) NOT NULL,
      shipping INT NOT NULL,
      items_total INT NOT NULL,
      total INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      user_email VARCHAR(190) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(190) NOT NULL,
      price INT NOT NULL,
      qty INT NOT NULL
    )`);

    // Seed admin account (server-side only, hashed)
    const [admins] = await pool.execute('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    if (admins.length === 0) {
      const hash = bcrypt.hashSync(ADMIN_PW, 10);
      await pool.execute(
        'INSERT INTO users (email, password_hash, name, is_admin) VALUES (?, ?, ?, TRUE)',
        [ADMIN_EMAIL, hash, 'مسؤول المتجر']
      );
    }

    // Seed products only if table is empty
    const [prods] = await pool.execute('SELECT COUNT(*) AS c FROM products');
    if (prods[0].c === 0) {
      for (const p of SEED_PRODUCTS) {
        await pool.execute(
          'INSERT INTO products (name, category, price, description) VALUES (?, ?, ?, ?)',
          [p.name, p.category, p.price, p.description]
        );
      }
    }
  }

  return {
    demo: false,
    init,
    async getUserByEmail(email) {
      const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
      return rows[0] || null;
    },
    async getUserById(id) {
      const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
      return rows[0] || null;
    },
    async createUser(email, passwordHash, name) {
      const [r] = await pool.execute(
        'INSERT INTO users (email, password_hash, name, is_admin) VALUES (?, ?, ?, FALSE)',
        [email, passwordHash, name]
      );
      return r.insertId;
    },
    async createSession(token, userId, expiresAt) {
      await pool.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expiresAt]);
    },
    async getSession(token) {
      const [rows] = await pool.execute('SELECT * FROM sessions WHERE token = ? AND expires_at > NOW()', [token]);
      return rows[0] || null;
    },
    async deleteSession(token) {
      await pool.execute('DELETE FROM sessions WHERE token = ?', [token]);
    },
    async listProducts(category) {
      if (category) {
        const [rows] = await pool.execute(
          'SELECT * FROM products WHERE active = TRUE AND category = ? ORDER BY id DESC', [category]);
        return rows;
      }
      const [rows] = await pool.execute('SELECT * FROM products WHERE active = TRUE ORDER BY id DESC');
      return rows;
    },
    async getProduct(id) {
      const [rows] = await pool.execute('SELECT * FROM products WHERE id = ? AND active = TRUE', [id]);
      return rows[0] || null;
    },
    async createProduct(p) {
      const [r] = await pool.execute(
        'INSERT INTO products (name, category, price, image_url, description) VALUES (?, ?, ?, ?, ?)',
        [p.name, p.category, p.price, p.image_url || null, p.description || '']
      );
      return r.insertId;
    },
    async updateProduct(id, p) {
      await pool.execute(
        'UPDATE products SET name = ?, category = ?, price = ?, image_url = ?, description = ? WHERE id = ?',
        [p.name, p.category, p.price, p.image_url || null, p.description || '', id]
      );
    },
    async deleteProduct(id) {
      await pool.execute('UPDATE products SET active = FALSE WHERE id = ?', [id]);
    },
    async createOrder(o, items) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.execute(
          `INSERT INTO orders (customer_name, phone, address, wilaya_code, wilaya_name, shipping, items_total, total, status, user_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [o.customer_name, o.phone, o.address, o.wilaya_code, o.wilaya_name, o.shipping, o.items_total, o.total, o.user_email || null]
        );
        const orderId = r.insertId;
        for (const it of items) {
          await conn.execute(
            'INSERT INTO order_items (order_id, product_id, product_name, price, qty) VALUES (?, ?, ?, ?, ?)',
            [orderId, it.product_id, it.product_name, it.price, it.qty]
          );
        }
        await conn.commit();
        return orderId;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    },
    async listOrders() {
      const [orders] = await pool.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
      if (orders.length === 0) return [];
      const ids = orders.map(o => o.id);
      const [items] = await pool.query('SELECT * FROM order_items WHERE order_id IN (?)', [ids]);
      const byOrder = {};
      for (const it of items) (byOrder[it.order_id] = byOrder[it.order_id] || []).push(it);
      return orders.map(o => ({ ...o, items: byOrder[o.id] || [] }));
    },
    async updateOrderStatus(id, status) {
      await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
    }
  };
}

// ---------------------------------------------------------------------------
// File-backed implementation — data persists to a JSON file on the server disk
// ---------------------------------------------------------------------------
function fileImpl() {
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = path.join(__dirname, 'data');
  const DATA_FILE = path.join(DATA_DIR, 'store.json');
  const sessions = new Map(); // sessions stay in memory (users just re-login)

  let state = { users: [], products: [], orders: [], uid: 1, pid: 1, oid: 1 };

  function persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('persist failed:', e.message);
    }
  }

  return {
    demo: false,
    async init() {
      try {
        if (fs.existsSync(DATA_FILE)) {
          state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
          console.log(`Loaded store file: ${state.products.length} products, ${state.orders.length} orders`);
        }
      } catch (e) {
        console.error('failed to load store file, starting fresh:', e.message);
      }
      if (!state.users.some(u => u.email === ADMIN_EMAIL)) {
        state.users.push({ id: state.uid++, email: ADMIN_EMAIL, password_hash: bcrypt.hashSync(ADMIN_PW, 10), name: 'مسؤول المتجر', is_admin: 1 });
      }
      if (state.products.length === 0) {
        for (const p of SEED_PRODUCTS) {
          state.products.push({ id: state.pid++, ...p, image_url: null, active: 1, created_at: new Date() });
        }
      }
      persist();
    },
    async getUserByEmail(email) { return state.users.find(u => u.email === email) || null; },
    async getUserById(id) { return state.users.find(u => u.id === id) || null; },
    async createUser(email, passwordHash, name) {
      const u = { id: state.uid++, email, password_hash: passwordHash, name, is_admin: 0 };
      state.users.push(u); persist(); return u.id;
    },
    async createSession(token, userId, expiresAt) { sessions.set(token, { token, user_id: userId, expires_at: expiresAt }); },
    async getSession(token) {
      const s = sessions.get(token);
      if (!s || new Date(s.expires_at) < new Date()) return null;
      return s;
    },
    async deleteSession(token) { sessions.delete(token); },
    async listProducts(category) {
      return state.products.filter(p => p.active && (!category || p.category === category)).slice().reverse();
    },
    async getProduct(id) { return state.products.find(p => p.id === id && p.active) || null; },
    async createProduct(p) {
      const np = { id: state.pid++, name: p.name, category: p.category, price: p.price, image_url: p.image_url || null, description: p.description || '', active: 1, created_at: new Date() };
      state.products.push(np); persist(); return np.id;
    },
    async updateProduct(id, p) {
      const t = state.products.find(x => x.id === id);
      if (t) { Object.assign(t, { name: p.name, category: p.category, price: p.price, image_url: p.image_url || null, description: p.description || '' }); persist(); }
    },
    async deleteProduct(id) {
      const t = state.products.find(x => x.id === id);
      if (t) { t.active = 0; persist(); }
    },
    async createOrder(o, items) {
      const no = { id: state.oid++, ...o, status: 'pending', created_at: new Date(), items };
      state.orders.push(no); persist(); return no.id;
    },
    async listOrders() { return state.orders.slice().reverse(); },
    async updateOrderStatus(id, status) {
      const t = state.orders.find(x => x.id === id);
      if (t) { t.status = status; persist(); }
    }
  };
}

const url = process.env.DATABASE_URL;
module.exports = url ? mysqlImpl(url) : fileImpl();
