
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "scores.json");

if (
  !process.env.DATABASE_URL ||
  !process.env.ADMIN_USERNAME ||
  !process.env.ADMIN_PASSWORD ||
  !process.env.SESSION_SECRET
) {
  console.error("필수 환경변수를 설정해 주세요.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on("error", err => {
  console.error("PostgreSQL 오류:", err.message);
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
  if (req.session?.isAdmin === true) return next();
  res.status(401).json({ error: "로그인이 필요합니다." });
}

function cleanText(value, max = 80) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function validScore(value) {
  return Number.isInteger(value) &&
    Math.abs(value) <= 1000000;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      rank TEXT NOT NULL,
      role TEXT NOT NULL,
      score INTEGER NOT NULL
        CHECK (score BETWEEN -1000000 AND 1000000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // 기존 DB에 name 열이 없으면 추가합니다.
  await pool.query(`
    ALTER TABLE scores
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''
  `);

  // 기존 JSON 데이터가 있으면 DB로 옮깁니다.
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldScores = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );

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
              `INSERT INTO scores
                (id, name, rank, role, score)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO NOTHING`,
              [
                item.id,
                cleanText(item.name),
                item.rank.slice(0, 80),
                item.role.slice(0, 80),
                item.score
              ]
            );
          }
        }
      }
    } catch (err) {
      console.warn("JSON 데이터 이전 오류:", err.message);
    }
  }

  console.log("데이터베이스 준비 완료");
}

async function getScores() {
  const result = await pool.query(`
    SELECT id, name, rank, role, score
    FROM scores
    ORDER BY created_at ASC, id ASC
  `);

  return result.rows;
}

app.post("/api/login", (req, res, next) => {
  const username = cleanText(req.body?.username, 120);
  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (
    username !== process.env.ADMIN_USERNAME ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "아이디 또는 비밀번호가 올바르지 않습니다."
    });
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
  res.json({
    loggedIn: req.session?.isAdmin === true
  });
});

app.get("/api/scores", async (req, res, next) => {
  try {
    res.json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.post("/api/scores", requireAdmin, async (req, res, next) => {
  const name = cleanText(req.body?.name);
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);

  if (!name || !rank || !role || !validScore(score)) {
    return res.status(400).json({
      error: "이름, 계급, 보직과 정수 점수를 입력해 주세요."
    });
  }

  const id =
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8);

  try {
    await pool.query(
      `INSERT INTO scores (id, name, rank, role, score)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, name, rank, role, score]
    );

    res.status(201).json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.patch("/api/scores/:id", requireAdmin, async (req, res, next) => {
  const name = cleanText(req.body?.name);
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);

  if (!name || !rank || !role || !validScore(score)) {
    return res.status(400).json({
      error: "이름, 계급, 보직과 점수를 확인해 주세요."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE scores
       SET name = $1, rank = $2, role = $3, score = $4
       WHERE id = $5`,
      [name, rank, role, score, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "항목을 찾을 수 없습니다."
      });
    }

    res.json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.delete("/api/scores/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      "DELETE FROM scores WHERE id = $1",
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "항목을 찾을 수 없습니다."
      });
    }

    res.json(await getScores());
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("요청 오류:", err.message);

  if (res.headersSent) return next(err);

  res.status(500).json({
    error: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
  });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Scoreboard listening on port " + PORT);
    });
  })
  .catch(err => {
    console.error("데이터베이스 초기화 실패:", err.message);
    process.exit(1);
  });
