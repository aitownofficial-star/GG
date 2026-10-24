const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "scores.json");

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error("Set ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET environment variables.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(session({
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

function readScores() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function writeScores(scores) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  return res.status(401).json({ error: "로그인이 필요합니다." });
}
function cleanText(value, max = 80) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
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
    res.json({ ok: true });
  });
});
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.clearCookie("scoreboard.sid").json({ ok: true }));
});
app.get("/api/me", (req, res) => res.json({ loggedIn: req.session?.isAdmin === true }));
app.get("/api/scores", (req, res) => res.json(readScores()));

app.post("/api/scores", requireAdmin, (req, res) => {
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);
  if (!rank || !role || !Number.isFinite(score) || !Number.isInteger(score) || Math.abs(score) > 1000000) {
    return res.status(400).json({ error: "계급, 보직, 정수 점수를 올바르게 입력해 주세요." });
  }
  const scores = readScores();
  scores.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    rank, role, score
  });
  writeScores(scores);
  res.status(201).json(scores);
});
app.patch("/api/scores/:id", requireAdmin, (req, res) => {
  const scores = readScores();
  const item = scores.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: "항목을 찾을 수 없습니다." });
  const rank = cleanText(req.body?.rank);
  const role = cleanText(req.body?.role);
  const score = Number(req.body?.score);
  if (!rank || !role || !Number.isFinite(score) || !Number.isInteger(score) || Math.abs(score) > 1000000) {
    return res.status(400).json({ error: "입력값을 확인해 주세요." });
  }
  Object.assign(item, { rank, role, score });
  writeScores(scores);
  res.json(scores);
});
app.delete("/api/scores/:id", requireAdmin, (req, res) => {
  const scores = readScores();
  const next = scores.filter(x => x.id !== req.params.id);
  if (next.length === scores.length) return res.status(404).json({ error: "항목을 찾을 수 없습니다." });
  writeScores(next);
  res.json(next);
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log("Scoreboard listening on port " + PORT));
