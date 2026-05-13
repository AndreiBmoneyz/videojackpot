const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Raw body for Stripe webhooks
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const activeStreams = new Map();

const UPLOAD_DIR = '/app/uploads';
const THUMB_DIR = '/app/thumbs';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, req.session.userId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4','.mov','.avi','.mkv','.webm','.gif','.jpg','.jpeg','.png','.webp','.mp3','.wav','.aac','.ogg','.flac','.m4a'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    stream_slots INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS streams (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'My Stream',
    stream_key TEXT,
    file_path TEXT,
    file_name TEXT,
    thumb_path TEXT,
    video_volume INTEGER NOT NULL DEFAULT 100,
    video_muted BOOLEAN NOT NULL DEFAULT false,
    audio_tracks JSONB NOT NULL DEFAULT '[]',
    audio_volume INTEGER NOT NULL DEFAULT 100,
    audio_muted BOOLEAN NOT NULL DEFAULT false,
    resolution TEXT NOT NULL DEFAULT '1080p',
    status TEXT NOT NULL DEFAULT 'stopped',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).catch(console.error);

pool.query(`
  ALTER TABLE streams ADD COLUMN IF NOT EXISTS thumb_path TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';
`).catch(console.error);

// Stripe price IDs — create these in Stripe dashboard
const PLANS = {
  starter: { name: 'Starter', price: 2, slots: 1, priceId: process.env.STRIPE_PRICE_STARTER || '' },
  pro:     { name: 'Pro',     price: 5, slots: 1, priceId: process.env.STRIPE_PRICE_PRO || '' },
  creator: { name: 'Creator', price: 12, slots: 3, priceId: process.env.STRIPE_PRICE_CREATOR || '' },
  studio:  { name: 'Studio',  price: 20, slots: 6, priceId: process.env.STRIPE_PRICE_STUDIO || '' },
};

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}
function requireAuthApi(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/thumbs/:file', (req, res) => {
  const p = path.join(THUMB_DIR, path.basename(req.params.file));
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

async function generateThumb(filePath, streamId) {
  const thumbFile = 'thumb_' + streamId + '_' + Date.now() + '.jpg';
  const thumbPath = path.join(THUMB_DIR, thumbFile);
  return new Promise((resolve) => {
    const args = ['-i', filePath, '-ss', '0', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black', '-vframes', '1', '-y', thumbPath];
    const proc = spawn('ffmpeg', args);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(thumbPath)) resolve('/thumbs/' + thumbFile);
      else resolve(null);
    });
  });
}

function buildFFmpegArgs(stream) {
  const width = stream.resolution === '1080p' ? 1920 : 1280;
  const height = stream.resolution === '1080p' ? 1080 : 720;
  const ext = path.extname(stream.file_path || '').toLowerCase();
  const isImage = ['.jpg','.jpeg','.png','.webp'].includes(ext);
  const isGif = ext === '.gif';
  const tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks.filter(t => t.path && fs.existsSync(t.path)) : [];
  const hasAudioTracks = tracks.length > 0;
  const videoVol = stream.video_muted ? 0 : (stream.video_volume || 100) / 100;
  const audioVol = stream.audio_muted ? 0 : (stream.audio_volume || 100) / 100;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`;
  const rtmp = `rtmp://a.rtmp.youtube.com/live2/${stream.stream_key}`;
  const args = [];

  if (isImage) {
    args.push('-loop', '1', '-framerate', '30', '-i', stream.file_path);
  } else if (isGif) {
    args.push('-re', '-stream_loop', '-1', '-ignore_loop', '0', '-i', stream.file_path);
  } else {
    args.push('-re', '-stream_loop', '-1', '-i', stream.file_path);
  }

  for (const t of tracks) args.push('-stream_loop', '-1', '-i', t.path);

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-threads', '0',
    '-r', '30',
    '-g', '60',
    '-b:v', '2500k',
    '-bufsize', '5000k',
    '-maxrate', '2500k'
  );
  if (isImage) args.push('-tune', 'stillimage');
  args.push('-vf', vf);

  const videoHasAudio = !['.jpg','.jpeg','.png','.webp','.gif'].includes(ext);

  if (hasAudioTracks && videoHasAudio) {
    let fc = `[0:a]volume=${videoVol}[va];`;
    for (let i = 0; i < tracks.length; i++) fc += `[${i+1}:a]volume=${audioVol}[a${i}];`;
    const ins = ['[va]', ...tracks.map((_,i) => `[a${i}]`)].join('');
    fc += `${ins}amix=inputs=${tracks.length+1}:duration=longest[aout]`;
    args.push('-filter_complex', fc, '-map', '0:v', '-map', '[aout]');
  } else if (hasAudioTracks && !videoHasAudio) {
    if (tracks.length === 1) {
      args.push('-map', '0:v', '-map', '1:a', '-af', `volume=${audioVol}`);
    } else {
      let fc = '';
      for (let i = 0; i < tracks.length; i++) fc += `[${i+1}:a]volume=${audioVol}[a${i}];`;
      const ins = tracks.map((_,i) => `[a${i}]`).join('');
      fc += `${ins}concat=n=${tracks.length}:v=0:a=1[aout]`;
      args.push('-filter_complex', fc, '-map', '0:v', '-map', '[aout]');
    }
  } else if (!hasAudioTracks && videoHasAudio) {
    args.push('-map', '0:v', '-map', '0:a', '-af', `volume=${videoVol}`);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a');
  }

  args.push('-c:a', 'aac', '-b:a', '320k', '-ar', '44100', '-async', '1', '-f', 'flv', rtmp);
  return args;
}

function startFFmpeg(streamId, streamData) {
  if (!streamData.file_path || !fs.existsSync(streamData.file_path)) return;
  if (!streamData.stream_key) return;
  const existing = activeStreams.get(streamId);
  if (existing) {
    existing.restarting = true;
    try { existing.proc.kill('SIGKILL'); } catch(e) {}
  }
  const args = buildFFmpegArgs(streamData);
  const proc = spawn('ffmpeg', args);
  const entry = { proc, restarting: false, streamData: { ...streamData } };
  activeStreams.set(streamId, entry);
  proc.stderr.on('data', () => {});
  proc.on('close', () => {
    const current = activeStreams.get(streamId);
    if (current && !current.restarting) {
      setTimeout(() => {
        const cur = activeStreams.get(streamId);
        if (cur && !cur.restarting) startFFmpeg(streamId, cur.streamData);
      }, 3000);
    }
  });
}

// ==================== LANDING ====================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>StreamForCheap — 24/7 YouTube Streaming from $2/month</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a0a;--surface:#111;--surface2:#1a1a1a;--border:rgba(255,255,255,0.08);--text:#fff;--muted:#888;--accent:#aaff00;--accent-dim:rgba(170,255,0,0.1);--accent-dim2:rgba(170,255,0,0.05);}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden;}
a{text-decoration:none;color:inherit;}
nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(10,10,10,0.97);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;}
.nav-logo{font-size:20px;font-weight:800;letter-spacing:-0.5px;}
.nav-logo .g{color:var(--accent);}
.nav-links{display:flex;align-items:center;gap:8px;}
.nav-links a{font-size:13px;font-weight:700;letter-spacing:0.05em;color:#aaa;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:7px 14px;transition:all 0.15s;text-transform:uppercase;}
.nav-links a:hover{color:var(--accent);border-color:rgba(170,255,0,0.3);}
.nav-auth{display:flex;align-items:center;gap:10px;}
.nav-login{font-size:14px;color:var(--muted);transition:color 0.15s;}
.nav-login:hover{color:var(--text);}
.nav-btn{background:var(--accent);color:#000;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:700;transition:opacity 0.15s;}
.nav-btn:hover{opacity:0.85;color:#000;}
.hero{padding:140px 2rem 100px;text-align:center;max-width:900px;margin:0 auto;}
.hero-badge{display:inline-flex;align-items:center;gap:8px;background:var(--accent-dim);border:1px solid rgba(170,255,0,0.2);border-radius:99px;padding:6px 16px;font-size:13px;color:var(--accent);font-weight:600;margin-bottom:2rem;}
.hero h1{font-size:clamp(36px,6vw,72px);font-weight:900;line-height:1.05;letter-spacing:-2px;margin-bottom:1.5rem;}
.hero h1 span{color:var(--accent);}
.hero p{font-size:18px;color:var(--muted);line-height:1.7;max-width:600px;margin:0 auto 2.5rem;}
.hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.btn-primary{background:var(--accent);color:#000;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:800;transition:opacity 0.15s;cursor:pointer;border:none;}
.btn-primary:hover{opacity:0.85;}
.btn-secondary{background:var(--surface2);color:var(--text);padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;border:1px solid var(--border);transition:border-color 0.15s;cursor:pointer;}
.btn-secondary:hover{border-color:var(--accent);}
.hero-note{font-size:13px;color:var(--muted);margin-top:1rem;}
.stats{display:flex;justify-content:center;gap:3rem;padding:3rem 2rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border);flex-wrap:wrap;}
.stat{text-align:center;}
.stat-num{font-size:36px;font-weight:900;color:var(--accent);letter-spacing:-1px;}
.stat-label{font-size:13px;color:var(--muted);margin-top:4px;}
section{padding:80px 2rem;max-width:1100px;margin:0 auto;}
.section-label{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:12px;}
.section-title{font-size:clamp(28px,4vw,44px);font-weight:800;letter-spacing:-1px;margin-bottom:16px;}
.section-sub{font-size:16px;color:var(--muted);line-height:1.7;max-width:560px;}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px;margin-top:3rem;}
.step{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem;}
.step-num{width:40px;height:40px;border-radius:10px;background:var(--accent-dim);border:1px solid rgba(170,255,0,0.2);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:var(--accent);margin-bottom:1rem;}
.step h3{font-size:16px;font-weight:700;margin-bottom:8px;}
.step p{font-size:14px;color:var(--muted);line-height:1.6;}
.comparison{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-top:3rem;}
.comparison-header{display:grid;grid-template-columns:2fr 1fr 1fr;padding:1rem 1.5rem;background:var(--surface2);border-bottom:1px solid var(--border);font-size:14px;font-weight:700;}
.comparison-header .ours{color:var(--accent);}
.comparison-row{display:grid;grid-template-columns:2fr 1fr 1fr;padding:1rem 1.5rem;border-bottom:1px solid var(--border);font-size:14px;align-items:center;}
.comparison-row:last-child{border-bottom:none;}
.comparison-row .feature{color:var(--muted);}
.comparison-row .ours{color:var(--accent);font-weight:700;}
.comparison-row .theirs{color:#555;}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;margin-top:3rem;}
.pricing-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:2rem;position:relative;transition:border-color 0.15s;}
.pricing-card:hover{border-color:rgba(170,255,0,0.3);}
.pricing-card.featured{border-color:var(--accent);background:var(--accent-dim2);}
.pricing-badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#000;font-size:11px;font-weight:800;padding:4px 14px;border-radius:99px;white-space:nowrap;}
.plan-name{font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;}
.plan-price{font-size:48px;font-weight:900;letter-spacing:-2px;color:var(--text);margin-bottom:4px;}
.plan-price span{font-size:18px;font-weight:400;color:var(--muted);}
.plan-streams{font-size:14px;color:var(--muted);margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border);}
.plan-streams strong{color:var(--accent);}
.plan-features{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:1.5rem;}
.plan-features li{font-size:14px;color:#aaa;display:flex;align-items:center;gap:8px;}
.plan-features li::before{content:'✓';color:var(--accent);font-weight:700;flex-shrink:0;}
.plan-btn{width:100%;padding:12px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;border:none;transition:opacity 0.15s;text-align:center;display:block;}
.plan-btn-primary{background:var(--accent);color:#000;}
.plan-btn-primary:hover{opacity:0.85;}
.plan-btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border);}
.plan-btn-secondary:hover{border-color:var(--accent);}
.faq{margin-top:3rem;display:flex;flex-direction:column;gap:12px;}
.faq-item{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.faq-q{padding:1.25rem 1.5rem;font-size:15px;font-weight:600;cursor:pointer;display:flex;justify-content:space-between;align-items:center;}
.faq-q:hover{color:var(--accent);}
.faq-arrow{color:var(--muted);transition:transform 0.2s;font-size:12px;}
.faq-item.open .faq-arrow{transform:rotate(180deg);}
.faq-a{padding:0 1.5rem;max-height:0;overflow:hidden;transition:max-height 0.3s,padding 0.3s;font-size:14px;color:var(--muted);line-height:1.7;}
.faq-item.open .faq-a{max-height:200px;padding:0 1.5rem 1.25rem;}
footer{border-top:1px solid var(--border);padding:3rem 2rem;text-align:center;}
.footer-logo{font-size:20px;font-weight:800;margin-bottom:1rem;}
.footer-logo .g{color:var(--accent);}
.footer-links{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap;margin-bottom:1.5rem;}
.footer-links a{font-size:13px;color:var(--muted);transition:color 0.15s;}
.footer-links a:hover{color:var(--text);}
.footer-copy{font-size:12px;color:#444;}
@media(max-width:600px){.nav-links{display:none;}.comparison-header,.comparison-row{grid-template-columns:1.5fr 1fr 1fr;font-size:12px;padding:0.75rem 1rem;}}
</style>
</head>
<body>
<nav>
  <a href="/" class="nav-logo">stream<span class="g">forcheap</span></a>
  <div class="nav-links">
    <a href="#how">HOW IT WORKS</a>
    <a href="#pricing">PRICING</a>
    <a href="#faq">FAQ</a>
  </div>
  <div class="nav-auth">
    <a href="/login" class="nav-login">Log in</a>
    <a href="/register" class="nav-btn">Get started</a>
  </div>
</nav>
<div class="hero">
  <div class="hero-badge">🟢 Streams running 24/7</div>
  <h1>24/7 YouTube Streaming<br>from <span>$2/month</span></h1>
  <p>Upload your video, enter your stream key, and we stream it to YouTube forever. No PC needed. No technical knowledge required.</p>
  <div class="hero-btns">
    <button class="btn-primary" onclick="document.getElementById('pricing').scrollIntoView({behavior:'smooth'})">Start streaming — from $2/mo</button>
    <button class="btn-secondary" onclick="document.getElementById('how').scrollIntoView({behavior:'smooth'})">See how it works</button>
  </div>
  <div class="hero-note">Cancel anytime · No hidden fees</div>
</div>
<div class="stats">
  <div class="stat"><div class="stat-num">$2</div><div class="stat-label">starting per month</div></div>
  <div class="stat"><div class="stat-num">24/7</div><div class="stat-label">always streaming</div></div>
  <div class="stat"><div class="stat-num">1080p</div><div class="stat-label">full HD quality</div></div>
  <div class="stat"><div class="stat-num">10x</div><div class="stat-label">cheaper than competitors</div></div>
</div>
<section id="how">
  <div class="section-label">How it works</div>
  <div class="section-title">Up and running in 3 minutes</div>
  <p class="section-sub">No technical knowledge needed. If you can upload a file, you can set up a 24/7 stream.</p>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><h3>Create your account</h3><p>Sign up and choose your plan. Cancel anytime.</p></div>
    <div class="step"><div class="step-num">2</div><h3>Upload your content</h3><p>Upload any image, GIF, or video file. Add separate audio tracks too.</p></div>
    <div class="step"><div class="step-num">3</div><h3>Add your stream key</h3><p>Paste your YouTube stream key from YouTube Studio → Go Live → Stream.</p></div>
    <div class="step"><div class="step-num">4</div><h3>Hit start</h3><p>Your stream goes live instantly and runs 24/7. Turn off your PC — we handle everything.</p></div>
  </div>
</section>
<section>
  <div class="section-label">Comparison</div>
  <div class="section-title">Why pay more?</div>
  <p class="section-sub">We do exactly what the expensive tools do, for a fraction of the price.</p>
  <div class="comparison">
    <div class="comparison-header"><div>Feature</div><div class="ours">StreamForCheap</div><div>Competitors</div></div>
    <div class="comparison-row"><div class="feature">Price per stream</div><div class="ours">from $2/month</div><div class="theirs">$24–49/month</div></div>
    <div class="comparison-row"><div class="feature">24/7 streaming</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">1080p quality</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Image, GIF &amp; video support</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Auto-restart on crash</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#aaff00">✓</div></div>
    <div class="comparison-row"><div class="feature">Separate audio tracks</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗ extra cost</div></div>
    <div class="comparison-row"><div class="feature">Real-time volume control</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗</div></div>
    <div class="comparison-row"><div class="feature">No watermark</div><div class="ours" style="color:#aaff00">✓</div><div style="color:#f87171">✗ paid plans only</div></div>
  </div>
</section>
<section id="pricing">
  <div class="section-label">Pricing</div>
  <div class="section-title">Simple, honest pricing</div>
  <p class="section-sub">No hidden fees. No per-platform charges. No watermarks. Cancel anytime.</p>
  <div class="pricing-grid">
    <div class="pricing-card">
      <div class="plan-name">Starter</div>
      <div class="plan-price">$2<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — static image only</div>
      <ul class="plan-features"><li>720p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('starter')">Get started</button>
    </div>
    <div class="pricing-card featured">
      <div class="pricing-badge">MOST POPULAR</div>
      <div class="plan-name">Pro</div>
      <div class="plan-price">$5<span>/mo</span></div>
      <div class="plan-streams"><strong>1 stream</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-primary" onclick="choosePlan('pro')">Get started</button>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Creator</div>
      <div class="plan-price">$12<span>/mo</span></div>
      <div class="plan-streams"><strong>3 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('creator')">Get started</button>
    </div>
    <div class="pricing-card">
      <div class="plan-name">Studio</div>
      <div class="plan-price">$20<span>/mo</span></div>
      <div class="plan-streams"><strong>6 streams</strong> — image, GIF, or video loop</div>
      <ul class="plan-features"><li>1080p quality</li><li>24/7 streaming</li><li>Separate audio tracks</li><li>Real-time volume control</li><li>Auto-restart on crash</li><li>No watermark</li></ul>
      <button class="plan-btn plan-btn-secondary" onclick="choosePlan('studio')">Get started</button>
    </div>
  </div>
</section>
<section id="faq">
  <div class="section-label">FAQ</div>
  <div class="section-title">Got questions?</div>
  <div class="faq">
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Do I need to keep my computer on? <span class="faq-arrow">▼</span></div><div class="faq-a">No. Once you start your stream it runs on our servers 24/7. You can turn off your PC completely.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">What file types are supported? <span class="faq-arrow">▼</span></div><div class="faq-a">Images (JPG, PNG, WebP), GIFs, videos (MP4, MOV, AVI, MKV, WebM), and audio (MP3, WAV, AAC, OGG, FLAC).</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Where do I find my YouTube stream key? <span class="faq-arrow">▼</span></div><div class="faq-a">Go to YouTube Studio → Go Live → Stream. Keep it private — anyone with it can stream to your channel.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">What happens if the stream crashes? <span class="faq-arrow">▼</span></div><div class="faq-a">Our system automatically detects crashes and restarts your stream within seconds.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Can I use separate audio tracks? <span class="faq-arrow">▼</span></div><div class="faq-a">Yes. Upload multiple audio files and they play one after another in a loop. Control video and audio volume independently.</div></div>
    <div class="faq-item"><div class="faq-q" onclick="this.closest('.faq-item').classList.toggle('open')">Can I cancel anytime? <span class="faq-arrow">▼</span></div><div class="faq-a">Yes. Cancel anytime from your dashboard. No contracts, no cancellation fees. Your streams stop at the end of the billing period.</div></div>
  </div>
</section>
<footer>
  <div class="footer-logo">stream<span class="g">forcheap</span></div>
  <div class="footer-links"><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a><a href="/login">Login</a><a href="/register">Sign up</a></div>
  <div class="footer-copy">© 2026 StreamForCheap. The cheapest 24/7 streaming service on the internet.</div>
</footer>
<script>
function choosePlan(plan) {
  // Store chosen plan and redirect to register/login
  sessionStorage.setItem('chosen_plan', plan);
  fetch('/api/me').then(r => r.json()).then(data => {
    if (data.userId) {
      window.location.href = '/checkout?plan=' + plan;
    } else {
      window.location.href = '/register?plan=' + plan;
    }
  }).catch(() => {
    window.location.href = '/register?plan=' + plan;
  });
}
</script>
</body>
</html>`);
});

// ==================== AUTH ====================

app.get('/api/me', (req, res) => {
  res.json({ userId: req.session.userId || null });
});

app.get('/register', (req, res) => {
  const plan = req.query.plan || 'pro';
  if (req.session.userId) return res.redirect('/checkout?plan=' + plan);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sign Up — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;}
.card{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:440px;width:100%;}
.logo{font-size:20px;font-weight:800;margin-bottom:2rem;text-align:center;}.logo .g{color:#aaff00;}
h1{font-size:24px;font-weight:800;margin-bottom:8px;}.sub{color:#666;font-size:14px;margin-bottom:2rem;}
.plan-banner{background:rgba(170,255,0,0.08);border:1px solid rgba(170,255,0,0.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;}
.plan-banner .pname{font-size:15px;font-weight:700;color:#aaff00;}
.plan-banner .pprice{font-size:13px;color:#888;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
.btn{width:100%;padding:13px;background:#aaff00;color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:8px;}
.btn:hover{opacity:0.85;}.btn:disabled{opacity:0.5;cursor:not-allowed;}
.link{text-align:center;font-size:13px;color:#666;margin-top:1.5rem;}.link a{color:#aaff00;}
.error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><a href="/" style="text-decoration:none;color:inherit;">stream<span class="g">forcheap</span></a></div>
  <h1>Create account</h1>
  <p class="sub">You're signing up for the ${plan.charAt(0).toUpperCase()+plan.slice(1)} plan</p>
  <div class="plan-banner">
    <span class="pname">${plan.charAt(0).toUpperCase()+plan.slice(1)} Plan</span>
    <span class="pprice">$${PLANS[plan]?.price || 5}/month · cancel anytime</span>
  </div>
  <div class="error" id="error"></div>
  <div class="field"><label>Email address</label><input type="email" id="email" placeholder="you@example.com"/></div>
  <div class="field"><label>Password</label><input type="password" id="password" placeholder="Min 8 characters"/></div>
  <div class="field"><label>Confirm password</label><input type="password" id="password2" placeholder="Repeat password"/></div>
  <button class="btn" id="btn" onclick="register()">Continue to payment →</button>
  <div class="link">Already have an account? <a href="/login?plan=${plan}">Log in</a></div>
</div>
<script>
async function register(){
  const email=document.getElementById('email').value.trim();
  const pw=document.getElementById('password').value;
  const pw2=document.getElementById('password2').value;
  const err=document.getElementById('error');const btn=document.getElementById('btn');
  err.style.display='none';
  if(!email||!pw){err.textContent='Please fill in all fields';err.style.display='block';return;}
  if(pw.length<8){err.textContent='Password must be at least 8 characters';err.style.display='block';return;}
  if(pw!==pw2){err.textContent='Passwords do not match';err.style.display='block';return;}
  btn.disabled=true;btn.textContent='Creating account...';
  try{
    const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw,plan:'${plan}'})});
    const data=await res.json();
    if(data.error){err.textContent=data.error;err.style.display='block';btn.disabled=false;btn.textContent='Continue to payment →';return;}
    window.location.href='/checkout?plan=${plan}';
  }catch(e){err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='Continue to payment →';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')register();});
</script>
</body>
</html>`);
});

app.get('/login', (req, res) => {
  const plan = req.query.plan || '';
  if (req.session.userId) return res.redirect(plan ? '/checkout?plan='+plan : '/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Log In — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;}
.card{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:420px;width:100%;}
.logo{font-size:20px;font-weight:800;margin-bottom:2rem;text-align:center;}.logo .g{color:#aaff00;}
h1{font-size:24px;font-weight:800;margin-bottom:8px;}.sub{color:#666;font-size:14px;margin-bottom:2rem;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
.btn{width:100%;padding:13px;background:#aaff00;color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:8px;}
.btn:hover{opacity:0.85;}.btn:disabled{opacity:0.5;cursor:not-allowed;}
.link{text-align:center;font-size:13px;color:#666;margin-top:1.5rem;}.link a{color:#aaff00;}
.error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none;}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><a href="/" style="text-decoration:none;color:inherit;">stream<span class="g">forcheap</span></a></div>
  <h1>Welcome back</h1>
  <p class="sub">Log in to ${plan ? 'continue to checkout' : 'manage your streams'}</p>
  <div class="error" id="error"></div>
  <div class="field"><label>Email address</label><input type="email" id="email" placeholder="you@example.com"/></div>
  <div class="field"><label>Password</label><input type="password" id="password" placeholder="Your password"/></div>
  <button class="btn" id="btn" onclick="login()">Log in</button>
  <div class="link">Don't have an account? <a href="/register${plan?'?plan='+plan:''}">Sign up</a></div>
</div>
<script>
const redirectPlan='${plan}';
async function login(){
  const email=document.getElementById('email').value.trim();
  const pw=document.getElementById('password').value;
  const err=document.getElementById('error');const btn=document.getElementById('btn');
  err.style.display='none';
  if(!email||!pw){err.textContent='Please fill in all fields';err.style.display='block';return;}
  btn.disabled=true;btn.textContent='Logging in...';
  try{
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pw})});
    const data=await res.json();
    if(data.error){err.textContent=data.error;err.style.display='block';btn.disabled=false;btn.textContent='Log in';return;}
    if(redirectPlan){window.location.href='/checkout?plan='+redirectPlan;}
    else{window.location.href='/dashboard';}
  }catch(e){err.textContent='Something went wrong.';err.style.display='block';btn.disabled=false;btn.textContent='Log in';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script>
</body>
</html>`);
});

// ==================== CHECKOUT ====================

app.get('/checkout', requireAuth, async (req, res) => {
  const plan = req.query.plan || 'pro';
  const planData = PLANS[plan];
  if (!planData) return res.redirect('/');
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Checkout — StreamForCheap</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;}
.checkout-wrap{display:grid;grid-template-columns:1fr 1fr;gap:2rem;max-width:860px;width:100%;}
.order-summary{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2rem;}
.order-summary h2{font-size:18px;font-weight:800;margin-bottom:1.5rem;color:#888;text-transform:uppercase;font-size:12px;letter-spacing:0.1em;}
.plan-box{background:#1a1a1a;border:1px solid rgba(170,255,0,0.2);border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;}
.plan-box .pname{font-size:22px;font-weight:800;margin-bottom:4px;}
.plan-box .pdesc{font-size:14px;color:#888;margin-bottom:1rem;}
.plan-box .price-row{display:flex;align-items:baseline;gap:6px;}
.plan-box .price{font-size:42px;font-weight:900;color:#aaff00;}
.plan-box .per{font-size:16px;color:#888;}
.features{list-style:none;display:flex;flex-direction:column;gap:8px;}
.features li{font-size:14px;color:#aaa;display:flex;align-items:center;gap:8px;}
.features li::before{content:'✓';color:#aaff00;font-weight:700;}
.divider{border:none;border-top:1px solid rgba(255,255,255,0.08);margin:1.5rem 0;}
.total-row{display:flex;justify-content:space-between;align-items:center;font-size:16px;}
.total-row strong{font-size:20px;color:#aaff00;}
.payment-form{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2rem;}
.payment-form h2{font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:1.5rem;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:#888;display:block;margin-bottom:6px;}
.field input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:15px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus{border-color:#aaff00;}
#card-element{background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:14px;}
#card-errors{color:#f87171;font-size:13px;margin-top:8px;display:none;}
.pay-btn{width:100%;padding:15px;background:#aaff00;color:#000;font-size:16px;font-weight:800;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:16px;}
.pay-btn:hover{opacity:0.85;}.pay-btn:disabled{opacity:0.5;cursor:not-allowed;}
.secure-note{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;color:#555;margin-top:12px;}
.back-link{font-size:13px;color:#555;text-align:center;margin-top:1rem;display:block;}
.back-link:hover{color:#fff;}
@media(max-width:700px){.checkout-wrap{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="checkout-wrap">
  <div class="order-summary">
    <h2>Order Summary</h2>
    <div class="plan-box">
      <div class="pname">${planData.name} Plan</div>
      <div class="pdesc">${planData.slots} stream${planData.slots>1?'s':''} · 24/7 · Cancel anytime</div>
      <div class="price-row">
        <span class="price">$${planData.price}</span>
        <span class="per">/month</span>
      </div>
    </div>
    <ul class="features">
      <li>24/7 YouTube streaming</li>
      <li>${plan==='starter'?'720p quality':'1080p quality'}</li>
      <li>Separate audio tracks</li>
      <li>Auto-restart on crash</li>
      <li>No watermark</li>
      <li>Cancel anytime</li>
    </ul>
    <div class="divider"></div>
    <div class="total-row">
      <span>Total per month</span>
      <strong>$${planData.price}/mo</strong>
    </div>
  </div>
  <div class="payment-form">
    <h2>Payment Details</h2>
    <div class="field">
      <label>Email</label>
      <input type="text" value="${user.email}" disabled style="opacity:0.6;"/>
    </div>
    <div class="field">
      <label>Card details</label>
      <div id="card-element"></div>
      <div id="card-errors"></div>
    </div>
    <button class="pay-btn" id="pay-btn" onclick="handlePayment()">Subscribe — $${planData.price}/month</button>
    <div class="secure-note">🔒 Secured by Stripe · Cancel anytime</div>
    <a href="/#pricing" class="back-link">← Back to pricing</a>
  </div>
</div>
<script>
const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY}');
const elements = stripe.elements();
const card = elements.create('card', {
  style: {
    base: { color: '#fff', fontFamily: '-apple-system, sans-serif', fontSize: '15px', '::placeholder': { color: '#555' } },
    invalid: { color: '#f87171' }
  }
});
card.mount('#card-element');
card.on('change', e => {
  const err = document.getElementById('card-errors');
  if(e.error){err.textContent=e.error.message;err.style.display='block';}
  else{err.style.display='none';}
});

async function handlePayment(){
  const btn = document.getElementById('pay-btn');
  btn.disabled = true; btn.textContent = 'Processing...';
  try {
    const intentRes = await fetch('/api/create-subscription', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ plan: '${plan}' })
    });
    const intentData = await intentRes.json();
    if(intentData.error){ throw new Error(intentData.error); }

    const result = await stripe.confirmCardPayment(intentData.clientSecret, {
      payment_method: { card }
    });

    if(result.error){ throw new Error(result.error.message); }

    // Payment confirmed
    window.location.href = '/dashboard?welcome=1';
  } catch(e) {
    const err = document.getElementById('card-errors');
    err.textContent = e.message; err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Subscribe — $${planData.price}/month';
  }
}
</script>
</body>
</html>`);
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
  const streams = (await pool.query('SELECT * FROM streams WHERE user_id=$1 ORDER BY created_at DESC', [req.session.userId])).rows;
  const planSlots = { starter:1, pro:1, creator:3, studio:6 };
  const maxSlots = planSlots[user.plan] || 0;
  const liveMap = {};
  streams.forEach(s => { liveMap[s.id] = activeStreams.has(s.id); });
  const welcome = req.query.welcome === '1';
  const hasActivePlan = user.subscription_status === 'active' || user.plan !== 'free';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dashboard — StreamForCheap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a0a;--surface:#111;--surface2:#1a1a1a;--border:rgba(255,255,255,0.08);--accent:#aaff00;--muted:#888;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:#fff;min-height:100vh;}
a{text-decoration:none;color:inherit;}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100;}
.logo{font-size:18px;font-weight:800;}.logo .g{color:var(--accent);}
.topbar-right{display:flex;align-items:center;gap:16px;}
.plan-badge{background:rgba(170,255,0,0.1);border:1px solid rgba(170,255,0,0.2);color:var(--accent);font-size:12px;font-weight:700;padding:4px 12px;border-radius:99px;text-transform:uppercase;}
.logout{font-size:13px;color:var(--muted);}.logout:hover{color:#f87171;}
.main{max-width:900px;margin:0 auto;padding:84px 1rem 4rem;}
.welcome-banner{background:rgba(170,255,0,0.08);border:1px solid rgba(170,255,0,0.2);border-radius:12px;padding:1rem 1.5rem;margin-bottom:1.5rem;font-size:15px;color:var(--accent);display:${welcome?'block':'none'};}
.page-title{font-size:26px;font-weight:800;margin-bottom:4px;letter-spacing:-0.5px;}
.page-sub{font-size:14px;color:var(--muted);margin-bottom:2rem;}
.upgrade-banner{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:2rem;text-align:center;margin-bottom:1.5rem;}
.upgrade-banner h3{font-size:18px;font-weight:700;margin-bottom:8px;}
.upgrade-banner p{font-size:14px;color:var(--muted);margin-bottom:1.5rem;}
.upgrade-btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.streams-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.streams-header h2{font-size:16px;font-weight:700;}
.slots-info{font-size:13px;color:var(--muted);font-weight:400;}
.add-btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;transition:opacity 0.15s;}
.add-btn:hover{opacity:0.85;}.add-btn:disabled{opacity:0.4;cursor:not-allowed;}
.stream-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem;margin-bottom:12px;}
.stream-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:10px;}
.stream-name{font-size:17px;font-weight:700;}
.stream-status{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;}
.status-dot{width:8px;height:8px;border-radius:50%;}
.status-live{color:var(--accent);}.status-live .status-dot{background:var(--accent);animation:pulse 1.5s infinite;}
.status-stopped{color:var(--muted);}.status-stopped .status-dot{background:#444;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.stream-body{display:flex;gap:16px;margin-bottom:1rem;align-items:flex-start;flex-wrap:wrap;}
.stream-thumb{width:120px;height:68px;border-radius:8px;object-fit:cover;background:#000;flex-shrink:0;border:1px solid #222;}
.stream-thumb-placeholder{width:120px;height:68px;border-radius:8px;background:#1a1a1a;border:1px solid #222;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;}
.stream-info{display:flex;flex-direction:column;gap:6px;flex:1;}
.stream-info-item{font-size:13px;color:var(--muted);}
.stream-info-item strong{color:#ccc;}
.stream-actions{display:flex;gap:8px;flex-wrap:wrap;}
.btn-start{background:var(--accent);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:opacity 0.15s;}
.btn-start:hover:not(:disabled){opacity:0.85;}.btn-start:disabled{opacity:0.4;cursor:not-allowed;}
.btn-stop{background:rgba(248,113,113,0.1);color:#f87171;border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;}
.btn-stop:hover{background:rgba(248,113,113,0.2);}
.btn-edit{background:var(--surface2);color:#aaa;border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;}
.btn-edit:hover{border-color:var(--accent);color:var(--accent);}
.btn-delete{background:transparent;color:#555;border:1px solid #222;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;transition:all 0.15s;}
.btn-delete:hover{color:#f87171;border-color:#f87171;}
.empty-state{text-align:center;padding:4rem 2rem;background:var(--surface);border:1px dashed #222;border-radius:14px;}
.empty-icon{font-size:48px;margin-bottom:1rem;}
.empty-state h3{font-size:18px;font-weight:700;margin-bottom:8px;}
.empty-state p{font-size:14px;color:var(--muted);margin-bottom:1.5rem;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:200;display:none;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto;}
.modal-overlay.open{display:flex;}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:2rem;max-width:540px;width:100%;margin:auto;}
.modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;}
.modal-header h2{font-size:20px;font-weight:800;}
.modal-close{background:none;border:none;color:#555;font-size:22px;cursor:pointer;}.modal-close:hover{color:#fff;}
.field{margin-bottom:16px;}.field label{font-size:13px;color:var(--muted);display:block;margin-bottom:6px;}
.field input,.field select{width:100%;padding:11px 14px;background:var(--surface2);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:14px;outline:none;transition:border-color 0.15s;font-family:inherit;}
.field input:focus,.field select:focus{border-color:var(--accent);}
.field select option{background:#1a1a1a;}
.field-note{font-size:11px;color:#555;margin-top:5px;line-height:1.5;}
.section-divider{border:none;border-top:1px solid var(--border);margin:20px 0;}
.section-heading{font-size:13px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;}
.preview-wrap{position:relative;width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#000;border:1px solid #222;margin-bottom:10px;cursor:pointer;}
.preview-wrap img{width:100%;height:100%;object-fit:cover;}
.preview-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);opacity:0;transition:opacity 0.15s;}
.preview-wrap:hover .preview-overlay{opacity:1;}
.preview-overlay-text{color:#fff;font-size:14px;font-weight:600;}
.preview-overlay-icon{font-size:28px;margin-bottom:6px;}
.preview-empty{width:100%;aspect-ratio:16/9;border-radius:10px;border:1.5px dashed #2a2a2a;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:all 0.15s;margin-bottom:10px;background:transparent;}
.preview-empty:hover{border-color:var(--accent);background:rgba(170,255,0,0.03);}
.preview-empty-icon{font-size:32px;color:var(--accent);margin-bottom:8px;}
.preview-empty-text{font-size:13px;color:#555;}
.hidden-file{position:fixed;left:-9999px;opacity:0;width:0;height:0;}
.volume-row{display:flex;align-items:center;gap:12px;margin-top:10px;}
.volume-row label{font-size:12px;color:var(--muted);width:90px;flex-shrink:0;}
.volume-row input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:99px;background:#2a2a2a;outline:none;cursor:pointer;}
.volume-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;}
.vol-val{font-size:13px;font-weight:700;color:var(--accent);width:38px;text-align:right;flex-shrink:0;}
.mute-btn{padding:5px 12px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid #333;background:transparent;color:#666;transition:all 0.15s;flex-shrink:0;}
.mute-btn.muted{background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3);color:#f87171;}
.mute-btn:hover{border-color:var(--accent);color:var(--accent);}
.audio-tracks-list{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;}
.audio-track-item{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid #222;border-radius:8px;padding:8px 12px;}
.track-order-btns{display:flex;flex-direction:column;gap:2px;}
.track-order-btn{background:none;border:none;color:#555;cursor:pointer;font-size:10px;line-height:1;padding:1px 4px;transition:color 0.1s;}
.track-order-btn:hover{color:var(--accent);}
.track-name-text{flex:1;font-size:13px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.track-dur-text{font-size:12px;color:#555;flex-shrink:0;}
.track-remove-btn{background:none;border:none;color:#444;cursor:pointer;font-size:16px;padding:0 2px;transition:color 0.1s;}
.track-remove-btn:hover{color:#f87171;}
.add-audio-btn{width:100%;padding:10px;background:transparent;border:1.5px dashed #2a2a2a;border-radius:8px;color:#555;font-size:13px;cursor:pointer;position:relative;transition:all 0.15s;}
.add-audio-btn:hover{border-color:var(--accent);color:var(--accent);}
.add-audio-btn input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;}
.progress-wrap{margin-top:12px;display:none;}
.progress-track{height:4px;background:#222;border-radius:99px;overflow:hidden;}
.progress-fill{height:100%;background:var(--accent);border-radius:99px;width:0%;transition:width 0.3s;}
.progress-label{font-size:12px;color:var(--muted);margin-top:6px;}
.error-box{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:10px;display:none;}
.modal-btn{width:100%;padding:13px;background:var(--accent);color:#000;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:opacity 0.15s;margin-top:12px;}
.modal-btn:hover{opacity:0.85;}.modal-btn:disabled{opacity:0.4;cursor:not-allowed;}
.save-note{font-size:12px;color:#555;text-align:center;margin-top:8px;}
.live-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--accent);background:rgba(170,255,0,0.1);border:1px solid rgba(170,255,0,0.2);border-radius:99px;padding:2px 8px;margin-left:8px;vertical-align:middle;}
</style>
</head>
<body>
<div class="topbar">
  <a href="/" class="logo">stream<span class="g">forcheap</span></a>
  <div class="topbar-right">
    <span class="plan-badge">${user.plan}</span>
    <a href="/logout" class="logout">Log out</a>
  </div>
</div>

<input type="file" id="hidden-video-input" class="hidden-file" accept=".mp4,.mov,.avi,.mkv,.webm,.gif,.jpg,.jpeg,.png,.webp" onchange="handleVideoSelect(event)"/>

<div class="modal-overlay" id="stream-modal">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modal-title">Add stream</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="field"><label>Stream name</label><input type="text" id="stream-name" placeholder="My Lofi Stream"/></div>
    <div class="field">
      <label>YouTube Stream Key</label>
      <input type="password" id="stream-key" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx"/>
      <div class="field-note">YouTube Studio → Go Live → Stream. Keep it private.</div>
    </div>
    <div class="field">
      <label>Resolution</label>
      <select id="stream-res"><option value="720p">720p</option><option value="1080p" selected>1080p</option></select>
    </div>
    <hr class="section-divider"/>
    <div class="section-heading">🎬 Video / Image</div>
    <div id="preview-container"></div>
    <div class="volume-row">
      <label>Video volume</label>
      <input type="range" id="video-vol" min="0" max="100" value="100" oninput="onVolChange('video')"/>
      <span class="vol-val" id="video-vol-val">100%</span>
      <button class="mute-btn" id="video-mute-btn" onclick="toggleMute('video')">Mute</button>
    </div>
    <hr class="section-divider"/>
    <div class="section-heading">🎵 Audio Tracks <span style="font-size:11px;color:#555;font-weight:400;text-transform:none;letter-spacing:0;">(loop forever)</span></div>
    <div class="audio-tracks-list" id="audio-tracks-list"></div>
    <button class="add-audio-btn">
      <input type="file" id="audio-file-input" accept=".mp3,.wav,.aac,.ogg,.flac,.m4a" multiple onchange="handleAudioAdd(event)"/>
      + Add audio track
    </button>
    <div class="volume-row" style="margin-top:12px;">
      <label>Audio volume</label>
      <input type="range" id="audio-vol" min="0" max="100" value="100" oninput="onVolChange('audio')"/>
      <span class="vol-val" id="audio-vol-val">100%</span>
      <button class="mute-btn" id="audio-mute-btn" onclick="toggleMute('audio')">Mute</button>
    </div>
    <div class="progress-wrap" id="upload-progress">
      <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-label" id="progress-label">Uploading...</div>
    </div>
    <div class="error-box" id="modal-error"></div>
    <button class="modal-btn" id="save-btn" onclick="saveStream()">Save stream</button>
    <div class="save-note" id="save-note"></div>
  </div>
</div>

<div class="main">
  ${welcome?`<div class="welcome-banner">🎉 Welcome! Your subscription is active. Add your first stream below to get started.</div>`:''}
  <div class="page-title">Your Streams</div>
  <div class="page-sub">${user.email} · ${user.plan} plan</div>

  ${!hasActivePlan?`
  <div class="upgrade-banner">
    <h3>No active subscription</h3>
    <p>Choose a plan to start streaming 24/7 to YouTube.</p>
    <a href="/#pricing" class="upgrade-btn">View plans →</a>
  </div>
  `:`
  <div class="streams-header">
    <h2>Streams <span class="slots-info">(${streams.length}/${maxSlots} slots used)</span></h2>
    <button class="add-btn" ${streams.length>=maxSlots?'disabled':''} onclick="openModal()">+ Add stream</button>
  </div>
  <div id="streams-list">
    ${streams.length===0?`
    <div class="empty-state">
      <div class="empty-icon">📡</div>
      <h3>No streams yet</h3>
      <p>Add your first stream to get started. It only takes a minute.</p>
      <button class="add-btn" onclick="openModal()">+ Add your first stream</button>
    </div>`:streams.map(s=>{
      const isLive = activeStreams.has(s.id);
      const tracks = Array.isArray(s.audio_tracks) ? s.audio_tracks : [];
      const thumbHtml = s.thumb_path
        ? `<img class="stream-thumb" src="${s.thumb_path}" alt="thumb"/>`
        : `<div class="stream-thumb-placeholder">📡</div>`;
      return `<div class="stream-card" id="stream-${s.id}">
        <div class="stream-top">
          <div class="stream-name">${s.name}</div>
          <div class="stream-status ${isLive?'status-live':'status-stopped'}">
            <div class="status-dot"></div>${isLive?'🔴 LIVE':'Stopped'}
          </div>
        </div>
        <div class="stream-body">
          ${thumbHtml}
          <div class="stream-info">
            <div class="stream-info-item"><strong>File:</strong> ${s.file_name||'No file uploaded'}</div>
            <div class="stream-info-item"><strong>Audio tracks:</strong> ${tracks.length}</div>
            <div class="stream-info-item"><strong>Resolution:</strong> ${s.resolution}</div>
            <div class="stream-info-item"><strong>Stream key:</strong> ${s.stream_key?'••••••••':'Not set'}</div>
          </div>
        </div>
        <div class="stream-actions">
          ${!isLive?`<button class="btn-start" onclick="startStream(${s.id})" ${!s.file_path||!s.stream_key?'disabled':''}>${!s.file_path||!s.stream_key?'⚠ Missing file or key':'▶ Start stream'}</button>`:''}
          ${isLive?`<button class="btn-stop" onclick="stopStream(${s.id})">⬛ Stop stream</button>`:''}
          <button class="btn-edit" onclick="editStream(${s.id})">✏️ Edit</button>
          <button class="btn-delete" onclick="deleteStream(${s.id})">🗑 Delete</button>
        </div>
      </div>`;
    }).join('')}
  </div>
  `}
</div>

<script>
let editingStreamId=null,selectedVideoFile=null,audioFiles=[],audioDurations=[],videoMuted=false,audioMuted=false,volDebounce=null;
const liveMap=${JSON.stringify(liveMap)};
const allStreams=${JSON.stringify(streams.reduce((a,s)=>{a[s.id]=s;return a;},{}))};

function setPreviewEmpty(){document.getElementById('preview-container').innerHTML=\`<div class="preview-empty" onclick="document.getElementById('hidden-video-input').click()"><span class="preview-empty-icon">🎬</span><span class="preview-empty-text">Click to upload video, image, or GIF</span><span style="font-size:11px;color:#444;margin-top:4px;">MP4, MOV, GIF, JPG, PNG — up to 20GB</span></div>\`;}
function setPreviewImage(src,name){document.getElementById('preview-container').innerHTML=\`<div class="preview-wrap" onclick="document.getElementById('hidden-video-input').click()"><img src="\${src}" alt="preview"/><div class="preview-overlay"><div class="preview-overlay-icon">🔄</div><div class="preview-overlay-text">Click to change</div><div style="font-size:11px;color:#ccc;margin-top:4px;">\${name||''}</div></div></div>\`;}

function openModal(){
  editingStreamId=null;selectedVideoFile=null;audioFiles=[];audioDurations=[];videoMuted=false;audioMuted=false;
  document.getElementById('modal-title').textContent='Add stream';
  document.getElementById('stream-name').value='';document.getElementById('stream-key').value='';document.getElementById('stream-res').value='1080p';
  document.getElementById('video-vol').value=100;document.getElementById('video-vol-val').textContent='100%';
  document.getElementById('audio-vol').value=100;document.getElementById('audio-vol-val').textContent='100%';
  document.getElementById('video-mute-btn').className='mute-btn';document.getElementById('audio-mute-btn').className='mute-btn';
  document.getElementById('modal-error').style.display='none';document.getElementById('upload-progress').style.display='none';
  document.getElementById('save-btn').disabled=false;document.getElementById('save-btn').textContent='Save stream';
  document.getElementById('save-note').textContent='';
  setPreviewEmpty();renderAudioTracks();
  document.getElementById('stream-modal').classList.add('open');
}

function editStream(id){
  editingStreamId=id;const s=allStreams[id];audioFiles=[];audioDurations=[];selectedVideoFile=null;
  videoMuted=s.video_muted||false;audioMuted=s.audio_muted||false;
  const isLive=liveMap[id]||false;
  document.getElementById('modal-title').innerHTML='Edit stream'+(isLive?' <span class="live-tag">● LIVE</span>':'');
  document.getElementById('stream-name').value=s.name||'';document.getElementById('stream-key').value=s.stream_key||'';document.getElementById('stream-res').value=s.resolution||'1080p';
  document.getElementById('video-vol').value=s.video_volume||100;document.getElementById('video-vol-val').textContent=(s.video_volume||100)+'%';
  document.getElementById('audio-vol').value=s.audio_volume||100;document.getElementById('audio-vol-val').textContent=(s.audio_volume||100)+'%';
  document.getElementById('video-mute-btn').className='mute-btn'+(videoMuted?' muted':'');document.getElementById('audio-mute-btn').className='mute-btn'+(audioMuted?' muted':'');
  document.getElementById('modal-error').style.display='none';document.getElementById('upload-progress').style.display='none';
  document.getElementById('save-btn').disabled=false;document.getElementById('save-btn').textContent='Save changes';
  document.getElementById('save-note').textContent=isLive?'Stream will restart briefly when you save':'';
  if(s.thumb_path){setPreviewImage(s.thumb_path,s.file_name||'');}else{setPreviewEmpty();}
  renderAudioTracks();document.getElementById('stream-modal').classList.add('open');
}

function closeModal(){document.getElementById('stream-modal').classList.remove('open');}

function handleVideoSelect(e){
  const file=e.target.files[0];if(!file)return;selectedVideoFile=file;
  const ext=file.name.split('.').pop().toLowerCase();
  if(['jpg','jpeg','png','webp'].includes(ext)){setPreviewImage(URL.createObjectURL(file),file.name);}
  else{const v=document.createElement('video');v.src=URL.createObjectURL(file);v.muted=true;v.currentTime=0.5;v.onloadeddata=()=>{const c=document.createElement('canvas');c.width=320;c.height=180;c.getContext('2d').drawImage(v,0,0,320,180);setPreviewImage(c.toDataURL('image/jpeg'),file.name);};v.onerror=()=>setPreviewImage('',file.name);}
  e.target.value='';
}

function getAudioDuration(file){return new Promise(r=>{const a=new Audio();a.onloadedmetadata=()=>r(a.duration||0);a.onerror=()=>r(0);a.src=URL.createObjectURL(file);});}
async function handleAudioAdd(e){for(const f of Array.from(e.target.files)){const d=await getAudioDuration(f);audioFiles.push(f);audioDurations.push(d);}renderAudioTracks();e.target.value='';}
function removeAudioTrack(i){audioFiles.splice(i,1);audioDurations.splice(i,1);renderAudioTracks();}
function moveTrack(i,dir){const ni=i+dir;if(ni<0||ni>=audioFiles.length)return;[audioFiles[i],audioFiles[ni]]=[audioFiles[ni],audioFiles[i]];[audioDurations[i],audioDurations[ni]]=[audioDurations[ni],audioDurations[i]];renderAudioTracks();}
function renderAudioTracks(){
  const list=document.getElementById('audio-tracks-list');
  if(!audioFiles.length){list.innerHTML='';return;}
  list.innerHTML=audioFiles.map((f,i)=>{const m=Math.floor(audioDurations[i]/60),s=Math.floor(audioDurations[i]%60);return \`<div class="audio-track-item"><div class="track-order-btns"><button class="track-order-btn" onclick="moveTrack(\${i},-1)" \${i===0?'disabled':''}>▲</button><button class="track-order-btn" onclick="moveTrack(\${i},1)" \${i===audioFiles.length-1?'disabled':''}>▼</button></div><span class="track-name-text">\${f.name}</span><span class="track-dur-text">\${m}:\${String(s).padStart(2,'0')}</span><button class="track-remove-btn" onclick="removeAudioTrack(\${i})">✕</button></div>\`;}).join('');
}

function onVolChange(type){
  const val=parseInt(document.getElementById(type+'-vol').value);
  document.getElementById(type+'-vol-val').textContent=val+'%';
  if(type==='video'&&videoMuted&&val>0){videoMuted=false;document.getElementById('video-mute-btn').className='mute-btn';}
  if(type==='audio'&&audioMuted&&val>0){audioMuted=false;document.getElementById('audio-mute-btn').className='mute-btn';}
  if(editingStreamId&&liveMap[editingStreamId]){clearTimeout(volDebounce);volDebounce=setTimeout(async()=>{await saveMetaNow();await fetch('/api/streams/'+editingStreamId+'/restart',{method:'POST'});},500);}
}

function toggleMute(type){
  if(type==='video'){videoMuted=!videoMuted;document.getElementById('video-mute-btn').className='mute-btn'+(videoMuted?' muted':'');document.getElementById('video-vol').value=videoMuted?0:100;document.getElementById('video-vol-val').textContent=videoMuted?'0%':'100%';}
  else{audioMuted=!audioMuted;document.getElementById('audio-mute-btn').className='mute-btn'+(audioMuted?' muted':'');document.getElementById('audio-vol').value=audioMuted?0:100;document.getElementById('audio-vol-val').textContent=audioMuted?'0%':'100%';}
  if(editingStreamId&&liveMap[editingStreamId]){clearTimeout(volDebounce);volDebounce=setTimeout(async()=>{await saveMetaNow();await fetch('/api/streams/'+editingStreamId+'/restart',{method:'POST'});},500);}
}

async function saveMetaNow(){
  if(!editingStreamId)return;
  await fetch('/api/streams/'+editingStreamId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('stream-name').value.trim(),streamKey:document.getElementById('stream-key').value.trim(),resolution:document.getElementById('stream-res').value,videoVolume:parseInt(document.getElementById('video-vol').value),videoMuted,audioVolume:parseInt(document.getElementById('audio-vol').value),audioMuted})});
}

async function saveStream(){
  const name=document.getElementById('stream-name').value.trim();
  const key=document.getElementById('stream-key').value.trim();
  const res=document.getElementById('stream-res').value;
  const videoVol=parseInt(document.getElementById('video-vol').value);
  const audioVol=parseInt(document.getElementById('audio-vol').value);
  const errEl=document.getElementById('modal-error');const saveBtn=document.getElementById('save-btn');
  if(!name){errEl.textContent='Please enter a stream name';errEl.style.display='block';return;}
  saveBtn.disabled=true;saveBtn.textContent='Saving...';errEl.style.display='none';
  const payload={name,streamKey:key,resolution:res,videoVolume:videoVol,videoMuted,audioVolume:audioVol,audioMuted};
  if(editingStreamId){
    const r=await fetch('/api/streams/'+editingStreamId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await r.json();
    if(data.error){errEl.textContent=data.error;errEl.style.display='block';saveBtn.disabled=false;saveBtn.textContent='Save changes';return;}
    if(selectedVideoFile){saveBtn.textContent='Uploading video...';const fd=new FormData();fd.append('file',selectedVideoFile);await fetch('/api/streams/'+editingStreamId+'/upload-video',{method:'POST',body:fd});}
    for(let i=0;i<audioFiles.length;i++){saveBtn.textContent='Uploading audio '+(i+1)+'/'+audioFiles.length+'...';const fd=new FormData();fd.append('file',audioFiles[i]);await fetch('/api/streams/'+editingStreamId+'/upload-audio',{method:'POST',body:fd});}
    if(liveMap[editingStreamId]){saveBtn.textContent='Restarting stream...';await fetch('/api/streams/'+editingStreamId+'/restart',{method:'POST'});}
    closeModal();location.reload();return;
  }
  const r=await fetch('/api/streams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json();
  if(data.error){errEl.textContent=data.error;errEl.style.display='block';saveBtn.disabled=false;saveBtn.textContent='Save stream';return;}
  const sid=data.id;document.getElementById('upload-progress').style.display='block';
  if(selectedVideoFile){saveBtn.textContent='Uploading video...';await uploadXHR('/api/streams/'+sid+'/upload-video',selectedVideoFile);}
  for(let i=0;i<audioFiles.length;i++){saveBtn.textContent='Uploading audio '+(i+1)+'/'+audioFiles.length+'...';await uploadXHR('/api/streams/'+sid+'/upload-audio',audioFiles[i]);}
  closeModal();location.reload();
}

function uploadXHR(url,file){return new Promise(resolve=>{const fd=new FormData();fd.append('file',file);const xhr=new XMLHttpRequest();xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);document.getElementById('progress-fill').style.width=p+'%';document.getElementById('progress-label').textContent='Uploading '+p+'%...';}};xhr.onload=xhr.onerror=()=>resolve();xhr.open('POST',url);xhr.send(fd);});}

async function startStream(id){const btn=document.querySelector('#stream-'+id+' .btn-start');if(btn){btn.textContent='⏳ Starting...';btn.disabled=true;}const res=await fetch('/api/streams/'+id+'/start',{method:'POST'});const data=await res.json();if(data.error){alert(data.error);location.reload();return;}location.reload();}
async function stopStream(id){await fetch('/api/streams/'+id+'/stop',{method:'POST'});location.reload();}
async function deleteStream(id){if(!confirm('Delete this stream? This cannot be undone.'))return;await fetch('/api/streams/'+id,{method:'DELETE'});location.reload();}
</script>
</body>
</html>`);
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ==================== API ====================

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, plan } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email,password,plan,stream_slots) VALUES ($1,$2,$3,$4) RETURNING id',
      [email.toLowerCase().trim(), hashed, 'free', 0]
    );
    req.session.userId = result.rows[0].id;
    res.json({ success: true });
  } catch (e) { console.error('Register error:', e); res.status(500).json({ error: 'Registration failed. Please try again.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ success: true });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: 'Login failed. Please try again.' }); }
});

app.post('/api/create-subscription', requireAuthApi, async (req, res) => {
  try {
    const { plan } = req.body;
    const planData = PLANS[plan];
    if (!planData) return res.status(400).json({ error: 'Invalid plan' });
    if (!planData.priceId) return res.status(400).json({ error: 'Plan not configured yet. Please contact support.' });

    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];

    // Create or get Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, user.id]);
    }

    // Create subscription with payment intent
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: planData.priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
    await pool.query('UPDATE users SET stripe_subscription_id=$1 WHERE id=$2', [subscription.id, user.id]);

    res.json({ clientSecret, subscriptionId: subscription.id });
  } catch (e) { console.error('Subscription error:', e); res.status(500).json({ error: e.message }); }
});

// Stripe webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (e) {
    // If no webhook secret, just parse the body
    try { event = JSON.parse(req.body); } catch(e2) { return res.status(400).send('Webhook error'); }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = Object.entries(PLANS).find(([,p]) => p.priceId === priceId)?.[0] || 'pro';
      const planSlots = { starter:1, pro:1, creator:3, studio:6 };
      await pool.query(
        'UPDATE users SET plan=$1, stream_slots=$2, subscription_status=$3 WHERE stripe_subscription_id=$4',
        [plan, planSlots[plan]||1, 'active', subscriptionId]
      );
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await pool.query(
      'UPDATE users SET plan=$1, stream_slots=$2, subscription_status=$3 WHERE stripe_subscription_id=$4',
      ['free', 0, 'cancelled', subscription.id]
    );
  }

  res.json({ received: true });
});

app.post('/api/streams', requireAuthApi, async (req, res) => {
  try {
    const { name, streamKey, resolution, videoVolume, videoMuted, audioVolume, audioMuted } = req.body;
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0];
    const count = parseInt((await pool.query('SELECT COUNT(*) FROM streams WHERE user_id=$1', [req.session.userId])).rows[0].count);
    if (count >= user.stream_slots) return res.status(400).json({ error: 'Stream slot limit reached. Upgrade your plan.' });
    const result = await pool.query(
      'INSERT INTO streams (user_id,name,stream_key,resolution,video_volume,video_muted,audio_volume,audio_muted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.session.userId, name||'My Stream', streamKey||null, resolution||'1080p', videoVolume||100, videoMuted||false, audioVolume||100, audioMuted||false]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/streams/:id', requireAuthApi, async (req, res) => {
  try {
    const { name, streamKey, resolution, videoVolume, videoMuted, audioVolume, audioMuted } = req.body;
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    await pool.query('UPDATE streams SET name=$1,stream_key=$2,resolution=$3,video_volume=$4,video_muted=$5,audio_volume=$6,audio_muted=$7 WHERE id=$8',
      [name, streamKey||null, resolution, videoVolume||100, videoMuted||false, audioVolume||100, audioMuted||false, req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) { const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0]; active.streamData = { ...active.streamData, ...updated }; }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/upload-video', requireAuthApi, upload.single('file'), async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (stream.file_path && fs.existsSync(stream.file_path)) { try { fs.unlinkSync(stream.file_path); } catch(e) {} }
    if (stream.thumb_path) { const tp = path.join(THUMB_DIR, path.basename(stream.thumb_path)); if (fs.existsSync(tp)) { try { fs.unlinkSync(tp); } catch(e) {} } }
    const thumbPath = await generateThumb(req.file.path, req.params.id);
    await pool.query('UPDATE streams SET file_path=$1,file_name=$2,thumb_path=$3 WHERE id=$4', [req.file.path, req.file.originalname, thumbPath, req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) { const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0]; active.streamData = { ...active.streamData, ...updated }; }
    res.json({ success: true, thumb_path: thumbPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/upload-audio', requireAuthApi, upload.single('file'), async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks : [];
    tracks.push({ path: req.file.path, name: req.file.originalname });
    await pool.query('UPDATE streams SET audio_tracks=$1 WHERE id=$2', [JSON.stringify(tracks), req.params.id]);
    const active = activeStreams.get(parseInt(req.params.id));
    if (active) { const updated = (await pool.query('SELECT * FROM streams WHERE id=$1', [req.params.id])).rows[0]; active.streamData = { ...active.streamData, ...updated }; }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/start', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.file_path || !fs.existsSync(stream.file_path)) return res.status(400).json({ error: 'No video/image file uploaded' });
    if (!stream.stream_key) return res.status(400).json({ error: 'No stream key set' });
    startFFmpeg(stream.id, stream);
    await pool.query('UPDATE streams SET status=$1 WHERE id=$2', ['live', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/stop', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const entry = activeStreams.get(stream.id);
    if (entry) { entry.restarting = true; try { entry.proc.kill('SIGKILL'); } catch(e) {} activeStreams.delete(stream.id); }
    await pool.query('UPDATE streams SET status=$1 WHERE id=$2', ['stopped', stream.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/streams/:id/restart', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!activeStreams.has(stream.id)) return res.json({ success: false });
    startFFmpeg(stream.id, stream);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/streams/:id', requireAuthApi, async (req, res) => {
  try {
    const stream = (await pool.query('SELECT * FROM streams WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId])).rows[0];
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    const entry = activeStreams.get(stream.id);
    if (entry) { entry.restarting = true; try { entry.proc.kill('SIGKILL'); } catch(e) {} activeStreams.delete(stream.id); }
    if (stream.file_path && fs.existsSync(stream.file_path)) { try { fs.unlinkSync(stream.file_path); } catch(e) {} }
    if (stream.thumb_path) { const tp = path.join(THUMB_DIR, path.basename(stream.thumb_path)); if (fs.existsSync(tp)) { try { fs.unlinkSync(tp); } catch(e) {} } }
    const tracks = Array.isArray(stream.audio_tracks) ? stream.audio_tracks : [];
    for (const t of tracks) { if (t.path && fs.existsSync(t.path)) { try { fs.unlinkSync(t.path); } catch(e) {} } }
    await pool.query('DELETE FROM streams WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamForCheap running on port ' + PORT));
