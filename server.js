// server.js
import express from "express";
import fetch from "node-fetch";
import { spawn } from "child_process";
import process from "process";

const app = express();
const YT_API_KEY = process.env.YT_API_KEY || "AIzaSyBvLcbqTDXOrPG2DIEFj9W9ULSLw4SGouk";
const PORT = process.env.PORT || 3000;
const CREATOR = "Hecker"; // Creator / Ersteller

// Fehlercodes
const ERR = {
  YT_QUOTA: { code: 1001, http: 502, msg: "YouTube API quota exceeded or bad response" },
  YT_NOPLAY: { code: 1002, http: 404, msg: "Video not playable / not found" },
  PROCESS_FAIL: { code: 2001, http: 500, msg: "Transcode process failed" },
  BAD_REQUEST: { code: 3001, http: 400, msg: "Bad request / missing params" },
  INTERNAL: { code: 5001, http: 500, msg: "Internal server error" }
};

// ---- Update Log (hier editierbar) ----
const UPDATE_LOG = [
  { version: "1.2.0", date: "2025-10-22", notes: "Thumbnails + vollständige Videometadaten, Update-Log sichtbar in App, Creator-Label 'Hecker' hinzugefügt." },
  { version: "1.1.0", date: "2025-10-18", notes: "Live streaming mit yt-dlp + ffmpeg; DSi-friendly output." },
  { version: "1.0.0", date: "2025-10-10", notes: "Initialer Proxy: Search, Stream, Stream-Info." }
];

// Health + meta
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "youtube-dsi-proxy", version: "1.2.0", creator: CREATOR });
});

// Update-Log Endpoint (JSON oder plain text)
app.get("/api/update-log", (req, res) => {
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ updateLog: UPDATE_LOG });
  }
  res.type("text/plain");
  const lines = UPDATE_LOG.map(u => `${u.version}|${u.date}|${u.notes}`);
  res.send(lines.join("\n"));
});

// Search endpoint (returns plain lines for DSi, JSON if requested)
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(ERR.BAD_REQUEST.http).json({ error: ERR.BAD_REQUEST });

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(ERR.YT_QUOTA.http).json({ error: ERR.YT_QUOTA });

    const data = await r.json();
    const items = (data.items || []).map(it => ({
      id: it.id.videoId,
      title: it.snippet.title.replace(/\n/g, " "),
      channelTitle: it.snippet.channelTitle,
      thumbnails: it.snippet.thumbnails || {}
    }));

    if ((req.headers.accept || "").includes("application/json")) {
      return res.json({ creator: CREATOR, results: items });
    }

    // plain text: id|title|thumb_default|channel
    res.type("text/plain");
    const lines = items.map(it => {
      const thumb = it.thumbnails.default?.url || "";
      return `${it.id}|${it.title}|${thumb}|${it.channelTitle}`;
    });
    res.send(lines.join("\n"));
  } catch (e) {
    console.error("search error", e);
    res.status(ERR.INTERNAL.http).json({ error: ERR.INTERNAL, details: String(e) });
  }
});

// Stream-info: erweitertes Metadaten-Objekt
app.get("/api/stream-info/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(ERR.BAD_REQUEST.http).json({ error: ERR.BAD_REQUEST });

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(id)}&key=${YT_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(ERR.YT_QUOTA.http).json({ error: ERR.YT_QUOTA });
    const data = await r.json();
    if (!data.items || data.items.length === 0) return res.status(ERR.YT_NOPLAY.http).json({ error: ERR.YT_NOPLAY });

    const it = data.items[0];
    const snippet = it.snippet || {};
    const content = it.contentDetails || {};
    const stats = it.statistics || {};

    res.json({
      creator: CREATOR,
      id,
      title: snippet.title,
      description: snippet.description,
      channelTitle: snippet.channelTitle,
      publishedAt: snippet.publishedAt,
      thumbnails: snippet.thumbnails || {},
      duration: content.duration, // ISO8601, z.B. PT3M15S
      viewCount: stats.viewCount || null,
      likeCount: stats.likeCount || null,
      stream_endpoint: `/api/stream/${id}`
    });
  } catch (e) {
    console.error("stream-info error", e);
    res.status(ERR.INTERNAL.http).json({ error: ERR.INTERNAL, details: String(e) });
  }
});

// Stream endpoint (same pipeline wie vorher)
app.get("/api/stream/:id", (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(ERR.BAD_REQUEST.http).json({ error: ERR.BAD_REQUEST });

  res.setHeader("Content-Type", "video/3gpp");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const ytUrl = `https://www.youtube.com/watch?v=${id}`;
    const ytdlp = spawn("yt-dlp", ["-f", "best", "-g", ytUrl]);

    let directUrl = "";
    ytdlp.stdout.on("data", chunk => directUrl += chunk.toString());
    ytdlp.stderr.on("data", chunk => console.error("yt-dlp:", chunk.toString()));

    ytdlp.on("close", code => {
      directUrl = directUrl.trim();
      if (!directUrl) {
        console.error("no direct url from yt-dlp, code: ", code);
        return res.status(ERR.YT_NOPLAY.http).json({ error: ERR.YT_NOPLAY });
      }
      const ffmpegArgs = [
        "-i", directUrl,
        "-vf", "scale=320:240",
        "-r", "20",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-b:v", "250k",
        "-c:a", "aac",
        "-b:a", "64k",
        "-f", "mp4",
        "pipe:1"
      ];
      const ff = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

      ff.stderr.on("data", d => console.error("ffmpeg:", d.toString()));
      ff.stdout.pipe(res);

      ff.on("close", (c) => {
        console.log("ffmpeg closed", c);
        try { res.end(); } catch(e) {}
      });

      ff.on("error", (e) => {
        console.error("ffmpeg error", e);
        try { res.status(ERR.PROCESS_FAIL.http).json({ error: ERR.PROCESS_FAIL, details: String(e) }); } catch(_) {}
      });
    });

    ytdlp.on("error", (e) => {
      console.error("yt-dlp spawn error", e);
      res.status(ERR.INTERNAL.http).json({ error: ERR.INTERNAL, details: String(e) });
    });
  } catch (e) {
    console.error("stream error", e);
    res.status(ERR.INTERNAL.http).json({ error: ERR.INTERNAL, details: String(e) });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: { code: 4040, http: 404, msg: "Not found" } });
});

app.listen(PORT, () => console.log(`youtube-dsi-proxy listening on ${PORT}`));
