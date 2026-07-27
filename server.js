const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const MASTER_USER = 'admin';
const MASTER_PASS = 'arx_secret_2026!';
// Deterministic Master Token derived from secret key (never lost on server restart)
const MASTER_TOKEN = crypto.createHmac('sha256', 'arx_master_secret_key_2026').update(`${MASTER_USER}:${MASTER_PASS}`).digest('hex');

// PostgreSQL Database Connection
const pool = new Pool({
  user: 'supabase_admin',
  host: '10.0.1.20',
  database: 'postgres',
  password: '635ddc870eca917c87aa2fcbf0abeef59fe5a4e5608f14b055d2884e7b163bfc',
  port: 5432,
});

// Helper: Parse Cookie Header
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const key = parts.shift().trim();
      if (key) {
        try { list[key] = decodeURIComponent(parts.join('=')); } catch(e){ list[key] = parts.join('='); }
      }
    });
  }
  return list;
}

// 1. Login API Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === MASTER_USER && password === MASTER_PASS) {
    res.setHeader('Set-Cookie', `arx_token=${MASTER_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=864000`);
    return res.json({ success: true, token: MASTER_TOKEN });
  }
  return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos!' });
});

// Logout Endpoint
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `arx_token=; Path=/; Max-Age=0`);
  return res.json({ success: true });
});

// Auth Middleware for Protected API Endpoints & Dashboard HTML
app.use((req, res, next) => {
  if (req.path.startsWith('/r/') || req.path === '/login.html' || req.path === '/api/login') {
    return next();
  }

  const cookies = parseCookies(req);
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-arx-token'] || cookies.arx_token;

  if (token && token === MASTER_TOKEN) {
    return next();
  }

  if (req.accepts('html') || req.path === '/' || req.path === '/index.html') {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }

  return res.status(401).json({ error: 'Não autorizado. Realize o login primeiro.' });
});

// Serve Static Dashboard Files AFTER Auth Middleware
app.use(express.static(path.join(__dirname, 'public')));

// 2. API: Get Pipeline Metrics
app.get('/api/metrics', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) AS total,
        COUNT(CASE WHEN status = 'rendering' THEN 1 END) AS rendering,
        COUNT(CASE WHEN status = 'scheduled' THEN 1 END) AS scheduled,
        COUNT(CASE WHEN status = 'posted_linkedin' THEN 1 END) AS posted_linkedin,
        COUNT(CASE WHEN status = 'posted_instagram' THEN 1 END) AS posted_instagram,
        COUNT(CASE WHEN status = 'published' THEN 1 END) AS published
      FROM public.content_pipeline;
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. API: Get Posts List
app.get('/api/posts', async (req, res) => {
  try {
    const statusFilter = req.query.status;
    let query = `
      SELECT 
        id, topic, slides_data, media_paths, instagram_media_paths, status, 
        pdf_url, linkedin_caption, instagram_post_id, created_at, scheduled_at,
        CASE 
          WHEN status = 'rendering' THEN 25
          WHEN status = 'scheduled' THEN 75
          ELSE 100
        END AS progress_percentage
      FROM public.content_pipeline
    `;
    const params = [];

    if (statusFilter && statusFilter !== 'all') {
      query += ` WHERE status = $1`;
      params.push(statusFilter);
    }

    query += ` ORDER BY created_at DESC LIMIT 50;`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. API: Publish Post Immediately (Publicar Agora)
app.post('/api/posts/:id/publish-now', async (req, res) => {
  try {
    const postId = req.params.id;

    // Update scheduled_at to NOW() and status to published
    await pool.query(`
      UPDATE public.content_pipeline 
      SET scheduled_at = NOW(), status = 'published', updated_at = NOW() 
      WHERE id = $1;
    `, [postId]);

    // Trigger n8n publisher webhook
    const reqN8n = http.request({
      hostname: '172.18.0.1',
      port: 5678,
      path: `/webhook/publish-post-now?post_id=${postId}`,
      method: 'GET'
    }, () => {});
    reqN8n.on('error', () => {});
    reqN8n.end();

    res.json({ success: true, message: 'Disparo de publicação imediata enviado!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. API: Delete Post and Cleanup Media
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    
    const fetchRes = await pool.query(`SELECT media_paths, instagram_media_paths, pdf_url FROM public.content_pipeline WHERE id = $1`, [postId]);
    if (fetchRes.rows.length > 0) {
      const row = fetchRes.rows[0];
      const allMedia = [...(row.media_paths || []), ...(row.instagram_media_paths || [])];
      for (const mediaUrl of allMedia) {
        if (mediaUrl && mediaUrl.includes('icarodev.cloud')) {
          const fname = mediaUrl.split('/').pop();
          const localPath = path.join('/opt/content_factory/media', fname);
          if (fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch(e){}
          }
        }
      }
    }

    await pool.query(`DELETE FROM public.content_pipeline WHERE id = $1`, [postId]);
    res.json({ success: true, message: 'Post excluído permanentemente!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. API: Get Leads List
app.get('/api/v1/leads', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.id, l.instagram_user_id, l.instagram_handle, l.full_name, 
        l.email, l.is_following, l.status, l.delivered_url, l.created_at,
        p.topic AS source_post_topic
      FROM public.leads l
      LEFT JOIN public.content_pipeline p ON l.source_post_id = p.id
      ORDER BY l.created_at DESC LIMIT 100;
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. API: Get Lead Statistics
app.get('/api/v1/leads/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) AS total_leads,
        COUNT(CASE WHEN is_following = true THEN 1 END) AS followers_verified,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) AS delivered_count
      FROM public.leads;
    `);
    const row = result.rows[0];
    const total = parseInt(row.total_leads || '0', 10);
    const delivered = parseInt(row.delivered_count || '0', 10);
    const rate = total > 0 ? ((delivered / total) * 100).toFixed(1) + '%' : '0%';

    res.json({
      total_leads: total,
      followers_verified: parseInt(row.followers_verified || '0', 10),
      delivered_count: delivered,
      conversion_rate: rate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. API: Webhook for DM Lead Processing
app.post('/api/v1/leads/dm-webhook', async (req, res) => {
  try {
    const { sender_id, sender_handle, full_name, email, post_id, is_following, message_text } = req.body;
    if (!sender_id) return res.status(400).json({ error: 'sender_id é obrigatório' });

    let deliveredUrl = null;
    if (message_text) {
      const hash = crypto.createHash('md5').update(message_text + Date.now()).digest('hex').substring(0, 8);
      const shortCode = `r_${hash}`;
      await pool.query(`
        INSERT INTO public.short_links (short_code, original_url, post_id)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;
      `, [shortCode, message_text, post_id || null]);
      deliveredUrl = `https://conteudos.icarodev.cloud/r/${shortCode}`;
    }

    const result = await pool.query(`
      INSERT INTO public.leads (
        instagram_user_id, instagram_handle, full_name, email,
        source_post_id, is_following, status, delivered_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (instagram_user_id) DO UPDATE SET
        instagram_handle = COALESCE(EXCLUDED.instagram_handle, public.leads.instagram_handle),
        full_name = COALESCE(EXCLUDED.full_name, full_name),
        email = COALESCE(EXCLUDED.email, email),
        source_post_id = COALESCE(EXCLUDED.source_post_id, post_id),
        is_following = EXCLUDED.is_following,
        status = EXCLUDED.status,
        delivered_url = COALESCE(EXCLUDED.delivered_url, deliveredUrl),
        updated_at = NOW()
      RETURNING *;
    `, [
      sender_id,
      sender_handle || null,
      full_name || null,
      email || null,
      post_id || null,
      is_following ?? true,
      is_following ? 'delivered' : 'pending',
      deliveredUrl
    ]);

    res.json({ success: true, lead: result.rows[0], delivered_url: deliveredUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. API: Generate Secure Hashed Short Link
app.post('/api/shorten', async (req, res) => {
  try {
    const { original_url, post_id } = req.body;
    if (!original_url) return res.status(400).json({ error: 'A URL original é obrigatória!' });

    const hash = crypto.createHash('md5').update(original_url + Date.now()).digest('hex').substring(0, 8);
    const shortCode = `r_${hash}`;

    const result = await pool.query(`
      INSERT INTO public.short_links (short_code, original_url, post_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (short_code) DO UPDATE SET original_url = EXCLUDED.original_url
      RETURNING short_code, original_url, clicks;
    `, [shortCode, original_url, post_id || null]);

    const shortUrl = `https://conteudos.icarodev.cloud/r/${shortCode}`;
    res.json({ success: true, short_code: shortCode, short_url: shortUrl, original_url, clicks: result.rows[0].clicks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. API: Get All Hashed Short Links
app.get('/api/shortlinks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.short_code, s.original_url, s.clicks, s.created_at, p.topic
      FROM public.short_links s
      LEFT JOIN public.content_pipeline p ON s.post_id = p.id
      ORDER BY s.created_at DESC LIMIT 50;
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Secure Hashed Link Resolver & Click Tracker (`/r/:code`)
app.get('/r/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const result = await pool.query(`
      UPDATE public.short_links 
      SET clicks = clicks + 1 
      WHERE short_code = $1 
      RETURNING original_url;
    `, [code]);

    if (result.rows.length === 0) {
      return res.status(404).send('<h2>Link seguro expirado ou não encontrado.</h2>');
    }

    const targetUrl = result.rows[0].original_url;
    res.redirect(targetUrl);
  } catch (err) {
    res.status(500).send('Erro ao redirecionar.');
  }
});

// 12. API: Trigger New Custom Content Generation with Schedule Options
app.post('/api/generate', async (req, res) => {
  try {
    const { topic, channel, publish_mode, scheduled_at } = req.body;
    if (!topic) return res.status(400).json({ error: 'O tema é obrigatório!' });

    const postData = JSON.stringify({ 
      topic, 
      channel: channel || 'all',
      publish_mode: publish_mode || 'now',
      scheduled_at: scheduled_at || null 
    });

    const reqN8n = http.request({
      hostname: '172.18.0.1',
      port: 5678,
      path: '/webhook/content-factory-trigger',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (resN8n) => {
      let data = '';
      resN8n.on('data', c => data += c);
      resN8n.on('end', () => res.json({ success: true, message: publish_mode === 'now' ? 'Geração e publicação imediata iniciadas!' : 'Matéria agendada com sucesso para a data solicitada!' }));
    });

    reqN8n.on('error', (e) => res.json({ success: true, message: 'Solicitação enviada para a fila de processamento!' }));
    reqN8n.write(postData);
    reqN8n.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 9878;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Arx Content Factory Master Dashboard running on port ${PORT}`);
});
