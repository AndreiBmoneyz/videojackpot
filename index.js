const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

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

// Create users table that supports multiple users
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
  } catch (e) {
    return done(e);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, res.rows[0]);
  } catch (e) {
    done(e);
  }
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

// Auth routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

// Login page
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
  .btn-google img { width: 20px; height: 20px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🎬</div>
  <h1>LoopmixVideo</h1>
  <p>Create long music mix videos for free.<br>Sign in to get started and earn credits.</p>
  <a href="/auth/google" class="btn-google">
    <img src="https://www.google.com/favicon.ico" alt="Google" />
    Sign in with Google
  </a>
</div>
</body>
</html>`);
});

// API routes (all require auth)
app.get('/state', requireAuth, async (req, res) => {
  try {
    const user = await checkDailyReset(req.user.id);
    const now = new Date();
    const batchAdsUsed = user.current_batch === 1 ? user.batch1_ads_used : user.batch2_ads_used;
    const adsRemainingInBatch = MAX_ADS_PER_BATCH - batchAdsUsed;
    const inCooldown = user.batch_cooldown_until && new Date(user.batch_cooldown_until) > now;
    const cooldownSecsLeft = inCooldown ? Math.ceil((new Date(user.batch_cooldown_until) - now) / 1000) : 0;
    const batchesUsed = user.batch1_ads_used >= 6 && user.batch2_ads_used >= 6;
    const nextTierCredits = CREDIT_TIERS[user.current_streak + 1] || null;
    const currentTierCredits = CREDIT_TIERS[user.current_streak] || 0;

    res.json({
      credits: user.credits,
      name: user.name,
      avatar: user.avatar,
      currentStreak: user.current_streak,
      currentTierCredits,
      nextTierCredits,
      adsRemainingInBatch,
      currentBatch: user.current_batch,
      inCooldown,
      cooldownSecsLeft,
      batchesUsed,
      canWatchAd: !inCooldown && !batchesUsed && adsRemainingInBatch > 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    await pool.query(`
      UPDATE users SET
        current_streak = $1,
        ${batchCol} = ${batchCol} + 1
      WHERE id = $2
    `, [newStreak, req.user.id]);

    const isMaxStreak = newStreak === MAX_ADS_PER_BATCH;
    res.json({
      newStreak,
      offeredCredits: CREDIT_TIERS[newStreak],
      isMaxStreak,
      canContinue: !isMaxStreak && (batchAdsUsed + 1) < MAX_ADS_PER_BATCH
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    await pool.query(`
      UPDATE users SET
        credits = credits + $1,
        current_streak = 0,
        batch_cooldown_until = $2,
        current_batch = $3
      WHERE id = $4
    `, [creditsToAdd, cooldownUntil, newBatch, req.user.id]);

    res.json({ creditsAdded: creditsToAdd, isJackpot, cooldownUntil });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
  .credits-bar { position: fixed; top: 0; left: 0; right: 0; background: #1a1a1a; border-bottom: 1px solid #333; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
  .credits-right { display: flex; align-items: center; gap: 12px; }
  .credits-count { font-size: 18px; font-weight: 700; color: #c8f135; }
  .credits-label { font-size: 13px; color: #777; }
  .user-info { display: flex; align-items: center; gap: 8px; }
  .user-avatar { width: 28px; height: 28px; border-radius: 50%; }
  .user-name { font-size: 13px; color: #aaa; }
  .logout { font-size: 12px; color: #555; text-decoration: none; margin-left: 8px; }
  .logout:hover { color: #f87171; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2rem; max-width: 420px; width: 100%; text-align: center; margin-top: 60px; }
  .card h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .card p { color: #777; font-size: 14px; margin-bottom: 2rem; }
  .streak-display { display: flex; justify-content: center; gap: 8px; margin-bottom: 2rem; }
  .streak-dot { width: 32px; height: 32px; border-radius: 50%; background: #2a2a2a; border: 2px solid #333; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #555; transition: all 0.3s; }
  .streak-dot.active { background: #c8f135; border-color: #c8f135; color: #0f0f0f; }
  .streak-dot.done { background: #4ade80; border-color: #4ade80; color: #0f0f0f; }
  .btn { width: 100%; padding: 14px; font-size: 15px; font-weight: 600; border-radius: 12px; border: none; cursor: pointer; transition: all 0.15s; margin-bottom: 10px; }
  .btn-watch { background: #c8f135; color: #0f0f0f; }
  .btn-watch:hover { opacity: 0.9; }
  .btn-collect { background: #4ade80; color: #0f0f0f; }
  .btn-collect:hover { opacity: 0.9; }
  .offer-box { background: #0f0f0f; border: 1px solid #333; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
  .offer-box .amount { font-size: 32px; font-weight: 800; color: #c8f135; }
  .offer-box .label { font-size: 13px; color: #777; margin-top: 4px; }
  .cooldown-box { background: #1a0f2e; border: 1px solid #4c1d95; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; color: #a78bfa; font-size: 14px; }
  .cooldown-timer { font-size: 28px; font-weight: 800; color: #a78bfa; margin: 8px 0; }
  .daily-box { background: #0f1a0f; border: 1px solid #166534; border-radius: 10px; padding: 1rem; color: #4ade80; font-size: 13px; }
  #confetti-container { position: fixed; inset: 0; pointer-events: none; z-index: 999; }
  .confetti-piece { position: absolute; width: 10px; height: 10px; border-radius: 2px; animation: confetti-fall 3s ease-in forwards; }
  @keyframes confetti-fall { 0% { transform: translateY(-20px) rotate(0deg); opacity: 1; } 100% { transform: translateY(100vh) rotate(720deg); opacity: 0; } }
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
<div class="card">
  <h1>🎰 Video Jackpot</h1>
  <p>Watch ads to earn credits. Go further for bigger rewards.</p>
  <div class="streak-display" id="streak-dots"></div>
  <div id="main-content">Loading...</div>
</div>

<script>
let state = null;
const TIERS = [0, 10, 25, 45, 75, 125, 190];
const COLORS = ['#f87171','#fb923c','#facc15','#a3e635','#34d399','#22d3ee','#818cf8'];

async function fetchState() {
  const res = await fetch('/state');
  if (res.redirected || res.status === 401) { window.location.href = '/login'; return; }
  state = await res.json();
  render();
}

function render() {
  document.getElementById('credits-display').textContent = state.credits;
  if (state.avatar) document.getElementById('user-avatar').src = state.avatar;
  if (state.name) document.getElementById('user-name').textContent = state.name;
  renderDots();
  const content = document.getElementById('main-content');

  if (state.batchesUsed) {
    content.innerHTML = \`<div class="daily-box"><div style="font-size:18px;margin-bottom:4px;">✅ All done for today!</div><div>Come back tomorrow for 25 free credits + 12 more ad slots.</div></div>\`;
    return;
  }

  if (state.inCooldown) {
    content.innerHTML = \`<div class="cooldown-box"><div>⏳ Cooldown active</div><div class="cooldown-timer" id="countdown"></div><div>Next batch available soon</div></div>\`;
    startCountdown(state.cooldownSecsLeft);
    return;
  }

  if (state.currentStreak === 0) {
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+10</div><div class="label">credits for watching 1 ad</div></div>
      <button class="btn btn-watch" onclick="watchAd()">▶ Watch Ad (+10 credits)</button>
      <div style="font-size:12px;color:#555;margin-top:8px;">\${state.adsRemainingInBatch} ad slots remaining in this batch</div>
    \`;
  } else {
    const currentOffer = TIERS[state.currentStreak];
    const nextOffer = TIERS[state.currentStreak + 1];
    const canContinue = state.currentStreak < 6 && state.adsRemainingInBatch > 0;
    content.innerHTML = \`
      <div class="offer-box"><div class="amount">+\${currentOffer}</div><div class="label">credits ready to collect</div></div>
      <button class="btn btn-collect" onclick="collect()">✅ Collect \${currentOffer} credits</button>
      \${canContinue ? \`<button class="btn btn-watch" onclick="watchAd()" style="background:#333;color:#fff;">🎰 Watch one more → +\${nextOffer} total</button>\` : ''}
    \`;
  }
}

function renderDots() {
  const container = document.getElementById('streak-dots');
  container.innerHTML = '';
  for (let i = 1; i <= 6; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot' + (i < state.currentStreak ? ' done' : i === state.currentStreak ? ' active' : '');
    dot.textContent = i;
    container.appendChild(dot);
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
  const el = document.getElementById('countdown');
  if (!el) return;
  let remaining = secs;
  const tick = () => {
    if (!document.getElementById('countdown')) return;
    const m = Math.floor(remaining / 60), s = remaining % 60;
    document.getElementById('countdown').textContent = m + ':' + String(s).padStart(2, '0');
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
