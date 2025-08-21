// server.js - Main Express Server
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const redis = require('redis');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const app = express();

// Database Connection Pool
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'urlshortener',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  max: 20, // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis Cache Setup
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retry_strategy: (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      return new Error('Redis connection refused');
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

// Middleware Setup
app.use(helmet()); // Security headers
app.use(compression()); // Gzip compression
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate Limiting
const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 account creation requests per windowMs
  message: 'Too many accounts created from this IP'
});

const shortenUrlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many URL shortening requests'
});

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Database Schema Creation
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_premium BOOLEAN DEFAULT FALSE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS urls (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        original_url TEXT NOT NULL,
        short_code VARCHAR(20) UNIQUE NOT NULL,
        custom_alias VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        click_count INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_short_code ON urls(short_code);
      CREATE INDEX IF NOT EXISTS idx_user_id ON urls(user_id);
      CREATE INDEX IF NOT EXISTS idx_created_at ON urls(created_at);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        url_id INTEGER REFERENCES urls(id),
        clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address INET,
        user_agent TEXT,
        referer TEXT,
        country VARCHAR(50),
        city VARCHAR(100)
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
  }
};

// Utility Functions
const generateShortCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 7; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const validateUrl = (url) => {
  return validator.isURL(url, {
    protocols: ['http', 'https'],
    require_protocol: true
  });
};

// Cache Helper Functions
const getCachedUrl = async (shortCode) => {
  try {
    const cached = await redisClient.get(`url:${shortCode}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
};

const setCachedUrl = async (shortCode, urlData) => {
  try {
    await redisClient.setex(`url:${shortCode}`, 3600, JSON.stringify(urlData)); // Cache for 1 hour
  } catch (error) {
    console.error('Cache set error:', error);
  }
};

// API Routes

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// User Registration
app.post('/api/auth/register', createAccountLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );

    const token = jwt.sign(
      { userId: result.rows[0].id, email: result.rows[0].email },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: result.rows[0].id,
        email: result.rows[0].email
      }
    });
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ error: 'Email already exists' });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shorten URL
app.post('/api/shorten', shortenUrlLimiter, authenticateToken, async (req, res) => {
  try {
    const { originalUrl, customAlias, expiresIn } = req.body;

    if (!validateUrl(originalUrl)) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    let shortCode = customAlias;
    
    if (customAlias) {
      // Check if custom alias already exists
      const existingAlias = await pool.query(
        'SELECT id FROM urls WHERE short_code = $1',
        [customAlias]
      );
      
      if (existingAlias.rows.length > 0) {
        return res.status(400).json({ error: 'Custom alias already taken' });
      }
    } else {
      // Generate unique short code
      do {
        shortCode = generateShortCode();
        const existing = await pool.query(
          'SELECT id FROM urls WHERE short_code = $1',
          [shortCode]
        );
        if (existing.rows.length === 0) break;
      } while (true);
    }

    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000); // days to milliseconds
    }

    const result = await pool.query(
      `INSERT INTO urls (user_id, original_url, short_code, custom_alias, expires_at) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.userId, originalUrl, shortCode, customAlias, expiresAt]
    );

    const urlData = result.rows[0];
    await setCachedUrl(shortCode, urlData);

    res.status(201).json({
      shortUrl: `${process.env.BASE_URL || 'https://linksnap.io'}/${shortCode}`,
      shortCode,
      originalUrl,
      expiresAt,
      createdAt: urlData.created_at
    });
  } catch (error) {
    console.error('Shorten URL error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Redirect Short URL
app.get('/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    
    // Try cache first
    let urlData = await getCachedUrl(shortCode);
    
    if (!urlData) {
      // Fallback to database
      const result = await pool.query(
        'SELECT * FROM urls WHERE short_code = $1 AND is_active = TRUE',
        [shortCode]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Short URL not found' });
      }
      
      urlData = result.rows[0];
      await setCachedUrl(shortCode, urlData);
    }

    // Check expiration
    if (urlData.expires_at && new Date() > new Date(urlData.expires_at)) {
      return res.status(410).json({ error: 'Short URL has expired' });
    }

    // Log analytics asynchronously
    setImmediate(async () => {
      try {
        await pool.query(
          'UPDATE urls SET click_count = click_count + 1 WHERE id = $1',
          [urlData.id]
        );

        await pool.query(
          `INSERT INTO analytics (url_id, ip_address, user_agent, referer) 
           VALUES ($1, $2, $3, $4)`,
          [
            urlData.id,
            req.ip,
            req.get('User-Agent'),
            req.get('Referer')
          ]
        );
      } catch (analyticsError) {
        console.error('Analytics logging error:', analyticsError);
      }
    });

    res.redirect(301, urlData.original_url);
  } catch (error) {
    console.error('Redirect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User URLs
app.get('/api/urls', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT id, original_url, short_code, custom_alias, created_at, 
              expires_at, click_count, is_active
       FROM urls 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.user.userId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM urls WHERE user_id = $1',
      [req.user.userId]
    );

    res.json({
      urls: result.rows.map(url => ({
        ...url,
        shortUrl: `${process.env.BASE_URL || 'https://linksnap.io'}/${url.short_code}`
      })),
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (error) {
    console.error('Get URLs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Analytics for specific URL
app.get('/api/analytics/:shortCode', authenticateToken, async (req, res) => {
  try {
    const { shortCode } = req.params;

    // Verify ownership
    const urlResult = await pool.query(
      'SELECT id FROM urls WHERE short_code = $1 AND user_id = $2',
      [shortCode, req.user.userId]
    );

    if (urlResult.rows.length === 0) {
      return res.status(404).json({ error: 'URL not found or access denied' });
    }

    const urlId = urlResult.rows[0].id;

    // Get click analytics
    const analyticsResult = await pool.query(
      `SELECT 
        DATE(clicked_at) as date,
        COUNT(*) as clicks
       FROM analytics 
       WHERE url_id = $1 
       GROUP BY DATE(clicked_at) 
       ORDER BY date DESC 
       LIMIT 30`,
      [urlId]
    );

    // Get total stats
    const statsResult = await pool.query(
      `SELECT 
        COUNT(*) as total_clicks,
        COUNT(DISTINCT DATE(clicked_at)) as active_days
       FROM analytics 
       WHERE url_id = $1`,
      [urlId]
    );

    res.json({
      dailyClicks: analyticsResult.rows,
      totalClicks: parseInt(statsResult.rows[0].total_clicks),
      activeDays: parseInt(statsResult.rows[0].active_days)
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Global Error Handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Server Startup
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  await redisClient.quit();
  process.exit(0);
});

startServer();