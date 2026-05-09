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
const { createCanvas, loadImage } = require('canvas');

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
  { maxSeconds: 600, credits: 5 },
  { maxSeconds: 1800, credits: 10 },
  { maxSeconds: 3600, credits: 20 },
  { maxSeconds: 10800, credits: 40 },
  { maxSeconds: 21600, credits: 75 },
  { maxSeconds: 32400, credits: 125 },
  { maxSeconds: 43200, credits: 170 },
];

function getCreditsForDuration(seconds) {
  for (const d of DURATION_CREDITS) {
    if (seconds <= d.maxSeconds) return d.credits;
  }
  return DURATION_CREDITS[DURATION_CREDITS.length - 1].credits;
}

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
    current_streak INTEGER NOT NULL DEFAULT 0,
    watermark_removed_until TIMESTAMP
  )
`).catch(console.error);

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
      await pool.query('INSERT INTO users (id, email, name, avatar) VALUES ($1, $2, $3, $4)',
        [profile.id, profile.emails[0].value, profile.displayName, profile.photos[0].value]);
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
  if ((now - last) / (1000 * 60 * 60) >= 24) {
    await pool.query(`
      UPDATE users SET credits = credits + 25, last_daily_reset = NOW(),
        batch1_ads_used = 0, batch2_ads_used = 0, current_batch = 1,
        batch_cooldown_until = NULL, current_streak = 0
      WHERE id = $1`, [userId]);
    const updated = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return updated.rows[0];
  }
  return user;
}

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/'));
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
  .logo { font-size: 48px; margin-bottom: 1rem; }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.5px; }
  .sub { color: #555; font-size: 14px; margin-bottom: 2rem; line-height: 1.6; }
  .btn-google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 14px; background: #fff; color: #000; font-size: 15px; font-weight: 600; border-radius: 12px; border: none; cursor: pointer; text-decoration: none; transition: opacity 0.15s; }
  .btn-google:hover { opacity: 0.9; }
  .features { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 2rem; }
  .feature { background: #111; border: 1px solid #222; border-radius: 8px; padding: 10px; font-size: 12px; color: #777; text-align: left; }
  .feature strong { display: block; color: #c8f135; font-size: 13px; margin-bottom: 2px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🎬</div>
  <h1>LoopmixVideo</h1>
  <p class="sub">Create long music mix videos for YouTube.<br>Free. No watermark. No subscription.</p>
  <div class="features">
    <div class="feature"><strong>Up to 12 hours</strong>Long music mixes</div>
    <div class="feature"><strong>Free exports</strong>Watch ads for credits</div>
    <div class="feature"><strong>No watermark</strong>Watch 1 ad to remove</div>
    <div class="feature"><strong>MP4 output</strong>Ready for YouTube</div>
  </div>
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
    const watermarkActive = !user.watermark_removed_until || new Date(user.watermark_removed_until) <= now;
    const watermarkSecsLeft = !watermarkActive ? Math.ceil((new Date(user.watermark_removed_until) - now) / 1000) : 0;
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
      watermarkActive,
      watermarkSecsLeft
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
    res.json({ newStreak, offeredCredits: CREDIT_TIERS[newStreak], isMaxStreak: newStreak === MAX_ADS_PER_BATCH, canContinue: newStreak < MAX_ADS_PER_BATCH && (batchAdsUsed + 1) < MAX_ADS_PER_BATCH });
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
    await pool.query(`UPDATE users SET credits = credits + $1, current_streak = 0, batch_cooldown_until = $2, current_batch = $3 WHERE id = $4`,
      [creditsToAdd, cooldownUntil, newBatch, req.user.id]);
    res.json({ creditsAdded: creditsToAdd, isJackpot, cooldownUntil });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/watch-watermark-ad', requireAuth, async (req, res) => {
  try {
    // Simulate ad — in production replace with real ad SDK verification
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET watermark_removed_until = $1 WHERE id = $2', [until, req.user.id]);
    res.json({ success: true, until });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/export', requireAuth, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 20 }]), async (req, res) => {
  const tmpFiles = [];
  try {
    const { fps = 1, repeatCount = 1, durationSeconds } = req.body;
    const durSecs = Math.min(parseInt(durationSeconds) || 3600, 43200);
    const creditCost = getCreditsForDuration(durSecs);

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userRes.rows[0];
    if (user.credits < creditCost) return res.status(400).json({ error: `Not enough credits. Need ${creditCost}, have ${user.credits}` });
    if (!req.files.image || !req.files.audio) return res.status(400).json({ error: 'Image and audio required' });

    const imageFile = req.files.image[0];
    const audioFiles = req.files.audio;
    tmpFiles.push(imageFile.path);
    audioFiles.forEach(f => tmpFiles.push(f.path));

    // Check watermark
    const now = new Date();
    const watermarkActive = !user.watermark_removed_until || new Date(user.watermark_removed_until) <= now;

    let finalImagePath = imageFile.path;

    // Add watermark if active
    if (watermarkActive) {
      const watermarkedPath = path.join(os.tmpdir(), `wm_${Date.now()}.jpg`);
      tmpFiles.push(watermarkedPath);
      await addWatermark(imageFile.path, watermarkedPath);
      finalImagePath = watermarkedPath;
    }

    // Concat audio
    const concatPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    tmpFiles.push(concatPath);
    let concatContent = '';
    for (let r = 0; r < parseInt(repeatCount); r++) {
      for (const af of audioFiles) concatContent += `file '${af.path}'\n`;
    }
    fs.writeFileSync(concatPath, concatContent);

    const mergedAudio = path.join(os.tmpdir(), `merged_${Date.now()}.aac`);
    tmpFiles.push(mergedAudio);
    await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatPath, '-c:a', 'aac', '-b:a', '192k', mergedAudio]);

    const outputFile = path.join(os.tmpdir(), `output_${Date.now()}.mp4`);
    tmpFiles.push(outputFile);
    const fpsVal = Math.min(Math.max(parseInt(fps) || 1, 1), 30);

    await runFFmpeg([
      '-loop', '1', '-framerate', String(fpsVal), '-i', finalImagePath,
      '-i', mergedAudio,
      '-c:v', 'libx264', '-tune', 'stillimage',
      '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-t', String(durSecs),
      '-movflags', '+faststart', '-y', outputFile
    ]);

    await pool.query('UPDATE users SET credits = credits - $1 WHERE id = $2', [creditCost, req.user.id]);

    res.download(outputFile, `loopmixvideo.mp4`, (err) => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    });

  } catch (e) {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ error: e.message });
  }
});

async function addWatermark(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Use FFmpeg to add watermark bar
    const ffmpegArgs = [
      '-i', inputPath,
      '-vf', "drawbox=x=0:y=0:w=iw:h=ih/12:color=black@1.0:t=fill,drawtext=text='Uploaded to youtube with loopmixvideo.com':fontcolor=white:fontsize=h/18:x=(w-text_w)/2:y=(ih/12-text_h)/2",
      '-y', outputPath
    ];
    const proc = spawn('ffmpeg', ffmpegArgs);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('Watermark error: ' + stderr.slice(-300)));
    });
  });
}

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

  /* TOP BAR */
  .topbar { position: fixed; top: 0; left: 0; right: 0; background: #111; border-bottom: 1px solid #222; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
  .topbar-left { display: flex; align-items: center; gap: 10px; }
  .topbar-logo { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #fff; }
  .topbar-logo span { color: #c8f135; }
  .topbar-right { display: flex; align-items: center; gap: 12px; }
  .credits-pill { display: flex; align-items: center; gap: 6px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 99px; padding: 6px 14px; }
  .credits-pill .coin { font-size: 16px; }
  .credits-pill .amount { font-size: 15px; font-weight: 700; color: #c8f135; }
  .watch-ads-btn { background: #c8f135; color: #0f0f0f; border: none; border-radius: 99px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: opacity 0.15s; }
  .watch-ads-btn:hover { opacity: 0.85; }
  .user-avatar { width: 30px; height: 30px; border-radius: 50%; }
  .logout { font-size: 12px; color: #555; text-decoration: none; }
  .logout:hover { color: #f87171; }

  /* MAIN */
  .main { max-width: 680px; margin: 0 auto; padding: 2rem 1rem 4rem; }

  /* CARDS */
  .card { background: #1a1a1a; border: 1px solid #222; border-radius: 14px; padding: 1.25rem; margin-bottom: 10px; }
  .section-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #555; margin-bottom: 10px; }

  /* UPLOAD */
  .upload-zone { border: 1.5px dashed #2a2a2a; border-radius: 10px; padding: 1.5rem; text-align: center; cursor: pointer; position: relative; transition: border-color 0.15s, background 0.15s; }
  .upload-zone:hover { border-color: #c8f135; background: rgba(200,241,53,0.03); }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-zone.done { border-color: #c8f135; border-style: solid; }
  .upload-icon { font-size: 28px; margin-bottom: 6px; display: block; color: #c8f135; }
  .upload-zone p { font-size: 13px; color: #555; }
  .upload-zone.done p { color: #c8f135; font-weight: 500; }
  #img-preview { width: 100%; max-height: 200px; object-fit: cover; border-radius: 8px; margin-top: 10px; display: none; border: 1px solid #222; }

  /* WATERMARK BANNER */
  .wm-banner { border-radius: 8px; padding: 10px 14px; margin-top: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; }
  .wm-banner.active { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171; }
  .wm-banner.removed { background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); color: #4ade80; }
  .wm-btn { background: #f87171; color: #0f0f0f; border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: opacity 0.15s; }
  .wm-btn:hover { opacity: 0.85; }
  .wm-btn.watching { background: #555; color: #fff; cursor: not-allowed; }

  /* AUDIO */
  .track-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .track-item { display: flex; align-items: center; gap: 10px; background: #111; border: 1px solid #222; border-radius: 8px; padding: 8px 12px; }
  .track-icon { color: #c8f135; font-size: 15px; flex-shrink: 0; }
  .track-name { flex: 1; font-size: 13px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track-remove { color: #333; cursor: pointer; font-size: 16px; background: none; border: none; transition: color 0.1s; }
  .track-remove:hover { color: #f87171; }
  .add-track { width: 100%; padding: 9px; background: transparent; border: 1.5px dashed #2a2a2a; border-radius: 8px; color: #555; font-size: 13px; cursor: pointer; position: relative; transition: all 0.15s; }
  .add-track:hover { border-color: #c8f135; color: #c8f135; }
  .add-track input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }

  /* FPS */
  .fps-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .fps-left label { font-size: 12px; color: #555; display: block; margin-bottom: 4px; }
  .fps-left .bigval { font-size: 22px; font-weight: 700; color: #fff; }
  .fps-locked { font-size: 12px; color: #555; margin-top: 4px; }
  input[type=range] { width: 100%; -webkit-appearance: none; height: 3px; border-radius: 99px; background: #2a2a2a; outline: none; cursor: pointer; margin-top: 8px; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #c8f135; cursor: pointer; }

  /* LOOP + DURATION */
  .loop-duration-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .input-group label { font-size: 12px; color: #555; display: block; margin-bottom: 6px; }
  .input-group input[type=number] { width: 100%; padding: 10px 12px; background: #111; border: 1px solid #2a2a2a; border-radius: 8px; color: #fff; font-size: 16px; font-weight: 600; outline: none; transition: border-color 0.15s; }
  .input-group input[type=number]:focus { border-color: #c8f135; }
  .credit-cost-box { margin-top: 12px; padding: 12px 14px; background: #111; border: 1px solid #2a2a2a; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; }
  .credit-cost-box .cost-label { font-size: 13px; color: #555; }
  .credit-cost-box .cost-amount { font-size: 18px; font-weight: 700; color: #c8f135; }
  .credit-cost-box.insufficient .cost-amount { color: #f87171; }
  .not-enough-btn { background: #f87171; color: #0f0f0f; border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; transition: opacity 0.15s; }
  .not-enough-btn:hover { opacity: 0.85; }

  /* YOUTUBE SETTINGS */
  .yt-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; background: transparent; border: none; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; padding: 0; }
  .yt-toggle .arrow { color: #555; transition: transform 0.2s; font-size: 12px; }
  .yt-toggle.open .arrow { transform: rotate(180deg); }
  .yt-body { display: none; margin-top: 14px; padding-top: 14px; border-top: 1px solid #222; }
  .yt-body.open { display: block; }
  .yt-field { margin-bottom: 12px; }
  .yt-field label { font-size: 12px; color: #555; display: block; margin-bottom: 6px; }
  .yt-field input, .yt-field textarea, .yt-field select { width: 100%; padding: 9px 12px; background: #111; border: 1px solid #2a2a2a; border-radius: 8px; color: #fff; font-size: 13px; outline: none; transition: border-color 0.15s; font-family: inherit; resize: vertical; }
  .yt-field input:focus, .yt-field textarea:focus, .yt-field select:focus { border-color: #c8f135; }
  .yt-field select option { background: #1a1a1a; }
  .yt-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-top: 1px solid #1a1a1a; }
  .toggle-row label { font-size: 13px; color: #aaa; }
  .toggle { position: relative; width: 40px; height: 22px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: #2a2a2a; border-radius: 99px; cursor: pointer; transition: background 0.2s; }
  .toggle-slider:before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #555; border-radius: 50%; transition: transform 0.2s, background 0.2s; }
  .toggle input:checked + .toggle-slider { background: rgba(200,241,53,0.2); }
  .toggle input:checked + .toggle-slider:before { transform: translateX(18px); background: #c8f135; }

  /* EXPORT */
  .export-btn { width: 100%; padding: 15px; font-size: 16px; font-weight: 700; border-radius: 12px; border: none; background: #c8f135; color: #0f0f0f; cursor: pointer; transition: opacity 0.15s; letter-spacing: -0.3px; }
  .export-btn:hover:not(:disabled) { opacity: 0.9; }
  .export-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .export-status { background: #111; border: 1px solid #222; border-radius: 10px; padding: 14px; margin-top: 10px; font-size: 13px; color: #777; display: none; }
  .export-status.active { display: block; }
  .progress-track { height: 3px; background: #222; border-radius: 99px; overflow: hidden; margin-top: 10px; }
  .progress-fill { height: 100%; background: #c8f135; border-radius: 99px; width: 0%; transition: width 0.5s; }

  /* AD MODAL */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 200; display: none; align-items: center; justify-content: center; padding: 1rem; }
  .modal-overlay.open { display: flex; }
  .modal { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2rem; max-width: 420px; width: 100%; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .modal-header h2 { font-size: 18px; font-weight: 700; }
  .modal-close { background: none; border: none; color: #555; font-size: 20px; cursor: pointer; }
  .modal-close:hover { color: #fff; }
  .streak-display { display: flex; justify-content: center; gap: 8px; margin-bottom: 1.5rem; }
  .streak-dot { width: 32px; height: 32px; border-radius: 50%; background: #222; border: 2px solid #2a2a2a; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #555; transition: all 0.3s; }
  .streak-dot.active { background: #c8f135; border-color: #c8f135; color: #0f0f0f; }
  .streak-dot.done { background: #4ade80; border-color: #4ade80; color: #0f0f0f; }
  .offer-box { background: #111; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; text-align: center; }
  .offer-box .amount { font-size: 36px; font-weight: 800; color: #c8f135; }
  .offer-box .label { font-size: 13px; color: #555; margin-top: 4px; }
  .modal-btn { width: 100%; padding: 13px; font-size: 14px; font-weight: 600; border-radius: 10px; border: none; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
  .btn-watch { background: #c8f135; color: #0f0f0f; }
  .btn-collect { background: #4ade80; color: #0f0f0f; }
  .btn-secondary { background: #222; color: #aaa; }
  .cooldown-box { background: #1a0f2e; border: 1px solid #4c1d95; border-radius: 10px; padding: 1.5rem; text-align: center; color: #a78bfa; margin-bottom: 1rem; }
  .cooldown-timer { font-size: 32px; font-weight: 800; color: #a78bfa; margin: 8px 0; }
  .daily-box { background: #0f1a0f; border: 1px solid #166534; border-radius: 10px; padding: 1.5rem; text-align: center; color: #4ade80; margin-bottom: 1rem; }
  .slots-remaining { font-size: 12px; color: #555; text-align: center; margin-top: 4px; }

  #confetti-container { position: fixed; inset: 0; pointer-events: none; z-index: 999; }
  .confetti-piece { position: absolute; border-radius: 2px; animation: fall 3s ease-in forwards; }
  @keyframes fall { 0% { transform: translateY(-20px) rotate(0deg); opacity: 1; } 100% { transform: translateY(100vh) rotate(720deg); opacity: 0; } }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <div class="topbar-logo">Loop<span>mix</span>Video</div>
  </div>
  <div class="topbar-right">
    <div class="credits-pill">
      <span class="coin">🪙</span>
      <span class="amount" id="credits-display">...</span>
    </div>
    <button class="watch-ads-btn" onclick="openAdModal()">🎰 Watch Ads — up to 190 credits</button>
    <img class="user-avatar" id="user-avatar" src="" alt="" />
    <a href="/logout" class="logout">Sign out</a>
  </div>
</div>

<div id="confetti-container"></div>

<!-- AD MODAL -->
<div class="modal-overlay" id="ad-modal">
  <div class="modal">
    <div class="modal-header">
      <h2>🎰 Earn Credits</h2>
      <button class="modal-close" onclick="closeAdModal()">✕</button>
    </div>
    <div class="streak-display" id="streak-dots"></div>
    <div id="ad-content">Loading...</div>
  </div>
</div>

<div class="main">

  <!-- IMAGE -->
  <div class="card">
    <div class="section-label">Background image</div>
    <div class="upload-zone" id="img-zone">
      <input type="file" id="img-input" accept="image/*" onchange="handleImage(event)" />
      <span class="upload-icon">🖼</span>
      <p id="img-label">Click or drag an image here</p>
    </div>
    <img id="img-preview" src="" alt="Preview" />
    <div class="wm-banner active" id="wm-banner">
      <span id="wm-text">⚠️ Your video will have a watermark</span>
      <button class="wm-btn" id="wm-btn" onclick="watchWatermarkAd()">Watch 1 ad to remove</button>
    </div>
  </div>

  <!-- AUDIO -->
  <div class="card">
    <div class="section-label">Audio tracks</div>
    <div class="track-list" id="track-list">
      <div style="font-size:13px;color:#555;text-align:center;padding:6px" id="no-tracks-msg">No tracks added yet</div>
    </div>
    <button class="add-track">
      <input type="file" id="audio-input" accept="audio/*" multiple onchange="handleAudio(event)" />
      + Add audio track
    </button>
  </div>

  <!-- FPS -->
  <div class="card">
    <div class="fps-row">
      <div class="fps-left">
        <label>Frames per second</label>
        <div class="bigval" id="fps-val">1 FPS</div>
        <div class="fps-locked" id="fps-locked">Locked to 1 FPS for image backgrounds</div>
      </div>
    </div>
    <input type="range" id="fps-slider" min="1" max="30" value="1" oninput="updateFps(this.value)" style="display:none" />
  </div>

  <!-- LOOP + DURATION -->
  <div class="card">
    <div class="section-label">Loop &amp; Duration</div>
    <div class="loop-duration-grid">
      <div class="input-group">
        <label>Loop count</label>
        <input type="number" id="loop-count" value="1" min="1" max="999" oninput="onLoopChange()" />
      </div>
      <div class="input-group">
        <label>Video duration (minutes)</label>
        <input type="number" id="duration-mins" value="60" min="1" max="720" oninput="onDurationChange()" />
      </div>
    </div>
    <div class="credit-cost-box" id="credit-cost-box">
      <span class="cost-label">Credit cost</span>
      <span class="cost-amount" id="cost-amount">20 credits</span>
    </div>
  </div>

  <!-- YOUTUBE SETTINGS -->
  <div class="card">
    <button class="yt-toggle" id="yt-toggle" onclick="toggleYT()">
      <span>📺 YouTube Upload Settings</span>
      <span class="arrow">▼</span>
    </button>
    <div class="yt-body" id="yt-body">
      <div class="yt-field">
        <label>Video title</label>
        <input type="text" id="yt-title" placeholder="My Lofi Mix 2026" />
      </div>
      <div class="yt-field">
        <label>Description</label>
        <textarea id="yt-desc" rows="3" placeholder="Relaxing lofi music for studying..."></textarea>
      </div>
      <div class="yt-row">
        <div class="yt-field">
          <label>Visibility</label>
          <select id="yt-visibility">
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </div>
        <div class="yt-field">
          <label>Category</label>
          <select id="yt-category">
            <option value="10">Music</option>
            <option value="22">People & Blogs</option>
            <option value="24">Entertainment</option>
            <option value="27">Education</option>
          </select>
        </div>
      </div>
      <div class="toggle-row">
        <label>Made for kids</label>
        <label class="toggle"><input type="checkbox" id="yt-kids" /><span class="toggle-slider"></span></label>
      </div>
    </div>
  </div>

  <button class="export-btn" id="export-btn" onclick="startExport()">Export Video</button>
  <div class="export-status" id="export-status">
    <div id="export-msg">Preparing export...</div>
    <div class="progress-track"><div class="progress-fill" id="export-progress"></div></div>
  </div>

</div>

<script>
let state = null;
let audioFiles = [];
let audioDurations = [];
let isImageUploaded = false;
const TIERS = [0, 10, 25, 45, 75, 125, 190];
const COLORS = ['#f87171','#fb923c','#facc15','#c8f135','#34d399','#22d3ee','#818cf8'];
const DURATION_CREDITS = [
  { maxSeconds: 600, credits: 5 },
  { maxSeconds: 1800, credits: 10 },
  { maxSeconds: 3600, credits: 20 },
  { maxSeconds: 10800, credits: 40 },
  { maxSeconds: 21600, credits: 75 },
  { maxSeconds: 32400, credits: 125 },
  { maxSeconds: 43200, credits: 170 },
];

function getCreditsForSecs(secs) {
  for (const d of DURATION_CREDITS) { if (secs <= d.maxSeconds) return d.credits; }
  return 170;
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + s + 's';
}

function getTotalAudioSecs() {
  return audioDurations.reduce((a, b) => a + b, 0);
}

function onLoopChange() {
  const loops = parseInt(document.getElementById('loop-count').value) || 1;
  const totalAudio = getTotalAudioSecs();
  if (totalAudio > 0) {
    const mins = Math.round((totalAudio * loops) / 60);
    document.getElementById('duration-mins').value = Math.min(mins, 720);
  }
  updateCreditCost();
}

function onDurationChange() {
  const mins = parseInt(document.getElementById('duration-mins').value) || 1;
  const totalAudio = getTotalAudioSecs();
  if (totalAudio > 0) {
    const loops = Math.max(1, Math.round((mins * 60) / totalAudio));
    document.getElementById('loop-count').value = loops;
  }
  updateCreditCost();
}

function updateCreditCost() {
  const mins = parseInt(document.getElementById('duration-mins').value) || 60;
  const secs = mins * 60;
  const cost = getCreditsForSecs(secs);
  const box = document.getElementById('credit-cost-box');
  const amountEl = document.getElementById('cost-amount');
  const hasEnough = state && state.credits >= cost;

  box.className = 'credit-cost-box' + (hasEnough ? '' : ' insufficient');

  if (hasEnough || !state) {
    amountEl.innerHTML = cost + ' credits';
  } else {
    amountEl.innerHTML = \`<span style="color:#f87171">\${cost} credits</span> <button class="not-enough-btn" onclick="openAdModal()">Not enough — watch ads</button>\`;
  }
}

function updateFps(v) {
  document.getElementById('fps-val').textContent = v + ' FPS';
}

function handleImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  isImageUploaded = true;
  document.getElementById('img-label').textContent = '✓ ' + file.name;
  document.getElementById('img-zone').classList.add('done');
  const preview = document.getElementById('img-preview');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  // Lock FPS for images
  document.getElementById('fps-val').textContent = '1 FPS';
  document.getElementById('fps-slider').style.display = 'none';
  document.getElementById('fps-locked').style.display = 'block';
}

async function handleAudio(e) {
  const files = Array.from(e.target.files);
  for (const f of files) {
    const dur = await getAudioDuration(f);
    audioFiles.push(f);
    audioDurations.push(dur);
  }
  renderTrackList();
  onLoopChange();
  e.target.value = '';
}

function getAudioDuration(file) {
  return new Promise(resolve => {
    const a = new Audio();
    a.onloadedmetadata = () => resolve(a.duration || 0);
    a.onerror = () => resolve(0);
    a.src = URL.createObjectURL(file);
  });
}

function removeTrack(i) {
  audioFiles.splice(i, 1);
  audioDurations.splice(i, 1);
  renderTrackList();
  onLoopChange();
}

function renderTrackList() {
  const list = document.getElementById('track-list');
  if (audioFiles.length === 0) {
    list.innerHTML = '<div style="font-size:13px;color:#555;text-align:center;padding:6px" id="no-tracks-msg">No tracks added yet</div>';
    return;
  }
  list.innerHTML = '';
  audioFiles.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'track-item';
    const mins = Math.floor(audioDurations[i] / 60), secs = Math.floor(audioDurations[i] % 60);
    div.innerHTML = '<span class="track-icon">♪</span><span class="track-name">' + f.name + '</span><span style="font-size:11px;color:#555;flex-shrink:0;">' + mins + ':' + String(secs).padStart(2,'0') + '</span><button class="track-remove" onclick="removeTrack(' + i + ')">✕</button>';
    list.appendChild(div);
  });
}

function toggleYT() {
  const toggle = document.getElementById('yt-toggle');
  const body = document.getElementById('yt-body');
  toggle.classList.toggle('open');
  body.classList.toggle('open');
}

async function watchWatermarkAd() {
  const btn = document.getElementById('wm-btn');
  btn.textContent = '⏳ Ad playing...';
  btn.classList.add('watching');
  btn.disabled = true;
  await new Promise(r => setTimeout(r, 2000)); // fake ad
  const res = await fetch('/watch-watermark-ad', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    await fetchState();
  } else {
    btn.textContent = 'Watch 1 ad to remove';
    btn.classList.remove('watching');
    btn.disabled = false;
  }
}

function updateWatermarkBanner() {
  if (!state) return;
  const banner = document.getElementById('wm-banner');
  const text = document.getElementById('wm-text');
  const btn = document.getElementById('wm-btn');
  if (state.watermarkActive) {
    banner.className = 'wm-banner active';
    text.textContent = '⚠️ Your video will have a watermark';
    btn.textContent = 'Watch 1 ad to remove';
    btn.classList.remove('watching');
    btn.disabled = false;
    btn.style.display = '';
  } else {
    banner.className = 'wm-banner removed';
    const h = Math.floor(state.watermarkSecsLeft / 3600);
    const m = Math.floor((state.watermarkSecsLeft % 3600) / 60);
    text.textContent = '✓ No watermark — removed for ' + (h > 0 ? h + 'h ' : '') + m + 'm more';
    btn.style.display = 'none';
  }
}

// AD MODAL
function openAdModal() {
  document.getElementById('ad-modal').classList.add('open');
  renderAdContent();
}

function closeAdModal() {
  document.getElementById('ad-modal').classList.remove('open');
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

function renderAdContent() {
  if (!state) return;
  renderDots();
  const content = document.getElementById('ad-content');
  if (state.batchesUsed) {
    content.innerHTML = '<div class="daily-box"><div style="font-size:20px;margin-bottom:6px;">✅ All done for today!</div><div style="font-size:13px;">Come back tomorrow for 25 free credits + 12 more ad slots.</div></div><button class="modal-btn btn-secondary" onclick="closeAdModal()">Close</button>';
    return;
  }
  if (state.inCooldown) {
    content.innerHTML = '<div class="cooldown-box"><div style="font-size:14px;">⏳ Cooldown active</div><div class="cooldown-timer" id="countdown"></div><div style="font-size:13px;">Next batch available soon</div></div><button class="modal-btn btn-secondary" onclick="closeAdModal()">Close</button>';
    startCountdown(state.cooldownSecsLeft);
    return;
  }
  if (state.currentStreak === 0) {
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+10</div><div class="label">credits for watching 1 ad</div></div>
      <button class="modal-btn btn-watch" onclick="watchAd()">▶ Watch Ad — get 10 credits</button>
      <div class="slots-remaining">\${state.adsRemainingInBatch} ad slots remaining today</div>
    \`;
  } else {
    const cur = TIERS[state.currentStreak];
    const next = TIERS[state.currentStreak + 1];
    const canContinue = state.currentStreak < 6 && state.adsRemainingInBatch > 0;
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+\${cur}</div><div class="label">credits ready to collect</div></div>
      <button class="modal-btn btn-collect" onclick="collect()">✅ Collect \${cur} credits</button>
      \${canContinue ? \`<button class="modal-btn btn-watch" onclick="watchAd()">🎰 One more ad → +\${next} total</button>\` : ''}
      <button class="modal-btn btn-secondary" onclick="closeAdModal()">Maybe later</button>
    \`;
  }
}

async function watchAd() {
  const content = document.getElementById('ad-content');
  content.innerHTML = '<div style="text-align:center;padding:2rem;color:#555;font-size:14px;">⏳ Ad playing...<br><br><div style="font-size:12px;">Please wait</div></div>';
  await new Promise(r => setTimeout(r, 2000));
  const res = await fetch('/watch-ad', { method: 'POST' });
  const data = await res.json();
  if (data.error) { alert(data.error); await fetchState(); renderAdContent(); return; }
  if (data.isMaxStreak) launchConfetti();
  await fetchState();
  renderAdContent();
}

async function collect() {
  const res = await fetch('/collect', { method: 'POST' });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  if (data.isJackpot) launchConfetti();
  await fetchState();
  renderAdContent();
  updateCreditCost();
}

function startCountdown(secs) {
  let remaining = secs;
  const tick = () => {
    const el = document.getElementById('countdown');
    if (!el) return;
    const m = Math.floor(remaining / 60), s = remaining % 60;
    el.textContent = m + ':' + String(s).padStart(2, '0');
    if (remaining <= 0) { fetchState().then(renderAdContent); return; }
    remaining--;
    setTimeout(tick, 1000);
  };
  tick();
}

function launchConfetti() {
  const container = document.getElementById('confetti-container');
  for (let i = 0; i < 100; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.cssText = \`left:\${Math.random()*100}vw;background:\${COLORS[Math.floor(Math.random()*COLORS.length)]};animation-delay:\${Math.random()*1.5}s;width:\${Math.random()*8+5}px;height:\${Math.random()*8+5}px\`;
    container.appendChild(p);
    setTimeout(() => p.remove(), 4000);
  }
}

async function fetchState() {
  const res = await fetch('/state');
  if (res.redirected || res.status === 401) { window.location.href = '/login'; return; }
  state = await res.json();
  document.getElementById('credits-display').textContent = state.credits;
  if (state.avatar) document.getElementById('user-avatar').src = state.avatar;
  updateWatermarkBanner();
  updateCreditCost();
}

async function startExport() {
  const imgInput = document.getElementById('img-input');
  if (!imgInput.files[0]) { alert('Please select a background image'); return; }
  if (audioFiles.length === 0) { alert('Please add at least one audio track'); return; }

  const mins = parseInt(document.getElementById('duration-mins').value) || 60;
  const secs = mins * 60;
  const cost = getCreditsForSecs(secs);

  if (!state || state.credits < cost) {
    openAdModal();
    return;
  }

  const btn = document.getElementById('export-btn');
  const status = document.getElementById('export-status');
  const msg = document.getElementById('export-msg');
  const progress = document.getElementById('export-progress');

  btn.disabled = true;
  status.classList.add('active');
  msg.textContent = 'Uploading files to server...';
  progress.style.width = '10%';

  const formData = new FormData();
  formData.append('image', imgInput.files[0]);
  audioFiles.forEach(f => formData.append('audio', f));
  formData.append('durationSeconds', secs);
  formData.append('fps', isImageUploaded ? 1 : document.getElementById('fps-slider').value);
  formData.append('repeatCount', document.getElementById('loop-count').value);

  msg.textContent = 'Server encoding your video...';
  progress.style.width = '30%';

  let prog = 30;
  const interval = setInterval(() => { if (prog < 88) { prog += 1; progress.style.width = prog + '%'; } }, 4000);

  try {
    const res = await fetch('/export', { method: 'POST', body: formData });
    clearInterval(interval);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Export failed');
    }
    progress.style.width = '100%';
    msg.textContent = '✓ Done! Downloading your video...';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (document.getElementById('yt-title').value || 'loopmixvideo') + '.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    msg.textContent = '✓ Video downloaded successfully!';
    await fetchState();
  } catch(e) {
    clearInterval(interval);
    msg.textContent = 'Error: ' + e.message;
    progress.style.width = '0%';
  } finally {
    btn.disabled = false;
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
