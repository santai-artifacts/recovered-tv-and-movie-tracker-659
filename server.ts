import Database from "bun:sqlite";
import { mkdirSync } from "fs";

// --- Database ---------------------------------------------------------------
const dbPath = process.env.DATABASE_URL || "./data/app.db";
try {
  mkdirSync(dbPath.substring(0, dbPath.lastIndexOf("/")), { recursive: true });
} catch {}

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS shows (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    image      TEXT,
    premiered  TEXT,
    ended      TEXT,
    status     TEXT,
    network    TEXT,
    genres     TEXT,
    summary    TEXT,
    added_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id       INTEGER PRIMARY KEY,
    show_id  INTEGER NOT NULL,
    season   INTEGER NOT NULL,
    number   INTEGER,
    name     TEXT,
    airdate  TEXT,
    runtime  INTEGER,
    summary  TEXT,
    watched  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ep_show ON episodes(show_id);
  CREATE TABLE IF NOT EXISTS movies (
    id       INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    poster   TEXT,
    year     TEXT,
    overview TEXT,
    genres   TEXT,
    runtime  INTEGER,
    watched  INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
  );
`);

// --- Helpers ----------------------------------------------------------------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const stripHtml = (s: string | null | undefined) =>
  (s || "").replace(/<[^>]*>/g, "").trim();

function showsWithProgress() {
  const shows = db.query("SELECT * FROM shows ORDER BY added_at DESC").all() as any[];
  const progress = db
    .query(
      `SELECT show_id, COUNT(*) AS total, SUM(watched) AS watched
       FROM episodes GROUP BY show_id`
    )
    .all() as any[];
  const byId: Record<number, { total: number; watched: number }> = {};
  for (const p of progress) byId[p.show_id] = { total: p.total, watched: p.watched || 0 };
  return shows.map((s) => ({
    ...s,
    genres: s.genres ? JSON.parse(s.genres) : [],
    total: byId[s.id]?.total || 0,
    watched: byId[s.id]?.watched || 0,
  }));
}

// --- TVMaze -----------------------------------------------------------------
async function tvmazeSearch(q: string) {
  const r = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
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

async function importShow(showId: number) {
  const existing = db.query("SELECT id FROM shows WHERE id = ?").get(showId);
  if (existing) return { alreadyAdded: true };

  const [showRes, epsRes] = await Promise.all([
    fetch(`https://api.tvmaze.com/shows/${showId}`),
    fetch(`https://api.tvmaze.com/shows/${showId}/episodes`),
  ]);
  if (!showRes.ok) throw new Error("Show not found");
  const show = (await showRes.json()) as any;
  const eps = (await epsRes.json()) as any[];

  db.query(
    `INSERT INTO shows (id, name, image, premiered, ended, status, network, genres, summary, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    show.id, show.name, show.image?.medium || null,
    show.premiered || null, show.ended || null, show.status || null,
    show.network?.name || show.webChannel?.name || null,
    JSON.stringify(show.genres || []), stripHtml(show.summary), Date.now()
  );

  const insertEp = db.query(
    `INSERT OR REPLACE INTO episodes (id, show_id, season, number, name, airdate, runtime, summary, watched)
     VALUES (?,?,?,?,?,?,?,?,COALESCE((SELECT watched FROM episodes WHERE id = ?),0))`
  );
  const tx = db.transaction((list: any[]) => {
    for (const e of list) {
      insertEp.run(e.id, show.id, e.season ?? 0, e.number ?? null, e.name || null,
        e.airdate || null, e.runtime || null, stripHtml(e.summary), e.id);
    }
  });
  tx(eps);
  return { alreadyAdded: false, episodeCount: eps.length };
}

function showDetail(showId: number) {
  const show = db.query("SELECT * FROM shows WHERE id = ?").get(showId) as any;
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

// --- TMDB (movies) ----------------------------------------------------------
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

async function importMovie(movieId: number) {
  const existing = db.query("SELECT id FROM movies WHERE id = ?").get(movieId);
  if (existing) return { alreadyAdded: true };
  if (!TMDB_KEY) throw new Error("TMDB_API_KEY secret is not configured");
  const r = await fetch(
    `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}&language=en-US`
  );
  if (!r.ok) throw new Error("Movie not found on TMDB");
  const m = (await r.json()) as any;
  db.query(
    `INSERT INTO movies (id, title, poster, year, overview, genres, runtime, watched, added_at)
     VALUES (?,?,?,?,?,?,?,0,?)`
  ).run(
    m.id, m.title,
    m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
    m.release_date ? m.release_date.slice(0, 4) : null,
    (m.overview || "").slice(0, 500),
    JSON.stringify((m.genres || []).map((g: any) => g.name)),
    m.runtime || null,
    Date.now()
  );
  return { alreadyAdded: false };
}

function moviesList() {
  const movies = db.query("SELECT * FROM movies ORDER BY added_at DESC").all() as any[];
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
      // TV Shows API
      if (pathname === "/api/search" && req.method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json([]);
        return json(await tvmazeSearch(q));
      }

      if (pathname === "/api/shows" && req.method === "GET") {
        return json(showsWithProgress());
      }

      if (pathname === "/api/shows" && req.method === "POST") {
        const body = (await req.json()) as { id: number };
        if (!body?.id) return json({ error: "id required" }, 400);
        return json(await importShow(body.id));
      }

      const showMatch = pathname.match(/^\/api\/shows\/(\d+)$/);
      if (showMatch) {
        const id = Number(showMatch[1]);
        if (req.method === "GET") {
          const detail = showDetail(id);
          return detail ? json(detail) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE") {
          db.query("DELETE FROM episodes WHERE show_id = ?").run(id);
          db.query("DELETE FROM shows WHERE id = ?").run(id);
          return json({ ok: true });
        }
      }

      const epMatch = pathname.match(/^\/api\/episodes\/(\d+)\/toggle$/);
      if (epMatch && req.method === "POST") {
        const id = Number(epMatch[1]);
        const body = (await req.json().catch(() => ({}))) as { watched?: boolean };
        const val = body.watched === undefined ? null : body.watched ? 1 : 0;
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
        db.query("UPDATE episodes SET watched = ? WHERE show_id = ? AND season = ?").run(
          body.watched ? 1 : 0, showId, season
        );
        return json({ ok: true });
      }

      // Movies API
      if (pathname === "/api/movies/search" && req.method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json([]);
        return json(await tmdbSearch(q));
      }

      if (pathname === "/api/movies" && req.method === "GET") {
        return json(moviesList());
      }

      if (pathname === "/api/movies" && req.method === "POST") {
        const body = (await req.json()) as { id: number };
        if (!body?.id) return json({ error: "id required" }, 400);
        return json(await importMovie(body.id));
      }

      const movieMatch = pathname.match(/^\/api\/movies\/(\d+)$/);
      if (movieMatch) {
        const id = Number(movieMatch[1]);
        if (req.method === "DELETE") {
          db.query("DELETE FROM movies WHERE id = ?").run(id);
          return json({ ok: true });
        }
      }

      const movieToggle = pathname.match(/^\/api\/movies\/(\d+)\/toggle$/);
      if (movieToggle && req.method === "POST") {
        const id = Number(movieToggle[1]);
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
