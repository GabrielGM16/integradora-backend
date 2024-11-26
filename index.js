const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const dotenv = require('dotenv');

// Configurar dotenv para cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Configurar conexión con PostgreSQL
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'ecommerce',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'linux',
});

// Automatización del esquema de tablas
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          price NUMERIC(10, 2) NOT NULL,
          stock INTEGER NOT NULL,
          seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          total NUMERIC(10, 2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          quantity INTEGER NOT NULL,
          price NUMERIC(10, 2) NOT NULL
      );
    `);
    console.log('Tablas creadas o ya existentes');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err);
  }
};

// Llama a la función para inicializar la base de datos
initDB();

// Middleware
app.use(cors());
app.use(express.json());

// Middleware para verificar tokens
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(403).json({ message: 'No se proporcionó un token' });
  }

  jwt.verify(token, process.env.SECRET_KEY || 'secretkey', (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: 'Token no válido' });
    }
    req.user = decoded;
    next();
  });
};

// Subir producto
app.post('/upload-product', verifyToken, async (req, res) => {
  const { name, price, stock } = req.body;

  if (!name || !price || !stock) {
    return res.status(400).json({ message: 'Todos los campos son obligatorios' });
  }

  if (req.user.role !== 'seller') {
    return res.status(403).json({ message: 'Solo los vendedores pueden subir productos' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO products (name, price, stock, seller_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, price, stock, req.user.id]
    );
    res.status(201).json({ message: 'Producto subido exitosamente', product: result.rows[0] });
  } catch (err) {
    console.error('Error al subir producto:', err);
    res.status(500).json({ message: 'Error al subir producto' });
  }
});

// Obtener productos con stock
app.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE stock > 0');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener productos:', err);
    res.status(500).json({ message: 'Error al obtener productos' });
  }
});

// Eliminar producto
app.delete('/products/:id', verifyToken, async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== 'seller') {
    return res.status(403).json({ message: 'Solo los vendedores pueden eliminar productos' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND seller_id = $2 RETURNING *',
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Producto no encontrado o no tienes permiso para eliminarlo' });
    }

    res.status(200).json({ message: 'Producto eliminado exitosamente' });
  } catch (err) {
    console.error('Error al eliminar producto:', err);
    res.status(500).json({ message: 'Error al eliminar producto' });
  }
});

// Login
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  pool.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email, password], (err, result) => {
    if (err || result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas' });
    }

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.SECRET_KEY || 'secretkey',
      { expiresIn: '1h' }
    );
    res.json({ message: 'Inicio de sesión exitoso', token, role: user.role });
  });
});

// Registro
app.post('/register', async (req, res) => {
  const { email, password, role } = req.body;

  const validRoles = ['buyer', 'seller'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ message: 'Rol inválido' });
  }

  try {
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (existingUser.rowCount > 0) {
      return res.status(400).json({ message: 'El usuario ya existe' });
    }

    const result = await pool.query(
      'INSERT INTO users (email, password, role) VALUES ($1, $2, $3) RETURNING *',
      [email, password, role]
    );

    res.status(201).json({ message: 'Usuario registrado exitosamente', user: result.rows[0] });
  } catch (err) {
    console.error('Error al registrar usuario:', err);
    res.status(500).json({ message: 'Error al registrar usuario' });
  }
});

// Crear orden
app.post('/orders', verifyToken, async (req, res) => {
  const { products, total } = req.body;

  if (!products || products.length === 0 || !total) {
    return res.status(400).json({ message: 'Datos incompletos para procesar la orden.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO orders (buyer_id, total) VALUES ($1, $2) RETURNING id',
      [req.user.id, total]
    );

    const orderId = result.rows[0].id;

    for (const product of products) {
      await pool.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, product.id, product.quantity || 1, product.price]
      );
    }

    res.status(201).json({ message: 'Orden creada exitosamente', orderId });
  } catch (err) {
    console.error('Error al crear orden:', err);
    res.status(500).json({ message: 'Error al crear orden' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
