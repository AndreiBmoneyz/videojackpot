const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CREDIT_TIERS = [0, 10, 25, 45, 75, 125, 190];
const MAX_ADS_PER_BATCH = 6;
const BATCH_COOLDOWN_MINUTES = 30;

const DURATION_CREDITS = [
  { label: 'Up to 10 minutes', maxSeconds: 600, credits: 5 },
  { label: 'Up to 30 minutes', maxSeconds: 1800, credits: 10 },
  { label: 'Up to 1 hour', maxSeconds: 3600, credits: 20 },
  { label: 'Up to 3 hours', maxSeconds: 10800, credits: 40 },
  { label: 'Up to 6 hours', maxSeconds: 21600, credits: 75 },
  { label: 'Up to 9 hours', maxSeconds: 32400, credits: 125 },
  { label: 'Up to 12 hours', maxSeconds: 43200, credits: 170 },
];

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    avatar TEXT,
    credits INTEGER NOT NULL DEFAULT 25,
    last_daily_reset TIMESTAMP NOT NULL DEFAULT NOW(),
    batch1_ads_used INTEGER NOT NULL DEFAULT 0,
    batch2_ads_used INTEGER NOT NULL DEFAULT 0,
    current_batch INTEGER NOT NULL DEFAULT 1,
    batch_cooldown_until TIMESTAMP,
    current_streak INTEGER NOT NULL DEFAULT 0
  )
`).catch(console.error);

// Multer setup - store uploads in /tmp
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://loopmixvideo.com/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [profile.id]);
    if (existing.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (id, email, name, avatar) VALUES ($1, $2, $3, $4)',
        [profile.id, profile.emails[0].value, profile.displayName, profile.photos[0].value]
      );
    }
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [profile.id]);
    return done(null, user.rows[0]);
  } catch (e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, res.rows[0]);
  } catch (e) { done(e); }
});

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

async function checkDailyReset(userId) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = res.rows[0];
  const now = new Date();
  const last = new Date(user.last_daily_reset);
  const diffHours = (now - last) / (1000 * 60 * 60);
  if (diffHours >= 24) {
    await pool.query(`
      UPDATE users SET
        credits = credits + 25,
        last_daily_reset = NOW(),
        batch1_ads_used = 0,
        batch2_ads_used = 0,
        current_batch = 1,
        batch_cooldown_until = NULL,
        current_streak = 0
      WHERE id = $1
    `, [userId]);
    const updated = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return updated.rows[0];
  }
  return user;
}

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/')
);
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/login')); });

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>LoopmixVideo - Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2.5rem; max-width: 400px; width: 100%; text-align: center; }
  .logo { font-size: 40px; margin-bottom: 1rem; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  p { color: #777; font-size: 14px; margin-bottom: 2rem; line-height: 1.6; }
  .btn-google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 14px; background: #fff; color: #000; font-size: 15px; font-weight: 600; border-radius: 12px; border: none; cursor: pointer; text-decoration: none; transition: opacity 0.15s; }
  .btn-google:hover { opacity: 0.9; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🎬</div>
  <h1>LoopmixVideo</h1>
  <p>Create long music mix videos for free.<br>Sign in to get started and earn credits.</p>
  <a href="/auth/google" class="btn-google">
    <img src="https://www.google.com/favicon.ico" width="20" height="20" alt="G" />
    Sign in with Google
  </a>
</div>
</body>
</html>`);
});

app.get('/state', requireAuth, async (req, res) => {
  try {
    const user = await checkDailyReset(req.user.id);
    const now = new Date();
    const batchAdsUsed = user.current_batch === 1 ? user.batch1_ads_used : user.batch2_ads_used;
    const adsRemainingInBatch = MAX_ADS_PER_BATCH - batchAdsUsed;
    const inCooldown = user.batch_cooldown_until && new Date(user.batch_cooldown_until) > now;
    const cooldownSecsLeft = inCooldown ? Math.ceil((new Date(user.batch_cooldown_until) - now) / 1000) : 0;
    const batchesUsed = user.batch1_ads_used >= 6 && user.batch2_ads_used >= 6;
    res.json({
      credits: user.credits,
      name: user.name,
      avatar: user.avatar,
      currentStreak: user.current_streak,
      currentTierCredits: CREDIT_TIERS[user.current_streak] || 0,
      nextTierCredits: CREDIT_TIERS[user.current_streak + 1] || null,
      adsRemainingInBatch,
      currentBatch: user.current_batch,
      inCooldown,
      cooldownSecsLeft,
      batchesUsed,
      canWatchAd: !inCooldown && !batchesUsed && adsRemainingInBatch > 0,
      durationOptions: DURATION_CREDITS
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/watch-ad', requireAuth, async (req, res) => {
  try {
    const user = await checkDailyReset(req.user.id);
    const now = new Date();
    const batchAdsUsed = user.current_batch === 1 ? user.batch1_ads_used : user.batch2_ads_used;
    const inCooldown = user.batch_cooldown_until && new Date(user.batch_cooldown_until) > now;
    const batchesUsed = user.batch1_ads_used >= 6 && user.batch2_ads_used >= 6;
    if (inCooldown) return res.status(400).json({ error: 'In cooldown' });
    if (batchesUsed) return res.status(400).json({ error: 'No more ads today' });
    if (batchAdsUsed >= MAX_ADS_PER_BATCH) return res.status(400).json({ error: 'Batch full' });
    const newStreak = user.current_streak + 1;
    const batchCol = user.current_batch === 1 ? 'batch1_ads_used' : 'batch2_ads_used';
    await pool.query(`UPDATE users SET current_streak = $1, ${batchCol} = ${batchCol} + 1 WHERE id = $2`, [newStreak, req.user.id]);
    const isMaxStreak = newStreak === MAX_ADS_PER_BATCH;
    res.json({ newStreak, offeredCredits: CREDIT_TIERS[newStreak], isMaxStreak, canContinue: !isMaxStreak && (batchAdsUsed + 1) < MAX_ADS_PER_BATCH });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/collect', requireAuth, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userRes.rows[0];
    const creditsToAdd = CREDIT_TIERS[user.current_streak];
    if (!creditsToAdd) return res.status(400).json({ error: 'Nothing to collect' });
    const batchAdsUsed = user.current_batch === 1 ? user.batch1_ads_used : user.batch2_ads_used;
    const batchDone = batchAdsUsed >= MAX_ADS_PER_BATCH;
    const isJackpot = user.current_streak === MAX_ADS_PER_BATCH;
    let cooldownUntil = null;
    let newBatch = user.current_batch;
    if (batchDone || isJackpot) {
      cooldownUntil = new Date(Date.now() + BATCH_COOLDOWN_MINUTES * 60 * 1000);
      if (user.current_batch === 1) newBatch = 2;
    }
    await pool.query(`UPDATE users SET credits = credits + $1, current_streak = 0, batch_cooldown_until = $2, current_batch = $3 WHERE id = $4`, [creditsToAdd, cooldownUntil, newBatch, req.user.id]);
    res.json({ creditsAdded: creditsToAdd, isJackpot, cooldownUntil });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Video export endpoint
app.post('/export', requireAuth, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 20 }]), async (req, res) => {
  const tmpFiles = [];
  try {
    const { durationIndex, fps = 1, repeatCount = 1 } = req.body;
    const durationOption = DURATION_CREDITS[parseInt(durationIndex)];
    if (!durationOption) return res.status(400).json({ error: 'Invalid duration' });

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userRes.rows[0];
    if (user.credits < durationOption.credits) {
      return res.status(400).json({ error: `Not enough credits. Need ${durationOption.credits}, have ${user.credits}` });
    }

    if (!req.files.image || !req.files.audio) {
      return res.status(400).json({ error: 'Image and audio required' });
    }

    const imageFile = req.files.image[0];
    const audioFiles = req.files.audio;
    tmpFiles.push(imageFile.path);
    audioFiles.forEach(f => tmpFiles.push(f.path));

    // Build concat list for audio with repeats
    const concatPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    tmpFiles.push(concatPath);
    let concatContent = '';
    for (let r = 0; r < parseInt(repeatCount); r++) {
      for (const af of audioFiles) {
        concatContent += `file '${af.path}'\n`;
      }
    }
    fs.writeFileSync(concatPath, concatContent);

    // Merge audio
    const mergedAudio = path.join(os.tmpdir(), `merged_${Date.now()}.aac`);
    tmpFiles.push(mergedAudio);

    await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', mergedAudio]);

    // Build video
    const outputFile = path.join(os.tmpdir(), `output_${Date.now()}.mp4`);
    tmpFiles.push(outputFile);

    const fpsVal = Math.min(Math.max(parseInt(fps) || 1, 1), 30);
    const durationSecs = durationOption.maxSeconds;

    await runFFmpeg([
      '-loop', '1',
      '-framerate', String(fpsVal),
      '-i', imageFile.path,
      '-i', mergedAudio,
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-t', String(durationSecs),
      '-movflags', '+faststart',
      '-y', outputFile
    ]);

    // Deduct credits
    await pool.query('UPDATE users SET credits = credits - $1 WHERE id = $2', [durationOption.credits, req.user.id]);

    // Send file
    res.download(outputFile, `loopmixvideo_${durationOption.maxSeconds / 3600}h.mp4`, (err) => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    });

  } catch (e) {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(err) {} });
    res.status(500).json({ error: e.message });
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg error: ' + stderr.slice(-500)));
    });
  });
}

// Main page
app.get('/', requireAuth, async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>LoopmixVideo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; padding-top: 60px; }
  .credits-bar { position: fixed; top: 0; left: 0; right: 0; background: #1a1a1a; border-bottom: 1px solid #333; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
  .credits-right { display: flex; align-items: center; gap: 12px; }
  .credits-count { font-size: 18px; font-weight: 700; color: #c8f135; }
  .credits-label { font-size: 13px; color: #777; }
  .user-info { display: flex; align-items: center; gap: 8px; }
  .user-avatar { width: 28px; height: 28px; border-radius: 50%; }
  .user-name { font-size: 13px; color: #aaa; }
  .logout { font-size: 12px; color: #555; text-decoration: none; margin-left: 8px; }
  .logout:hover { color: #f87171; }
  .main { max-width: 700px; margin: 0 auto; padding: 2rem 1rem; }
  .tabs { display: flex; gap: 4px; margin-bottom: 2rem; border-bottom: 1px solid #2a2a2a; }
  .tab { padding: 10px 20px; font-size: 14px; font-weight: 500; background: transparent; border: none; color: #777; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all 0.15s; }
  .tab.active { color: #c8f135; border-bottom-color: #c8f135; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 1.5rem; margin-bottom: 12px; }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 1rem; color: #fff; }
  .section-label { font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: #555; margin-bottom: 8px; }
  .upload-zone { border: 1.5px dashed #333; border-radius: 10px; padding: 1.5rem; text-align: center; cursor: pointer; position: relative; transition: border-color 0.15s; }
  .upload-zone:hover { border-color: #c8f135; }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-zone.done { border-color: #4ade80; border-style: solid; }
  .upload-zone p { font-size: 13px; color: #777; }
  .upload-zone .icon { font-size: 24px; margin-bottom: 6px; }
  #img-preview { width: 100%; max-height: 180px; object-fit: cover; border-radius: 8px; margin-top: 10px; display: none; }
  .track-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .track-item { display: flex; align-items: center; gap: 10px; background: #222; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .track-name { flex: 1; color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track-remove { color: #555; cursor: pointer; font-size: 16px; background: none; border: none; }
  .track-remove:hover { color: #f87171; }
  .add-track { width: 100%; padding: 8px; background: transparent; border: 1.5px dashed #333; border-radius: 8px; color: #777; font-size: 13px; cursor: pointer; position: relative; margin-top: 6px; transition: border-color 0.15s; }
  .add-track:hover { border-color: #c8f135; color: #c8f135; }
  .add-track input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .setting label { font-size: 12px; color: #777; display: block; margin-bottom: 6px; }
  .setting .bigval { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 6px; }
  .setting .sub { font-size: 11px; color: #555; margin-top: 4px; }
  input[type=range] { width: 100%; -webkit-appearance: none; height: 3px; border-radius: 99px; background: #2a2a2a; outline: none; cursor: pointer; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #c8f135; cursor: pointer; }
  .duration-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 12px; }
  .dur-btn { padding: 10px; font-size: 13px; font-weight: 500; border-radius: 8px; border: 1px solid #2a2a2a; background: transparent; color: #777; cursor: pointer; transition: all 0.12s; text-align: center; }
  .dur-btn:hover { border-color: #c8f135; color: #c8f135; }
  .dur-btn.active { background: rgba(200,241,53,0.1); border-color: #c8f135; color: #c8f135; }
  .dur-btn .cost { font-size: 11px; color: #555; margin-top: 2px; }
  .dur-btn.active .cost { color: #888; }
  .export-btn { width: 100%; padding: 14px; font-size: 15px; font-weight: 700; border-radius: 12px; border: none; background: #c8f135; color: #0f0f0f; cursor: pointer; transition: opacity 0.15s; margin-top: 8px; }
  .export-btn:hover:not(:disabled) { opacity: 0.9; }
  .export-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .export-status { background: #0f0f0f; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1rem; margin-top: 10px; font-size: 13px; color: #777; display: none; }
  .export-status.active { display: block; }
  .progress-track { height: 3px; background: #2a2a2a; border-radius: 99px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: #c8f135; border-radius: 99px; width: 0%; transition: width 0.5s; }
  .streak-display { display: flex; justify-content: center; gap: 8px; margin-bottom: 1.5rem; }
  .streak-dot { width: 30px; height: 30px; border-radius: 50%; background: #2a2a2a; border: 2px solid #333; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #555; transition: all 0.3s; }
  .streak-dot.active { background: #c8f135; border-color: #c8f135; color: #0f0f0f; }
  .streak-dot.done { background: #4ade80; border-color: #4ade80; color: #0f0f0f; }
  .btn { width: 100%; padding: 13px; font-size: 14px; font-weight: 600; border-radius: 12px; border: none; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
  .btn-watch { background: #c8f135; color: #0f0f0f; }
  .btn-collect { background: #4ade80; color: #0f0f0f; }
  .offer-box { background: #0f0f0f; border: 1px solid #333; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; text-align: center; }
  .offer-box .amount { font-size: 30px; font-weight: 800; color: #c8f135; }
  .offer-box .label { font-size: 13px; color: #777; margin-top: 4px; }
  .cooldown-box { background: #1a0f2e; border: 1px solid #4c1d95; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; color: #a78bfa; font-size: 14px; text-align: center; }
  .cooldown-timer { font-size: 28px; font-weight: 800; color: #a78bfa; margin: 8px 0; }
  .daily-box { background: #0f1a0f; border: 1px solid #166534; border-radius: 10px; padding: 1rem; color: #4ade80; font-size: 13px; text-align: center; }
  #confetti-container { position: fixed; inset: 0; pointer-events: none; z-index: 999; }
  .confetti-piece { position: absolute; width: 10px; height: 10px; border-radius: 2px; animation: confetti-fall 3s ease-in forwards; }
  @keyframes confetti-fall { 0% { transform: translateY(-20px) rotate(0deg); opacity: 1; } 100% { transform: translateY(100vh) rotate(720deg); opacity: 0; } }
  .repeat-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #222; }
  .repeat-row label { font-size: 13px; color: #777; flex-shrink: 0; }
  .repeat-row input[type=number] { width: 70px; padding: 6px 10px; background: #222; border: 1px solid #333; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 500; text-align: center; outline: none; }
  .repeat-info { font-size: 12px; color: #555; flex: 1; }
</style>
</head>
<body>
<div class="credits-bar">
  <div class="user-info">
    <img class="user-avatar" id="user-avatar" src="" alt="" />
    <span class="user-name" id="user-name"></span>
    <a href="/logout" class="logout">Sign out</a>
  </div>
  <div class="credits-right">
    <span class="credits-label">Credits</span>
    <span class="credits-count" id="credits-display">...</span>
  </div>
</div>

<div id="confetti-container"></div>

<div class="main">
  <div class="tabs">
    <button class="tab active" onclick="switchTab('create', this)">🎬 Create Video</button>
    <button class="tab" onclick="switchTab('credits', this)">🎰 Earn Credits</button>
  </div>

  <!-- CREATE TAB -->
  <div id="tab-create" class="tab-content active">
    <div class="card">
      <div class="section-label">Background image</div>
      <div class="upload-zone" id="img-zone">
        <input type="file" id="img-input" accept="image/*" onchange="handleImage(event)" />
        <div class="icon">🖼️</div>
        <p id="img-label">Click or drag an image here</p>
      </div>
      <img id="img-preview" src="" alt="Preview" />
    </div>

    <div class="card">
      <div class="section-label">Audio tracks</div>
      <div class="track-list" id="track-list">
        <div style="font-size:13px;color:#555;text-align:center;padding:8px" id="no-tracks">No tracks added yet</div>
      </div>
      <button class="add-track">
        <input type="file" id="audio-input" accept="audio/*" multiple onchange="handleAudio(event)" />
        + Add audio track
      </button>
      <div class="repeat-row">
        <label>Repeat</label>
        <input type="number" id="repeat-count" value="1" min="1" max="99" />
        <span class="repeat-info" id="repeat-info">times</span>
      </div>
    </div>

    <div class="card">
      <div class="section-label">FPS</div>
      <div class="settings-grid">
        <div class="setting">
          <label>Frames per second</label>
          <div class="bigval" id="fps-val">1 FPS</div>
          <input type="range" id="fps-slider" min="1" max="30" value="1" oninput="document.getElementById('fps-val').textContent=this.value+' FPS'" />
          <div class="sub">1 FPS recommended for music mixes</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="section-label">Video duration</div>
      <div class="duration-grid" id="duration-grid"></div>
    </div>

    <button class="export-btn" id="export-btn" onclick="startExport()">Export Video</button>
    <div class="export-status" id="export-status">
      <div id="export-msg">Preparing export...</div>
      <div class="progress-track"><div class="progress-fill" id="export-progress"></div></div>
    </div>
  </div>

  <!-- CREDITS TAB -->
  <div id="tab-credits" class="tab-content">
    <div class="card">
      <h2>🎰 Video Jackpot</h2>
      <div class="streak-display" id="streak-dots"></div>
      <div id="ad-content">Loading...</div>
    </div>
  </div>
</div>

<script>
let state = null;
let audioFiles = [];
let selectedDuration = 0;
const TIERS = [0, 10, 25, 45, 75, 125, 190];
const COLORS = ['#f87171','#fb923c','#facc15','#a3e635','#34d399','#22d3ee','#818cf8'];

function switchTab(tab, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
}

async function fetchState() {
  const res = await fetch('/state');
  if (res.redirected || res.status === 401) { window.location.href = '/login'; return; }
  state = await res.json();
  document.getElementById('credits-display').textContent = state.credits;
  if (state.avatar) document.getElementById('user-avatar').src = state.avatar;
  if (state.name) document.getElementById('user-name').textContent = state.name;
  renderDurationGrid();
  renderAdSection();
  renderDots();
}

function renderDurationGrid() {
  if (!state || !state.durationOptions) return;
  const grid = document.getElementById('duration-grid');
  grid.innerHTML = '';
  state.durationOptions.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'dur-btn' + (i === selectedDuration ? ' active' : '');
    btn.innerHTML = opt.label + '<div class="cost">' + opt.credits + ' credits</div>';
    btn.onclick = () => {
      selectedDuration = i;
      document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    grid.appendChild(btn);
  });
}

function handleImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('img-label').textContent = '✓ ' + file.name;
  document.getElementById('img-zone').classList.add('done');
  const preview = document.getElementById('img-preview');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
}

function handleAudio(e) {
  const files = Array.from(e.target.files);
  files.forEach(f => audioFiles.push(f));
  renderTrackList();
  e.target.value = '';
}

function renderTrackList() {
  const list = document.getElementById('track-list');
  if (audioFiles.length === 0) {
    list.innerHTML = '<div style="font-size:13px;color:#555;text-align:center;padding:8px">No tracks added yet</div>';
    return;
  }
  list.innerHTML = '';
  audioFiles.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'track-item';
    div.innerHTML = '<span>🎵</span><span class="track-name">' + f.name + '</span><button class="track-remove" onclick="removeTrack(' + i + ')">✕</button>';
    list.appendChild(div);
  });
}

function removeTrack(i) {
  audioFiles.splice(i, 1);
  renderTrackList();
}

async function startExport() {
  const imgInput = document.getElementById('img-input');
  if (!imgInput.files[0]) { alert('Please select a background image'); return; }
  if (audioFiles.length === 0) { alert('Please add at least one audio track'); return; }
  if (!state || state.credits < state.durationOptions[selectedDuration].credits) {
    alert('Not enough credits! Go to the Earn Credits tab to watch ads.'); return;
  }

  const btn = document.getElementById('export-btn');
  const status = document.getElementById('export-status');
  const msg = document.getElementById('export-msg');
  const progress = document.getElementById('export-progress');

  btn.disabled = true;
  status.classList.add('active');
  msg.textContent = 'Uploading files...';
  progress.style.width = '10%';

  const formData = new FormData();
  formData.append('image', imgInput.files[0]);
  audioFiles.forEach(f => formData.append('audio', f));
  formData.append('durationIndex', selectedDuration);
  formData.append('fps', document.getElementById('fps-slider').value);
  formData.append('repeatCount', document.getElementById('repeat-count').value);

  msg.textContent = 'Server is encoding your video...';
  progress.style.width = '40%';

  // Fake progress while waiting
  let prog = 40;
  const progInterval = setInterval(() => {
    if (prog < 90) { prog += 2; progress.style.width = prog + '%'; }
  }, 3000);

  try {
    const res = await fetch('/export', { method: 'POST', body: formData });
    clearInterval(progInterval);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Export failed');
    }
    progress.style.width = '100%';
    msg.textContent = 'Done! Downloading...';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'loopmixvideo.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    msg.textContent = '✓ Video downloaded successfully!';
    await fetchState();
  } catch (e) {
    clearInterval(progInterval);
    msg.textContent = 'Error: ' + e.message;
    progress.style.width = '0%';
  } finally {
    btn.disabled = false;
  }
}

function renderDots() {
  if (!state) return;
  const container = document.getElementById('streak-dots');
  container.innerHTML = '';
  for (let i = 1; i <= 6; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot' + (i < state.currentStreak ? ' done' : i === state.currentStreak ? ' active' : '');
    dot.textContent = i;
    container.appendChild(dot);
  }
}

function renderAdSection() {
  if (!state) return;
  const content = document.getElementById('ad-content');
  if (state.batchesUsed) {
    content.innerHTML = '<div class="daily-box"><div style="font-size:18px;margin-bottom:4px;">✅ All done for today!</div><div>Come back tomorrow for 25 free credits + 12 more ad slots.</div></div>';
    return;
  }
  if (state.inCooldown) {
    content.innerHTML = '<div class="cooldown-box"><div>⏳ Cooldown active</div><div class="cooldown-timer" id="countdown"></div><div>Next batch available soon</div></div>';
    startCountdown(state.cooldownSecsLeft);
    return;
  }
  if (state.currentStreak === 0) {
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+10</div><div class="label">credits for watching 1 ad</div></div>
      <button class="btn btn-watch" onclick="watchAd()">▶ Watch Ad (+10 credits)</button>
      <div style="font-size:12px;color:#555;margin-top:6px;">\${state.adsRemainingInBatch} slots remaining in this batch</div>
    \`;
  } else {
    const cur = TIERS[state.currentStreak];
    const next = TIERS[state.currentStreak + 1];
    const canContinue = state.currentStreak < 6 && state.adsRemainingInBatch > 0;
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+\${cur}</div><div class="label">credits ready to collect</div></div>
      <button class="btn btn-collect" onclick="collect()">✅ Collect \${cur} credits</button>
      \${canContinue ? \`<button class="btn btn-watch" onclick="watchAd()" style="background:#222;color:#fff;">🎰 Watch one more → +\${next} total</button>\` : ''}
    \`;
  }
}

async function watchAd() {
  const btn = document.querySelector('.btn-watch');
  if (btn) { btn.textContent = '⏳ Ad playing...'; btn.disabled = true; }
  await new Promise(r => setTimeout(r, 2000));
  const res = await fetch('/watch-ad', { method: 'POST' });
  const data = await res.json();
  if (data.error) { alert(data.error); await fetchState(); return; }
  if (data.isMaxStreak) launchConfetti();
  await fetchState();
}

async function collect() {
  const res = await fetch('/collect', { method: 'POST' });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  if (data.isJackpot) launchConfetti();
  await fetchState();
}

function startCountdown(secs) {
  let remaining = secs;
  const tick = () => {
    const el = document.getElementById('countdown');
    if (!el) return;
    const m = Math.floor(remaining / 60), s = remaining % 60;
    el.textContent = m + ':' + String(s).padStart(2, '0');
    if (remaining <= 0) { fetchState(); return; }
    remaining--;
    setTimeout(tick, 1000);
  };
  tick();
}

function launchConfetti() {
  const container = document.getElementById('confetti-container');
  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
    piece.style.animationDelay = Math.random() * 1.5 + 's';
    piece.style.width = (Math.random() * 8 + 6) + 'px';
    piece.style.height = (Math.random() * 8 + 6) + 'px';
    container.appendChild(piece);
    setTimeout(() => piece.remove(), 4000);
  }
}

fetchState();
setInterval(fetchState, 30000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
