import Database from "bun:sqlite";
import { mkdirSync } from "fs";

// --- Database ---------------------------------------------------------------
const dbPath = process.env.DATABASE_URL || "./data/app.db";
try {
  mkdirSync(dbPath.substring(0, dbPath.lastIndexOf("/")), { recursive: true });
} catch {}

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// One-time migration: if users table doesn't exist yet, drop the old single-user tables
const hasUsers = db
  .query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
  .get();
if (!hasUsers) {
  db.exec(`DROP TABLE IF EXISTS episodes; DROP TABLE IF EXISTS shows; DROP TABLE IF EXISTS movies;`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS shows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tvmaze_id  INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    image      TEXT,
    premiered  TEXT,
    ended      TEXT,
    status     TEXT,
    network    TEXT,
    genres     TEXT,
    summary    TEXT,
    added_at   INTEGER NOT NULL,
    UNIQUE(tvmaze_id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tvmaze_id  INTEGER NOT NULL,
    show_id    INTEGER NOT NULL,
    season     INTEGER NOT NULL,
    number     INTEGER,
    name       TEXT,
    airdate    TEXT,
    runtime    INTEGER,
    summary    TEXT,
    watched    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tvmaze_id, show_id),
    FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ep_show ON episodes(show_id);
  CREATE TABLE IF NOT EXISTS movies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    poster     TEXT,
    year       TEXT,
    overview   TEXT,
    genres     TEXT,
    runtime    INTEGER,
    watched    INTEGER NOT NULL DEFAULT 0,
    added_at   INTEGER NOT NULL,
    UNIQUE(tmdb_id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// --- Helpers ----------------------------------------------------------------
const json = (data: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

const stripHtml = (s: string | null | undefined) =>
  (s || "").replace(/<[^>]*>/g, "").trim();

// --- Auth -------------------------------------------------------------------
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookieHeader(token: string): string {
  return `session_token=${token}; HttpOnly; SameSite=Lax; Max-Age=2592000; Path=/`;
}

function clearCookieHeader(): string {
  return `session_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;
}

function createSession(userId: number): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    Date.now() + SESSION_TTL
  );
  return token;
}

async function getSessionUser(
  req: Request
): Promise<{ id: number; email: string } | null> {
  const token = getCookie(req, "session_token");
  if (!token) return null;
  return (db
    .query(
      `SELECT u.id, u.email FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, Date.now()) as { id: number; email: string } | null);
}

// --- Auth routes ------------------------------------------------------------
async function handleRegister(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;
  const email = (body?.email || "").trim().toLowerCase();
  const password = body?.password || "";

  if (!email || !email.includes("@"))
    return json({ error: "Valid email required" }, 400);
  if (password.length < 6)
    return json({ error: "Password must be at least 6 characters" }, 400);

  const existing = db.query("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return json({ error: "Email already registered" }, 409);

  const password_hash = await Bun.password.hash(password);
  const result = db
    .query("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
    .run(email, password_hash, Date.now());
  const userId = Number(result.lastInsertRowid);
  const token = createSession(userId);

  return new Response(JSON.stringify({ id: userId, email }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader(token),
    },
  });
}

async function handleLogin(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;
  const email = (body?.email || "").trim().toLowerCase();
  const password = body?.password || "";

  const user = db
    .query("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email) as { id: number; email: string; password_hash: string } | null;

  if (!user || !(await Bun.password.verify(password, user.password_hash)))
    return json({ error: "Invalid email or password" }, 401);

  const token = createSession(user.id);
  return new Response(JSON.stringify({ id: user.id, email: user.email }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader(token),
    },
  });
}

async function handleLogout(req: Request): Promise<Response> {
  const token = getCookie(req, "session_token");
  if (token) db.query("DELETE FROM sessions WHERE token = ?").run(token);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearCookieHeader(),
    },
  });
}

// --- TV Shows data ----------------------------------------------------------
function showsWithProgress(userId: number) {
  const shows = db
    .query("SELECT * FROM shows WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId) as any[];
  const progress = db
    .query(
      `SELECT s.id AS show_id, COUNT(e.id) AS total, SUM(e.watched) AS watched
       FROM shows s JOIN episodes e ON e.show_id = s.id
       WHERE s.user_id = ? GROUP BY s.id`
    )
    .all(userId) as any[];
  const byId: Record<number, { total: number; watched: number }> = {};
  for (const p of progress)
    byId[p.show_id] = { total: p.total, watched: p.watched || 0 };
  return shows.map((s) => ({
    ...s,
    genres: s.genres ? JSON.parse(s.genres) : [],
    total: byId[s.id]?.total || 0,
    watched: byId[s.id]?.watched || 0,
  }));
}

async function tvmazeSearch(q: string) {
  const r = await fetch(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`
  );
  if (!r.ok) throw new Error("TVMaze search failed");
  const data = (await r.json()) as any[];
  return data.map((d) => ({
    id: d.show.id,
    name: d.show.name,
    premiered: d.show.premiered,
    status: d.show.status,
    network: d.show.network?.name || d.show.webChannel?.name || null,
    genres: d.show.genres || [],
    image: d.show.image?.medium || null,
    summary: stripHtml(d.show.summary).slice(0, 240),
  }));
}

async function importShow(tvmazeId: number, userId: number) {
  const existing = db
    .query("SELECT id FROM shows WHERE tvmaze_id = ? AND user_id = ?")
    .get(tvmazeId, userId);
  if (existing) return { alreadyAdded: true };

  const [showRes, epsRes] = await Promise.all([
    fetch(`https://api.tvmaze.com/shows/${tvmazeId}`),
    fetch(`https://api.tvmaze.com/shows/${tvmazeId}/episodes`),
  ]);
  if (!showRes.ok) throw new Error("Show not found");
  const show = (await showRes.json()) as any;
  const eps = (await epsRes.json()) as any[];

  const showResult = db
    .query(
      `INSERT INTO shows (tvmaze_id, user_id, name, image, premiered, ended, status, network, genres, summary, added_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      tvmazeId,
      userId,
      show.name,
      show.image?.medium || null,
      show.premiered || null,
      show.ended || null,
      show.status || null,
      show.network?.name || show.webChannel?.name || null,
      JSON.stringify(show.genres || []),
      stripHtml(show.summary),
      Date.now()
    );
  const showRowId = Number(showResult.lastInsertRowid);

  const insertEp = db.query(
    `INSERT OR REPLACE INTO episodes (tvmaze_id, show_id, season, number, name, airdate, runtime, summary, watched)
     VALUES (?,?,?,?,?,?,?,?,COALESCE((SELECT watched FROM episodes WHERE tvmaze_id = ? AND show_id = ?),0))`
  );
  const tx = db.transaction((list: any[]) => {
    for (const e of list) {
      insertEp.run(
        e.id, showRowId, e.season ?? 0, e.number ?? null,
        e.name || null, e.airdate || null, e.runtime || null,
        stripHtml(e.summary), e.id, showRowId
      );
    }
  });
  tx(eps);
  return { alreadyAdded: false, episodeCount: eps.length };
}

function showDetail(showId: number, userId: number) {
  const show = db
    .query("SELECT * FROM shows WHERE id = ? AND user_id = ?")
    .get(showId, userId) as any;
  if (!show) return null;
  const eps = db
    .query("SELECT * FROM episodes WHERE show_id = ? ORDER BY season, number")
    .all(showId) as any[];
  const seasons: Record<number, any[]> = {};
  for (const e of eps) (seasons[e.season] ||= []).push(e);
  return {
    ...show,
    genres: show.genres ? JSON.parse(show.genres) : [],
    seasons: Object.entries(seasons)
      .map(([season, episodes]) => ({ season: Number(season), episodes }))
      .sort((a, b) => a.season - b.season),
  };
}

// --- Movies data ------------------------------------------------------------
const TMDB_KEY = process.env.TMDB_API_KEY;

async function tmdbSearch(q: string) {
  if (!TMDB_KEY) throw new Error("TMDB_API_KEY secret is not configured");
  const r = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}&language=en-US`
  );
  if (!r.ok) throw new Error("TMDB search failed");
  const data = (await r.json()) as any;
  return (data.results || []).slice(0, 8).map((m: any) => ({
    id: m.id,
    title: m.title,
    year: m.release_date ? m.release_date.slice(0, 4) : null,
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
    overview: (m.overview || "").slice(0, 200),
  }));
}

async function importMovie(tmdbId: number, userId: number) {
  const existing = db
    .query("SELECT id FROM movies WHERE tmdb_id = ? AND user_id = ?")
    .get(tmdbId, userId);
  if (existing) return { alreadyAdded: true };
  if (!TMDB_KEY) throw new Error("TMDB_API_KEY secret is not configured");
  const r = await fetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`
  );
  if (!r.ok) throw new Error("Movie not found on TMDB");
  const m = (await r.json()) as any;
  db.query(
    `INSERT INTO movies (tmdb_id, user_id, title, poster, year, overview, genres, runtime, watched, added_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`
  ).run(
    tmdbId,
    userId,
    m.title,
    m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
    m.release_date ? m.release_date.slice(0, 4) : null,
    (m.overview || "").slice(0, 500),
    JSON.stringify((m.genres || []).map((g: any) => g.name)),
    m.runtime || null,
    Date.now()
  );
  return { alreadyAdded: false };
}

function moviesList(userId: number) {
  const movies = db
    .query("SELECT * FROM movies WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId) as any[];
  return movies.map((m: any) => ({ ...m, genres: m.genres ? JSON.parse(m.genres) : [] }));
}

// --- Static assets ----------------------------------------------------------
const publicDir = `${import.meta.dir}/public`;
async function serveStatic(pathname: string) {
  const path = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(`${publicDir}${path}`);
  if (await file.exists()) return new Response(file);
  return null;
}

// --- Router -----------------------------------------------------------------
export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      // --- Auth routes (no auth required) ---
      if (pathname === "/api/auth/register" && req.method === "POST")
        return await handleRegister(req);
      if (pathname === "/api/auth/login" && req.method === "POST")
        return await handleLogin(req);
      if (pathname === "/api/auth/logout" && req.method === "POST")
        return await handleLogout(req);
      if (pathname === "/api/auth/me" && req.method === "GET") {
        const user = await getSessionUser(req);
        return user ? json(user) : json({ error: "Unauthorized" }, 401);
      }

      // --- All routes below require a valid session ---
      const user = await getSessionUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      // TV Shows
      if (pathname === "/api/search" && req.method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json([]);
        return json(await tvmazeSearch(q));
      }

      if (pathname === "/api/shows" && req.method === "GET")
        return json(showsWithProgress(user.id));

      if (pathname === "/api/shows" && req.method === "POST") {
        const body = (await req.json()) as { id: number };
        if (!body?.id) return json({ error: "id required" }, 400);
        return json(await importShow(body.id, user.id));
      }

      const showMatch = pathname.match(/^\/api\/shows\/(\d+)$/);
      if (showMatch) {
        const id = Number(showMatch[1]);
        if (req.method === "GET") {
          const detail = showDetail(id, user.id);
          return detail ? json(detail) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE") {
          // episodes cascade via FK
          db.query("DELETE FROM shows WHERE id = ? AND user_id = ?").run(id, user.id);
          return json({ ok: true });
        }
      }

      const epMatch = pathname.match(/^\/api\/episodes\/(\d+)\/toggle$/);
      if (epMatch && req.method === "POST") {
        const id = Number(epMatch[1]);
        const body = (await req.json().catch(() => ({}))) as { watched?: boolean };
        const val = body.watched === undefined ? null : body.watched ? 1 : 0;
        // Verify episode belongs to this user via the show
        const owned = db
          .query(
            `SELECT e.id FROM episodes e
             JOIN shows s ON e.show_id = s.id
             WHERE e.id = ? AND s.user_id = ?`
          )
          .get(id, user.id);
        if (!owned) return json({ error: "not found" }, 404);
        if (val === null) {
          db.query("UPDATE episodes SET watched = 1 - watched WHERE id = ?").run(id);
        } else {
          db.query("UPDATE episodes SET watched = ? WHERE id = ?").run(val, id);
        }
        const row = db.query("SELECT watched FROM episodes WHERE id = ?").get(id) as any;
        return json({ id, watched: !!row?.watched });
      }

      const seasonMatch = pathname.match(/^\/api\/shows\/(\d+)\/season\/(\d+)\/toggle$/);
      if (seasonMatch && req.method === "POST") {
        const showId = Number(seasonMatch[1]);
        const season = Number(seasonMatch[2]);
        const body = (await req.json()) as { watched: boolean };
        // Verify show ownership
        const owned = db.query("SELECT id FROM shows WHERE id = ? AND user_id = ?").get(showId, user.id);
        if (!owned) return json({ error: "not found" }, 404);
        db.query("UPDATE episodes SET watched = ? WHERE show_id = ? AND season = ?").run(
          body.watched ? 1 : 0,
          showId,
          season
        );
        return json({ ok: true });
      }

      // Movies
      if (pathname === "/api/movies/search" && req.method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json([]);
        return json(await tmdbSearch(q));
      }

      if (pathname === "/api/movies" && req.method === "GET")
        return json(moviesList(user.id));

      if (pathname === "/api/movies" && req.method === "POST") {
        const body = (await req.json()) as { id: number };
        if (!body?.id) return json({ error: "id required" }, 400);
        return json(await importMovie(body.id, user.id));
      }

      const movieMatch = pathname.match(/^\/api\/movies\/(\d+)$/);
      if (movieMatch) {
        const id = Number(movieMatch[1]);
        if (req.method === "DELETE") {
          db.query("DELETE FROM movies WHERE id = ? AND user_id = ?").run(id, user.id);
          return json({ ok: true });
        }
      }

      const movieToggle = pathname.match(/^\/api\/movies\/(\d+)\/toggle$/);
      if (movieToggle && req.method === "POST") {
        const id = Number(movieToggle[1]);
        const owned = db.query("SELECT id FROM movies WHERE id = ? AND user_id = ?").get(id, user.id);
        if (!owned) return json({ error: "not found" }, 404);
        db.query("UPDATE movies SET watched = 1 - watched WHERE id = ?").run(id);
        const row = db.query("SELECT watched FROM movies WHERE id = ?").get(id) as any;
        return json({ id, watched: !!row?.watched });
      }

      // Static
      const stat = await serveStatic(pathname);
      if (stat) return stat;
      const index = await serveStatic("/");
      if (index) return index;
      return new Response("Not found", { status: 404 });
    } catch (err: any) {
      console.error(err);
      return json({ error: err?.message || "Server error" }, 500);
    }
  },
};
