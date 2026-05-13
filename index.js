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
  { maxSeconds: 600, credits: 5 },
  { maxSeconds: 1800, credits: 10 },
  { maxSeconds: 3600, credits: 20 },
  { maxSeconds: 10800, credits: 40 },
  { maxSeconds: 21600, credits: 75 },
  { maxSeconds: 32400, credits: 125 },
  { maxSeconds: 43200, credits: 170 },
];

function getCreditsForDuration(seconds) {
  for (const d of DURATION_CREDITS) { if (seconds <= d.maxSeconds) return d.credits; }
  return 170;
}

// Track active FFmpeg processes for cancellation
const activeExports = new Map(); // userId -> { proc, outputFile, tmpFiles }

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar TEXT,
    credits INTEGER NOT NULL DEFAULT 25,
    last_daily_reset TIMESTAMP NOT NULL DEFAULT NOW(),
    batch1_ads_used INTEGER NOT NULL DEFAULT 0,
    batch2_ads_used INTEGER NOT NULL DEFAULT 0,
    current_batch INTEGER NOT NULL DEFAULT 1,
    batch_cooldown_until TIMESTAMP,
    current_streak INTEGER NOT NULL DEFAULT 0,
    watermark_removed_until TIMESTAMP,
    hd_removed_until TIMESTAMP
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
  if ((new Date() - new Date(user.last_daily_reset)) / (1000 * 60 * 60) >= 24) {
    await pool.query(`UPDATE users SET credits = credits + 25, last_daily_reset = NOW(),
      batch1_ads_used = 0, batch2_ads_used = 0, current_batch = 1,
      batch_cooldown_until = NULL, current_streak = 0 WHERE id = $1`, [userId]);
    return (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  }
  return user;
}

function cleanupFiles(tmpFiles) {
  tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/login')); });

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>LoopmixVideo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2.5rem; max-width: 420px; width: 100%; text-align: center; }
  .logo { font-size: 48px; margin-bottom: 1rem; }
  h1 { font-size: 28px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.5px; }
  .sub { color: #666; font-size: 15px; margin-bottom: 2rem; line-height: 1.6; }
  .features { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 2rem; }
  .feature { background: #111; border: 1px solid #222; border-radius: 10px; padding: 12px; font-size: 13px; color: #666; text-align: left; }
  .feature strong { display: block; color: #fbbf24; font-size: 14px; margin-bottom: 3px; }
  .btn-google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 15px; background: #fff; color: #000; font-size: 16px; font-weight: 700; border-radius: 12px; border: none; cursor: pointer; text-decoration: none; transition: opacity 0.15s; }
  .btn-google:hover { opacity: 0.9; }
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
    <div class="feature"><strong>MP4 download</strong>Ready for YouTube</div>
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
    const inCooldown = user.batch_cooldown_until && new Date(user.batch_cooldown_until) > now;
    const batchesUsed = user.batch1_ads_used >= 6 && user.batch2_ads_used >= 6;
    const watermarkActive = !user.watermark_removed_until || new Date(user.watermark_removed_until) <= now;
    const hdActive = !user.hd_removed_until || new Date(user.hd_removed_until) <= now;
    res.json({
      credits: user.credits, name: user.name, avatar: user.avatar,
      currentStreak: user.current_streak,
      currentTierCredits: CREDIT_TIERS[user.current_streak] || 0,
      nextTierCredits: CREDIT_TIERS[user.current_streak + 1] || null,
      adsRemainingInBatch: MAX_ADS_PER_BATCH - batchAdsUsed,
      currentBatch: user.current_batch, inCooldown,
      cooldownSecsLeft: inCooldown ? Math.ceil((new Date(user.batch_cooldown_until) - now) / 1000) : 0,
      batchesUsed,
      canWatchAd: !inCooldown && !batchesUsed && (MAX_ADS_PER_BATCH - batchAdsUsed) > 0,
      watermarkActive,
      watermarkSecsLeft: !watermarkActive ? Math.ceil((new Date(user.watermark_removed_until) - now) / 1000) : 0,
      hdActive,
      hdSecsLeft: !hdActive ? Math.ceil((new Date(user.hd_removed_until) - now) / 1000) : 0,
      isExporting: activeExports.has(req.user.id)
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
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const creditsToAdd = CREDIT_TIERS[user.current_streak];
    if (!creditsToAdd) return res.status(400).json({ error: 'Nothing to collect' });
    const batchAdsUsed = user.current_batch === 1 ? user.batch1_ads_used : user.batch2_ads_used;
    const batchDone = batchAdsUsed >= MAX_ADS_PER_BATCH;
    const isJackpot = user.current_streak === MAX_ADS_PER_BATCH;
    let cooldownUntil = null, newBatch = user.current_batch;
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
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET watermark_removed_until = $1 WHERE id = $2', [until, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/watch-hd-ad', requireAuth, async (req, res) => {
  try {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET hd_removed_until = $1 WHERE id = $2', [until, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/cancel-export', requireAuth, async (req, res) => {
  try {
    const exportData = activeExports.get(req.user.id);
    if (!exportData) return res.json({ success: false, message: 'No active export found' });
    exportData.cancelled = true;
    try { exportData.proc.kill('SIGKILL'); } catch(e) {}
    cleanupFiles(exportData.tmpFiles);
    activeExports.delete(req.user.id);
    res.json({ success: true, message: 'Export cancelled. Credits are non-refundable.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/export', requireAuth, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 20 }]), async (req, res) => {
  const tmpFiles = [];
  try {
    const { fps = 1, repeatCount = 1, durationSeconds, fadeIn = 'false', fadeOut = 'false', fitMode = 'original' } = req.body;

    const durSecs = Math.min(parseInt(durationSeconds) || 3600, 43200);
    const doFadeIn = fadeIn === 'true';
    const doFadeOut = fadeOut === 'true';
    const baseCost = getCreditsForDuration(durSecs);
    const fadeCost = (doFadeIn ? 5 : 0) + (doFadeOut ? 5 : 0);
    const totalCost = baseCost + fadeCost;

    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (user.credits < totalCost) return res.status(400).json({ error: `Not enough credits. Need ${totalCost}, have ${user.credits}` });
    if (!req.files.image || !req.files.audio) return res.status(400).json({ error: 'Image and audio required' });
    if (activeExports.has(req.user.id)) return res.status(400).json({ error: 'You already have an export in progress' });

    const imageFile = req.files.image[0];
    const audioFiles = req.files.audio;
    tmpFiles.push(imageFile.path);
    audioFiles.forEach(f => tmpFiles.push(f.path));

    // Deduct credits immediately — non-refundable
    await pool.query('UPDATE users SET credits = credits - $1 WHERE id = $2', [totalCost, req.user.id]);

    const now = new Date();
    const watermarkActive = !user.watermark_removed_until || new Date(user.watermark_removed_until) <= now;
    const hdActive = !user.hd_removed_until || new Date(user.hd_removed_until) <= now;
    const width = hdActive ? 1280 : 1920;
    const height = hdActive ? 720 : 1080;

    // Process image fit
    const processedImage = path.join(os.tmpdir(), `proc_${Date.now()}.jpg`);
    tmpFiles.push(processedImage);

    let scaleFilter;
    if (fitMode === 'crop') {
      scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    } else if (fitMode === 'stretch') {
      scaleFilter = `scale=${width}:${height}`;
    } else if (fitMode === 'blur') {
      const blurredBg = path.join(os.tmpdir(), `blur_${Date.now()}.jpg`);
      tmpFiles.push(blurredBg);
      await runFFmpeg(['-i', imageFile.path, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20`, '-y', blurredBg]);
      await runFFmpeg(['-i', blurredBg, '-i', imageFile.path,
        '-filter_complex', `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2`,
        '-y', processedImage]);
      scaleFilter = null;
    } else {
      scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
    }
    if (scaleFilter) await runFFmpeg(['-i', imageFile.path, '-vf', scaleFilter, '-y', processedImage]);

    // Apply watermark
    let finalImagePath = processedImage;
    if (watermarkActive) {
      const wmPath = path.join(os.tmpdir(), `wm_${Date.now()}.jpg`);
      tmpFiles.push(wmPath);
      await runFFmpeg(['-i', processedImage,
        '-vf', `drawbox=x=0:y=0:w=iw:h=ih/12:color=black@1.0:t=fill,drawtext=text='Uploaded to youtube with loopmixvideo.com':fontcolor=white:fontsize=h/18:x=(w-text_w)/2:y=(ih/12-text_h)/2`,
        '-y', wmPath]);
      finalImagePath = wmPath;
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
    await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatPath, '-c:a', 'aac', '-b:a', '192k', '-vn', mergedAudio]);

    const outputFile = path.join(os.tmpdir(), `output_${Date.now()}.mp4`);
    tmpFiles.push(outputFile);
    const fpsVal = doFadeIn || doFadeOut ? 24 : 1;

    let vf = 'format=yuv420p';
    if (doFadeIn) vf += ',fade=t=in:st=0:d=3';
    if (doFadeOut) vf += `,fade=t=out:st=${durSecs - 3}:d=3`;

    // Start the main FFmpeg process
    const ffmpegArgs = [
      '-loop', '1', '-framerate', String(fpsVal), '-i', finalImagePath,
      '-i', mergedAudio,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-vf', vf,
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(durSecs),
      '-movflags', '+faststart', '-y', outputFile
    ];

    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
    const exportData = { proc: ffmpegProc, outputFile, tmpFiles, cancelled: false };
    activeExports.set(req.user.id, exportData);

    await new Promise((resolve, reject) => {
      let stderr = '';
      ffmpegProc.stderr.on('data', d => stderr += d.toString());
      ffmpegProc.on('close', code => {
        if (exportData.cancelled) { reject(new Error('CANCELLED')); return; }
        if (code === 0) resolve();
        else reject(new Error('FFmpeg: ' + stderr.slice(-500)));
      });
    });

    activeExports.delete(req.user.id);

    // Send file, then delete after 30 seconds
    res.download(outputFile, (req.body.fileName || 'loopmixvideo') + '.mp4', (err) => {
      setTimeout(() => cleanupFiles(tmpFiles), 30000);
    });

  } catch (e) {
    activeExports.delete(req.user.id);
    cleanupFiles(tmpFiles);
    if (e.message === 'CANCELLED') {
      res.status(499).json({ error: 'Export was cancelled' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => { if (code === 0) resolve(); else reject(new Error('FFmpeg: ' + stderr.slice(-500))); });
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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; padding-top: 64px; }
  .topbar { position: fixed; top: 0; left: 0; right: 0; background: #111; border-bottom: 1px solid #222; padding: 0 24px; height: 64px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
  .topbar-logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .topbar-logo span { color: #fbbf24; }
  .topbar-right { display: flex; align-items: center; gap: 14px; }
  .credits-pill { display: flex; align-items: center; gap: 8px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 99px; padding: 8px 16px; }
  .credits-pill .coin { font-size: 18px; }
  .credits-pill .amount { font-size: 17px; font-weight: 700; color: #fbbf24; }
  .watch-ads-btn { background: #fbbf24; color: #0f0f0f; border: none; border-radius: 99px; padding: 9px 18px; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: opacity 0.15s; }
  .watch-ads-btn:hover { opacity: 0.85; }
  .user-avatar { width: 32px; height: 32px; border-radius: 50%; }
  .logout { font-size: 13px; color: #555; text-decoration: none; }
  .logout:hover { color: #f87171; }
  .main { max-width: 900px; margin: 0 auto; padding: 2rem 1rem 5rem; }
  .card { background: #1a1a1a; border: 1px solid #222; border-radius: 14px; padding: 1.5rem; margin-bottom: 12px; }
  .section-label { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #555; margin-bottom: 14px; }
  .image-section { display: grid; grid-template-columns: 1fr 220px; gap: 16px; align-items: start; }
  .yt-preview-label { font-size: 13px; color: #666; margin-bottom: 8px; }
  .yt-thumbnail { width: 100%; aspect-ratio: 16/9; border-radius: 10px; overflow: hidden; background: #000; position: relative; }
  .yt-thumbnail canvas { width: 100%; height: 100%; display: block; }
  .upload-placeholder { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #333; font-size: 14px; gap: 8px; cursor: pointer; position: relative; aspect-ratio: 16/9; }
  .upload-placeholder input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-icon-big { font-size: 36px; color: #fbbf24; }
  .yt-meta { margin-top: 10px; }
  .yt-title-preview { font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .yt-channel { font-size: 13px; color: #888; margin-bottom: 6px; }
  .yt-stats { display: flex; align-items: center; gap: 12px; }
  .yt-likes { display: flex; align-items: center; gap: 5px; background: #222; border-radius: 99px; padding: 4px 12px; font-size: 13px; color: #777; }
  .fit-options { display: flex; flex-direction: column; gap: 8px; }
  .fit-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1.5px solid #2a2a2a; cursor: pointer; transition: all 0.15s; background: transparent; }
  .fit-option:hover { border-color: #fbbf24; }
  .fit-option.active { border-color: #fbbf24; background: rgba(251,191,36,0.08); }
  .fit-thumb { width: 52px; height: 30px; border-radius: 4px; overflow: hidden; background: #000; flex-shrink: 0; }
  .fit-thumb canvas { width: 100%; height: 100%; display: block; }
  .fit-label { font-size: 13px; color: #aaa; line-height: 1.3; }
  .fit-option.active .fit-label { color: #fbbf24; }
  .badge-row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .badge { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; flex: 1; min-width: 200px; }
  .badge.wm-active { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171; }
  .badge.wm-removed { background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); color: #4ade80; }
  .badge.hd-active { background: #111; border: 1px solid #2a2a2a; color: #666; }
  .badge.hd-unlocked { background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.3); color: #fbbf24; }
  .badge-btn { margin-left: auto; background: #fbbf24; color: #0f0f0f; border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: opacity 0.15s; }
  .badge-btn:hover:not(:disabled) { opacity: 0.85; }
  .badge-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .badge-btn.danger { background: #f87171; }
  .track-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .track-item { display: flex; align-items: center; gap: 12px; background: #222; border: 1px solid #333; border-radius: 10px; padding: 12px 16px; }
  .track-icon { color: #fbbf24; font-size: 18px; flex-shrink: 0; }
  .track-name { flex: 1; font-size: 15px; color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .track-dur { font-size: 13px; color: #666; flex-shrink: 0; }
  .track-remove { color: #444; cursor: pointer; font-size: 20px; background: none; border: none; transition: color 0.1s; padding: 0 4px; }
  .track-remove:hover { color: #f87171; }
  .add-track { width: 100%; padding: 13px; background: transparent; border: 1.5px dashed #333; border-radius: 10px; color: #666; font-size: 15px; cursor: pointer; position: relative; transition: all 0.15s; font-weight: 500; }
  .add-track:hover { border-color: #fbbf24; color: #fbbf24; }
  .add-track input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
  .slider-input-row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .slider-input-row label { font-size: 14px; color: #777; width: 130px; flex-shrink: 0; }
  .slider-input-row input[type=range] { flex: 1; -webkit-appearance: none; height: 4px; border-radius: 99px; background: #2a2a2a; outline: none; cursor: pointer; }
  .slider-input-row input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fbbf24; cursor: pointer; }
  .slider-input-row input[type=text], .slider-input-row input[type=number] { width: 90px; padding: 9px 10px; background: #111; border: 1px solid #2a2a2a; border-radius: 8px; color: #fff; font-size: 15px; font-weight: 600; text-align: center; outline: none; transition: border-color 0.15s; flex-shrink: 0; }
  .slider-input-row input:focus { border-color: #fbbf24; }
  .fade-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .fade-btn { padding: 14px; border-radius: 10px; border: 1.5px solid #2a2a2a; background: transparent; color: #777; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; text-align: center; }
  .fade-btn .cost { font-size: 12px; color: #555; margin-top: 4px; }
  .fade-btn:hover { border-color: #fbbf24; color: #fbbf24; }
  .fade-btn.active { background: rgba(251,191,36,0.1); border-color: #fbbf24; color: #fbbf24; }
  .fade-btn.active .cost { color: #999; }
  .credit-cost-box { background: #111; border: 1px solid #2a2a2a; border-radius: 10px; padding: 14px 16px; }
  .credit-row { display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: #666; margin-bottom: 8px; }
  .credit-row:last-child { margin-bottom: 0; padding-top: 10px; border-top: 1px solid #222; font-size: 17px; font-weight: 700; color: #fff; }
  .credit-row .val { color: #fbbf24; font-weight: 600; }
  .not-enough-btn { background: #f87171; color: #0f0f0f; border: none; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 700; cursor: pointer; margin-left: 8px; }
  .go-btn { width: 100%; padding: 17px; font-size: 17px; font-weight: 800; border-radius: 12px; border: none; background: #fbbf24; color: #0f0f0f; cursor: pointer; transition: opacity 0.15s; }
  .go-btn:hover:not(:disabled) { opacity: 0.9; }
  .go-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .cancel-btn { width: 100%; padding: 13px; font-size: 15px; font-weight: 700; border-radius: 12px; border: 1.5px solid #f87171; background: transparent; color: #f87171; cursor: pointer; transition: all 0.15s; margin-top: 8px; display: none; }
  .cancel-btn:hover { background: rgba(248,113,113,0.1); }
  .export-status { background: #111; border: 1px solid #222; border-radius: 10px; padding: 16px; margin-top: 12px; font-size: 14px; color: #777; display: none; }
  .export-status.active { display: block; }
  .export-note { font-size: 12px; color: #555; margin-top: 8px; }
  .progress-track { height: 4px; background: #222; border-radius: 99px; overflow: hidden; margin-top: 12px; }
  .progress-fill { height: 100%; background: #fbbf24; border-radius: 99px; width: 0%; transition: width 0.5s; }
  .result-box { margin-top: 12px; padding: 14px; background: #0f1a0f; border: 1px solid #166534; border-radius: 10px; color: #4ade80; font-size: 14px; display: none; }
  .error-box { margin-top: 12px; padding: 14px; background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 10px; color: #f87171; font-size: 14px; display: none; }
  .retry-btn { background: #fbbf24; color: #0f0f0f; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 700; cursor: pointer; margin-top: 10px; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.88); z-index: 200; display: none; align-items: center; justify-content: center; padding: 1rem; }
  .modal-overlay.open { display: flex; }
  .modal { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2rem; max-width: 440px; width: 100%; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .modal-header h2 { font-size: 20px; font-weight: 800; }
  .modal-close { background: none; border: none; color: #555; font-size: 22px; cursor: pointer; }
  .modal-close:hover { color: #fff; }
  .streak-display { display: flex; justify-content: center; gap: 10px; margin-bottom: 1.5rem; }
  .streak-dot { width: 34px; height: 34px; border-radius: 50%; background: #222; border: 2px solid #2a2a2a; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #555; transition: all 0.3s; }
  .streak-dot.active { background: #fbbf24; border-color: #fbbf24; color: #0f0f0f; }
  .streak-dot.done { background: #4ade80; border-color: #4ade80; color: #0f0f0f; }
  .offer-box { background: #111; border: 1px solid #2a2a2a; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; text-align: center; }
  .offer-box .amount { font-size: 42px; font-weight: 800; color: #fbbf24; }
  .offer-box .label { font-size: 14px; color: #666; margin-top: 4px; }
  .modal-btn { width: 100%; padding: 14px; font-size: 15px; font-weight: 700; border-radius: 10px; border: none; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
  .btn-watch { background: #fbbf24; color: #0f0f0f; }
  .btn-collect { background: #4ade80; color: #0f0f0f; }
  .btn-secondary { background: #222; color: #888; }
  .cooldown-box { background: #1a0f2e; border: 1px solid #4c1d95; border-radius: 10px; padding: 1.5rem; text-align: center; color: #a78bfa; margin-bottom: 1rem; }
  .cooldown-timer { font-size: 36px; font-weight: 800; color: #a78bfa; margin: 10px 0; }
  .daily-box { background: #0f1a0f; border: 1px solid #166534; border-radius: 10px; padding: 1.5rem; text-align: center; color: #4ade80; margin-bottom: 1rem; }
  .slots-info { font-size: 13px; color: #555; text-align: center; margin-top: 6px; }
  #confetti-container { position: fixed; inset: 0; pointer-events: none; z-index: 999; }
  .confetti-piece { position: absolute; border-radius: 2px; animation: fall 3s ease-in forwards; }
  @keyframes fall { 0%{transform:translateY(-20px) rotate(0deg);opacity:1} 100%{transform:translateY(100vh) rotate(720deg);opacity:0} }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-logo">Loop<span>mix</span>Video</div>
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

  <div class="card">
    <div class="section-label">Background Image</div>
    <div class="image-section">
      <div>
        <div class="yt-preview-label">Your Video Preview</div>
        <div class="yt-thumbnail">
          <div class="upload-placeholder" id="upload-placeholder">
            <input type="file" id="img-input" accept="image/*" onchange="handleImage(event)" />
            <span class="upload-icon-big">🖼</span>
            <span style="color:#555;font-size:14px;">Click to upload image</span>
          </div>
          <canvas id="preview-canvas" style="display:none;width:100%;height:100%;"></canvas>
        </div>
        <div class="yt-meta">
          <div class="yt-title-preview" id="yt-title-preview">Your Video Title</div>
          <div class="yt-channel">Your Channel • 1,000,000 views</div>
          <div class="yt-stats">
            <div class="yt-likes">👍 48K</div>
            <div class="yt-likes">👎</div>
          </div>
        </div>
      </div>
      <div class="fit-options">
        <div style="font-size:12px;color:#555;margin-bottom:6px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Fit options</div>
        <div class="fit-option active" id="fit-original" onclick="selectFit('original')">
          <div class="fit-thumb"><canvas id="thumb-original"></canvas></div>
          <div class="fit-label">Original<br><span style="color:#555;font-size:11px;">Black bars</span></div>
        </div>
        <div class="fit-option" id="fit-crop" onclick="selectFit('crop')">
          <div class="fit-thumb"><canvas id="thumb-crop"></canvas></div>
          <div class="fit-label">Crop<br><span style="color:#555;font-size:11px;">Zoom, cut edges</span></div>
        </div>
        <div class="fit-option" id="fit-stretch" onclick="selectFit('stretch')">
          <div class="fit-thumb"><canvas id="thumb-stretch"></canvas></div>
          <div class="fit-label">Stretch<br><span style="color:#555;font-size:11px;">Distort to fill</span></div>
        </div>
        <div class="fit-option" id="fit-blur" onclick="selectFit('blur')">
          <div class="fit-thumb"><canvas id="thumb-blur"></canvas></div>
          <div class="fit-label">Blur fill<br><span style="color:#555;font-size:11px;">Blurred background</span></div>
        </div>
      </div>
    </div>
    <div class="badge-row">
      <div class="badge wm-active" id="wm-badge">
        <span id="wm-text">⚠️ Watermark active</span>
        <button class="badge-btn danger" id="wm-btn" onclick="watchWatermarkAd()">Watch 1 ad to remove</button>
      </div>
      <div class="badge hd-active" id="hd-badge">
        <span id="hd-text">📺 720p — Free</span>
        <button class="badge-btn" id="hd-btn" onclick="watchHdAd()">1080p for 24hrs — Watch 1 ad</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-label">Audio Tracks</div>
    <div class="track-list" id="track-list">
      <div style="font-size:15px;color:#555;text-align:center;padding:12px">No tracks added yet</div>
    </div>
    <button class="add-track">
      <input type="file" id="audio-input" accept="audio/*" multiple onchange="handleAudio(event)" />
      + Add audio track
    </button>
  </div>

  <div class="card" id="fps-section" style="display:none">
    <div class="section-label">Frames Per Second</div>
    <div class="slider-input-row">
      <label>FPS</label>
      <input type="range" id="fps-slider" min="1" max="30" value="1" oninput="onFpsSlider(this.value)" />
      <input type="number" id="fps-input" value="1" min="1" max="30" oninput="onFpsInput(this.value)" />
    </div>
  </div>

  <div class="card">
    <div class="section-label">Loop &amp; Duration</div>
    <div class="slider-input-row">
      <label>Loop count</label>
      <input type="range" id="loop-slider" min="1" max="200" value="1" oninput="onLoopSlider(this.value)" />
      <input type="number" id="loop-input" value="1" min="1" max="999" oninput="onLoopInput(this.value)" />
    </div>
    <div class="slider-input-row">
      <label>Duration</label>
      <input type="range" id="dur-slider" min="1" max="720" value="60" oninput="onDurSlider(this.value)" />
      <input type="text" id="dur-input" value="1:00:00" oninput="onDurText(this.value)" onblur="formatDurInput()" />
    </div>
    <div class="section-label" style="margin-top:16px;">Fade Effects</div>
    <div class="fade-grid">
      <button class="fade-btn" id="fade-in-btn" onclick="toggleFade('in')">▶ Fade In<div class="cost">+5 credits · 3 sec from black</div></button>
      <button class="fade-btn" id="fade-out-btn" onclick="toggleFade('out')">Fade Out ◀<div class="cost">+5 credits · 3 sec to black</div></button>
    </div>
    <div class="credit-cost-box">
      <div class="credit-row"><span>Duration cost</span><span class="val" id="cost-duration">20 credits</span></div>
      <div class="credit-row" id="cost-fadein-row" style="display:none"><span>Fade in</span><span class="val">+5 credits</span></div>
      <div class="credit-row" id="cost-fadeout-row" style="display:none"><span>Fade out</span><span class="val">+5 credits</span></div>
      <div class="credit-row"><span>Total</span><span class="val" id="cost-total">20 credits</span></div>
    </div>
  </div>

  <div class="card">
    <div class="section-label">Export</div>
    <div style="font-size:13px;color:#555;margin-bottom:12px;">⚠️ Credits are deducted immediately when export starts and are non-refundable if cancelled. Your video will auto-download when ready and be deleted from our servers within 30 seconds.</div>
    <button class="go-btn" id="go-btn" onclick="startExport()">Export &amp; Download MP4</button>
    <button class="cancel-btn" id="cancel-btn" onclick="cancelExport()">✕ Cancel Export (credits non-refundable)</button>
    <div class="export-status" id="export-status">
      <div id="export-msg">Preparing...</div>
      <div class="progress-track"><div class="progress-fill" id="export-progress"></div></div>
    </div>
    <div class="result-box" id="result-box"></div>
    <div class="error-box" id="error-box">
      <div id="error-msg"></div>
      <button class="retry-btn" onclick="startExport()">Try Again</button>
    </div>
  </div>

</div>

<script>
let state = null;
let audioFiles = [], audioDurations = [];
let fadeInActive = false, fadeOutActive = false;
let isImageFile = false;
let fitMode = 'original';
let uploadedImage = null;
let isExporting = false;
const TIERS = [0,10,25,45,75,125,190];
const COLORS = ['#f87171','#fb923c','#facc15','#fbbf24','#34d399','#22d3ee','#818cf8'];
const DURATION_CREDITS = [
  {maxSeconds:600,credits:5},{maxSeconds:1800,credits:10},{maxSeconds:3600,credits:20},
  {maxSeconds:10800,credits:40},{maxSeconds:21600,credits:75},{maxSeconds:32400,credits:125},{maxSeconds:43200,credits:170}
];

function getCreditsForSecs(s) {
  for (const d of DURATION_CREDITS) { if (s <= d.maxSeconds) return d.credits; }
  return 170;
}
function parseDur(val) {
  val = String(val).trim();
  const parts = val.split(':').map(p => parseInt(p)||0);
  if (parts.length === 3) return parts[0]*3600+parts[1]*60+parts[2];
  if (parts.length === 2) return parts[0]*3600+parts[1]*60;
  return (parseInt(val)||0)*60;
}
function secsToHMS(s) {
  s = Math.max(60, Math.min(s, 43200));
  return Math.floor(s/3600)+':'+String(Math.floor((s%3600)/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function getTotalAudioSecs() { return audioDurations.reduce((a,b)=>a+b,0); }

function onLoopSlider(v) { document.getElementById('loop-input').value=v; syncDurFromLoop(parseInt(v)); }
function onLoopInput(v) { const l=Math.max(1,parseInt(v)||1); document.getElementById('loop-slider').value=Math.min(l,200); syncDurFromLoop(l); }
function syncDurFromLoop(loops) {
  const total = getTotalAudioSecs();
  if (total > 0) { const s=Math.min(Math.round(total*loops),43200); document.getElementById('dur-input').value=secsToHMS(s); document.getElementById('dur-slider').value=Math.round(s/60); }
  updateCreditCost();
}
function onDurSlider(v) { const s=parseInt(v)*60; document.getElementById('dur-input').value=secsToHMS(s); syncLoopFromDur(s); }
function onDurText(v) { const s=parseDur(v); document.getElementById('dur-slider').value=Math.round(Math.min(s,43200)/60); syncLoopFromDur(s); }
function formatDurInput() { document.getElementById('dur-input').value=secsToHMS(parseDur(document.getElementById('dur-input').value)); }
function syncLoopFromDur(secs) {
  const total = getTotalAudioSecs();
  if (total > 0) { const l=Math.max(1,Math.round(secs/total)); document.getElementById('loop-input').value=l; document.getElementById('loop-slider').value=Math.min(l,200); }
  updateCreditCost();
}
function onFpsSlider(v) { document.getElementById('fps-input').value=v; }
function onFpsInput(v) { document.getElementById('fps-slider').value=Math.min(Math.max(parseInt(v)||1,1),30); }

function toggleFade(type) {
  if (type==='in') { fadeInActive=!fadeInActive; document.getElementById('fade-in-btn').classList.toggle('active',fadeInActive); document.getElementById('cost-fadein-row').style.display=fadeInActive?'flex':'none'; }
  else { fadeOutActive=!fadeOutActive; document.getElementById('fade-out-btn').classList.toggle('active',fadeOutActive); document.getElementById('cost-fadeout-row').style.display=fadeOutActive?'flex':'none'; }
  updateCreditCost();
}

function updateCreditCost() {
  const secs = parseDur(document.getElementById('dur-input').value);
  const base = getCreditsForSecs(secs);
  const fade = (fadeInActive?5:0)+(fadeOutActive?5:0);
  const total = base+fade;
  document.getElementById('cost-duration').textContent = base+' credits';
  const totalEl = document.getElementById('cost-total');
  const hasEnough = state && state.credits >= total;
  if (!hasEnough && state) {
    totalEl.innerHTML = total+' credits <button class="not-enough-btn" onclick="openAdModal()">Not enough — watch ads</button>';
  } else {
    totalEl.textContent = total+' credits';
  }
}

function selectFit(mode) {
  fitMode = mode;
  document.querySelectorAll('.fit-option').forEach(el => el.classList.remove('active'));
  document.getElementById('fit-'+mode).classList.add('active');
  drawPreview();
}

function handleImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  isImageFile = ['jpg','jpeg','png','webp'].includes(ext);
  document.getElementById('fps-section').style.display = isImageFile ? 'none' : 'block';
  document.getElementById('upload-placeholder').style.display = 'none';
  const canvas = document.getElementById('preview-canvas');
  canvas.style.display = 'block';
  const img = new Image();
  img.onload = () => { uploadedImage = img; drawPreview(); drawThumbs(); };
  img.src = URL.createObjectURL(file);
}

function drawPreview() {
  if (!uploadedImage) return;
  const canvas = document.getElementById('preview-canvas');
  const W = canvas.offsetWidth || 560, H = Math.round(W * 9/16);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);
  drawFit(ctx, uploadedImage, W, H, fitMode);
}

function drawFit(ctx, img, W, H, mode) {
  const iw=img.width, ih=img.height;
  if (mode==='crop') {
    const scale=Math.max(W/iw,H/ih);
    const sw=W/scale, sh=H/scale, sx=(iw-sw)/2, sy=(ih-sh)/2;
    ctx.drawImage(img,sx,sy,sw,sh,0,0,W,H);
  } else if (mode==='stretch') {
    ctx.drawImage(img,0,0,W,H);
  } else if (mode==='blur') {
    const scale=Math.max(W/iw,H/ih);
    const sw=W/scale, sh=H/scale, sx=(iw-sw)/2, sy=(ih-sh)/2;
    ctx.filter='blur(20px)';
    ctx.drawImage(img,sx,sy,sw,sh,-20,-20,W+40,H+40);
    ctx.filter='none';
    const scale2=Math.min(W/iw,H/ih);
    const dw=iw*scale2, dh=ih*scale2;
    ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);
  } else {
    const scale=Math.min(W/iw,H/ih);
    const dw=iw*scale, dh=ih*scale;
    ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);
  }
}

function drawThumbs() {
  if (!uploadedImage) return;
  ['original','crop','stretch','blur'].forEach(mode => {
    const canvas = document.getElementById('thumb-'+mode);
    canvas.width=52; canvas.height=30;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#000'; ctx.fillRect(0,0,52,30);
    drawFit(ctx,uploadedImage,52,30,mode);
  });
}

async function handleAudio(e) {
  const files = Array.from(e.target.files);
  for (const f of files) { const d=await getAudioDuration(f); audioFiles.push(f); audioDurations.push(d); }
  renderTrackList();
  if (getTotalAudioSecs()>0) syncDurFromLoop(parseInt(document.getElementById('loop-input').value)||1);
  e.target.value='';
}
function getAudioDuration(file) {
  return new Promise(resolve => { const a=new Audio(); a.onloadedmetadata=()=>resolve(a.duration||0); a.onerror=()=>resolve(0); a.src=URL.createObjectURL(file); });
}
function removeTrack(i) { audioFiles.splice(i,1); audioDurations.splice(i,1); renderTrackList(); updateCreditCost(); }
function renderTrackList() {
  const list=document.getElementById('track-list');
  if (audioFiles.length===0) { list.innerHTML='<div style="font-size:15px;color:#555;text-align:center;padding:12px">No tracks added yet</div>'; return; }
  list.innerHTML='';
  audioFiles.forEach((f,i) => {
    const m=Math.floor(audioDurations[i]/60), s=Math.floor(audioDurations[i]%60);
    const div=document.createElement('div'); div.className='track-item';
    div.innerHTML='<span class="track-icon">♪</span><span class="track-name">'+f.name+'</span><span class="track-dur">'+m+':'+String(s).padStart(2,'0')+'</span><button class="track-remove" onclick="removeTrack('+i+')">✕</button>';
    list.appendChild(div);
  });
}

async function watchWatermarkAd() {
  const btn=document.getElementById('wm-btn'); btn.textContent='⏳ Ad playing...'; btn.disabled=true;
  await new Promise(r=>setTimeout(r,2000));
  const res=await fetch('/watch-watermark-ad',{method:'POST'});
  if ((await res.json()).success) await fetchState();
  else { btn.textContent='Watch 1 ad to remove'; btn.disabled=false; }
}

async function watchHdAd() {
  const btn=document.getElementById('hd-btn'); btn.textContent='⏳ Ad playing...'; btn.disabled=true;
  await new Promise(r=>setTimeout(r,2000));
  const res=await fetch('/watch-hd-ad',{method:'POST'});
  if ((await res.json()).success) await fetchState();
  else { btn.textContent='1080p for 24hrs — Watch 1 ad'; btn.disabled=false; }
}

function updateBadges() {
  if (!state) return;
  const wmBadge=document.getElementById('wm-badge'), wmText=document.getElementById('wm-text'), wmBtn=document.getElementById('wm-btn');
  const hdBadge=document.getElementById('hd-badge'), hdText=document.getElementById('hd-text'), hdBtn=document.getElementById('hd-btn');
  if (state.watermarkActive) {
    wmBadge.className='badge wm-active'; wmText.textContent='⚠️ Watermark active'; wmBtn.style.display=''; wmBtn.textContent='Watch 1 ad to remove'; wmBtn.disabled=false;
  } else {
    const h=Math.floor(state.watermarkSecsLeft/3600), m=Math.floor((state.watermarkSecsLeft%3600)/60);
    wmBadge.className='badge wm-removed'; wmText.textContent='✓ No watermark — '+(h>0?h+'h ':'')+m+'m left'; wmBtn.style.display='none';
  }
  if (state.hdActive) {
    hdBadge.className='badge hd-active'; hdText.textContent='📺 720p — Free'; hdBtn.textContent='1080p for 24hrs — Watch 1 ad'; hdBtn.disabled=false; hdBtn.style.display='';
  } else {
    const h=Math.floor(state.hdSecsLeft/3600), m=Math.floor((state.hdSecsLeft%3600)/60);
    hdBadge.className='badge hd-unlocked'; hdText.textContent='🎬 1080p unlocked — '+(h>0?h+'h ':'')+m+'m left'; hdBtn.style.display='none';
  }
}

function openAdModal() { document.getElementById('ad-modal').classList.add('open'); renderAdContent(); }
function closeAdModal() { document.getElementById('ad-modal').classList.remove('open'); }

function renderDots() {
  if (!state) return;
  const c=document.getElementById('streak-dots'); c.innerHTML='';
  for (let i=1;i<=6;i++) { const d=document.createElement('div'); d.className='streak-dot'+(i<state.currentStreak?' done':i===state.currentStreak?' active':''); d.textContent=i; c.appendChild(d); }
}

function renderAdContent() {
  if (!state) return;
  renderDots();
  const content=document.getElementById('ad-content');
  if (state.batchesUsed) { content.innerHTML='<div class="daily-box"><div style="font-size:22px;margin-bottom:8px;">✅ All done for today!</div><div style="font-size:15px;">Come back tomorrow for 25 free credits + 12 more ad slots.</div></div><button class="modal-btn btn-secondary" onclick="closeAdModal()">Close</button>'; return; }
  if (state.inCooldown) { content.innerHTML='<div class="cooldown-box"><div>⏳ Cooldown active</div><div class="cooldown-timer" id="countdown"></div><div>Next batch available soon</div></div><button class="modal-btn btn-secondary" onclick="closeAdModal()">Close</button>'; startCountdown(state.cooldownSecsLeft); return; }
  if (state.currentStreak===0) {
    content.innerHTML=\`<div class="offer-box"><div class="amount">+10</div><div class="label">credits for watching 1 ad</div></div><button class="modal-btn btn-watch" onclick="watchAd()">▶ Watch Ad — get 10 credits</button><div class="slots-info">\${state.adsRemainingInBatch} ad slots remaining today</div>\`;
  } else {
    const cur=TIERS[state.currentStreak], next=TIERS[state.currentStreak+1], canContinue=state.currentStreak<6&&state.adsRemainingInBatch>0;
    content.innerHTML=\`<div class="offer-box"><div class="amount">+\${cur}</div><div class="label">credits ready to collect</div></div><button class="modal-btn btn-collect" onclick="collect()">✅ Collect \${cur} credits</button>\${canContinue?\`<button class="modal-btn btn-watch" onclick="watchAd()">🎰 One more → +\${next} total</button>\`:''}<button class="modal-btn btn-secondary" onclick="closeAdModal()">Maybe later</button>\`;
  }
}

async function watchAd() {
  document.getElementById('ad-content').innerHTML='<div style="text-align:center;padding:2.5rem;color:#555;font-size:15px;">⏳ Ad playing...<br><br><span style="font-size:13px;">Please wait</span></div>';
  await new Promise(r=>setTimeout(r,2000));
  const res=await fetch('/watch-ad',{method:'POST'}); const data=await res.json();
  if (data.error){alert(data.error);await fetchState();renderAdContent();return;}
  if (data.isMaxStreak) launchConfetti();
  await fetchState(); renderAdContent();
}
async function collect() {
  const res=await fetch('/collect',{method:'POST'}); const data=await res.json();
  if (data.error){alert(data.error);return;}
  if (data.isJackpot) launchConfetti();
  await fetchState(); renderAdContent(); updateCreditCost();
}
function startCountdown(secs) {
  let r=secs;
  const tick=()=>{ const el=document.getElementById('countdown'); if(!el)return; el.textContent=Math.floor(r/60)+':'+String(r%60).padStart(2,'0'); if(r<=0){fetchState().then(renderAdContent);return;} r--; setTimeout(tick,1000); };
  tick();
}
function launchConfetti() {
  const c=document.getElementById('confetti-container');
  for(let i=0;i<100;i++){const p=document.createElement('div');p.className='confetti-piece';p.style.cssText=\`left:\${Math.random()*100}vw;background:\${COLORS[Math.floor(Math.random()*COLORS.length)]};animation-delay:\${Math.random()*1.5}s;width:\${Math.random()*8+5}px;height:\${Math.random()*8+5}px\`;c.appendChild(p);setTimeout(()=>p.remove(),4000);}
}

async function fetchState() {
  const res=await fetch('/state');
  if (res.redirected||res.status===401){window.location.href='/login';return;}
  state=await res.json();
  document.getElementById('credits-display').textContent=state.credits;
  if (state.avatar) document.getElementById('user-avatar').src=state.avatar;
  updateBadges(); updateCreditCost();
}

async function cancelExport() {
  const res = await fetch('/cancel-export', {method:'POST'});
  const data = await res.json();
  document.getElementById('export-msg').textContent = '✕ Export cancelled — credits were not refunded';
  document.getElementById('export-progress').style.width = '0%';
  document.getElementById('cancel-btn').style.display = 'none';
  document.getElementById('go-btn').disabled = false;
  isExporting = false;
  await fetchState();
}

async function startExport() {
  if (!document.getElementById('img-input').files[0]) { alert('Please select a background image'); return; }
  if (audioFiles.length===0) { alert('Please add at least one audio track'); return; }
  const secs=parseDur(document.getElementById('dur-input').value);
  const total=getCreditsForSecs(secs)+(fadeInActive?5:0)+(fadeOutActive?5:0);
  if (!state||state.credits<total){openAdModal();return;}

  const btn=document.getElementById('go-btn');
  const cancelBtn=document.getElementById('cancel-btn');
  const status=document.getElementById('export-status');
  const msg=document.getElementById('export-msg');
  const progress=document.getElementById('export-progress');
  const resultBox=document.getElementById('result-box');
  const errorBox=document.getElementById('error-box');

  btn.disabled=true;
  cancelBtn.style.display='block';
  status.classList.add('active');
  resultBox.style.display='none';
  errorBox.style.display='none';
  isExporting=true;
  msg.textContent='Uploading files to server...';
  progress.style.width='8%';

  const formData=new FormData();
  formData.append('image',document.getElementById('img-input').files[0]);
  audioFiles.forEach(f=>formData.append('audio',f));
  formData.append('durationSeconds',secs);
  formData.append('fps',isImageFile?1:(document.getElementById('fps-input').value||1));
  formData.append('repeatCount',document.getElementById('loop-input').value||1);
  formData.append('fadeIn',fadeInActive);
  formData.append('fadeOut',fadeOutActive);
  formData.append('fitMode',fitMode);
  formData.append('fileName', document.getElementById('yt-title-preview').textContent || 'loopmixvideo');

  msg.textContent='Encoding video — this may take a few minutes...';
  progress.style.width='20%';
  let prog=20;
  const iv=setInterval(()=>{if(prog<85){prog++;progress.style.width=prog+'%';}},5000);

  try {
    const res=await fetch('/export',{method:'POST',body:formData});
    clearInterval(iv);
    if (!res.ok) {
      const e=await res.json();
      throw new Error(e.error||'Export failed');
    }
    progress.style.width='95%';
    msg.textContent='✓ Done! Downloading your video...';
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=(document.getElementById('yt-title-preview').textContent||'loopmixvideo')+'.mp4';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    progress.style.width='100%';
    msg.textContent='✓ Complete!';
    resultBox.innerHTML='✓ Video downloaded! File will be deleted from our servers within 30 seconds.';
    resultBox.style.display='block';
    await fetchState();
  } catch(e) {
    clearInterval(iv);
    if (e.message !== 'Export was cancelled') {
      document.getElementById('error-msg').textContent='Error: '+e.message;
      errorBox.style.display='block';
    }
    msg.textContent='Failed';
    progress.style.width='0%';
  } finally {
    btn.disabled=false;
    cancelBtn.style.display='none';
    isExporting=false;
  }
}

fetchState();
setInterval(fetchState,30000);
window.addEventListener('resize',drawPreview);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
