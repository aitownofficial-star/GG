const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "scores.json");

if (!process.env.DATABASE_URL ||
    !process.env.ADMIN_USERNAME ||
    !process.env.ADMIN_PASSWORD ||
    !process.env.SESSION_SECRET) {
  console.error("Set DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET environment variables.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  // Render terminates HTTPS at its proxy; this allows secure session cookies.
  app.set("trust proxy", 1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon connection URLs commonly include sslmode=require.
  // If your provider gives a URL without SSL settings, configure SSL there.
});

pool.on("error", err => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "scoreboard.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  return res.status(401).json({ error: "로그인이 필요합니다." });
}

function cleanText(value, max = 80) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validScore(value) {
  return Number.isInteger(value) && Math.abs(value) <= 1000000;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      rank TEXT NOT NULL,
      role TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score BETWEEN -1000000 AND 1000000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One-time-safe migration from the previous JSON-file version, if present.
  // Repeated starts are safe because existing IDs are ignored.
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldScores = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (Array.isArray(oldScores)) {
        for (const item of oldScores) {
          if (
            item &&
            typeof item.id === "string" &&
            typeof item.rank === "string" &&
            typeof item.role === "string" &&
            Number.isInteger(item.score) &&
            Math.abs(item.score) <= 1000000
          ) {
            await pool.query(
              `INSERT INTO scores (id, rank, role, score)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO NOTHING`,
              [item.id, item.rank.slice(0, 80), item.role.slice(0, 80), item.score]
            );
          }
        }
        console.log("Checked legacy scores.json for migration.");
      }
    } catch (err) {
      console.warn("Could not migrate scores.json:", err.message);
    }
  }
}

app.post("/api/login", (req, res, next) => {
  const username = cleanText(req.body?.username, 120);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  }

  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.save(saveErr => {
      if (saveErr) return next(saveErr);
      res.json({ ok: true });
    });
  });
});

app.post("/api/logout", (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("scoreboard.sid").json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ loggedIn: req.session?.isAdmin === true });
});

app.get("/api/scores", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, rank, role, score FROM scores ORDER BY created_at ASC, id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.post("/api/scores", requireAdmin, async (req, res, next) => {
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);

  if (!rank || !role || !validScore(score)) {
    return res.status(400).json({ error: "계급, 보직, 정수 점수를 올바르게 입력해 주세요." });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await pool.query(
      "INSERT INTO scores (id, rank, role, score) VALUES ($1, $2, $3, $4)",
      [id, rank, role, score]
    );
    res.status(201).json(await getScores());
  } catch (err) {
    next(err);
  }
});

async function getScores() {
  const result = await pool.query(
    "SELECT id, rank, role, score FROM scores ORDER BY created_at ASC, id ASC"
  );
  return result.rows;
}

app.patch("/api/scores/:id", requireAdmin, async (req, res, next) => {
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);

  if (!rank || !role || !validScore(score)) {
    return res.status(400).json({ error: "입력값을 확인해 주세요." });
  }

  try {
    const result = await pool.query(
      "UPDATE scores SET rank = $1, role = $2, score = $3 WHERE id = $4",
      [rank, role, score, req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "항목을 찾을 수 없습니다." });
    }
    res.json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.delete("/api/scores/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query("DELETE FROM scores WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "항목을 찾을 수 없습니다." });
    }
    res.json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("Request error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다. open.kakao.com/me/b0t 으로 문의 넣어주시면 신속하게 처리하겠습니다." });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => console.log("Scoreboard listening on port " + PORT));
  })
  .catch(err => {
    console.error("Database initialization failed:", err.message);
    process.exit(1);
  });
