import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;
const TMPDIR = process.env.TMPDIR || "/tmp/ytdsi";

if (!fs.existsSync(TMPDIR)) fs.mkdirSync(TMPDIR, { recursive: true });

const YT_API_KEY = process.env.YT_API_KEY || "AIzaSyBvLcbqTDXOrPG2DIEFj9W9ULSLw4SGouk";

// Health-Check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "youtube-dsi-proxy", creator: "Hecker", version: "1.0.0" });
});

// Suche / Video Infos
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing query" });

    const url = `https://www.googleapis.com/youtube/v3/search?key=${YT_API_KEY}&part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=10`;
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// Stream Endpoint: transcode → temporäre Datei → serve mit Range
app.get("/api/stream/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const format = (req.query.format || "mp4").toLowerCase();
    const outFile = path.join(TMPDIR, `${id}.${format}`);

    if (fs.existsSync(outFile)) return streamFileWithRange(req, res, outFile, format);

    const ytUrl = `https://www.youtube.com/watch?v=${id}`;
    const ytdlp = spawn("yt-dlp", ["-f", "best", "-g", ytUrl]);
    let direct = "";
    ytdlp.stdout.on("data", c => direct += c.toString());
    ytdlp.on("close", () => {
      direct = direct.trim();
      if (!direct) return res.status(404).json({ error: "No direct URL from yt-dlp" });

      const ffargs = (format === "3gp") ? [
        "-i", direct,
        "-vf", "scale=320:240",
        "-r", "20",
        "-c:v", "h263",
        "-b:v", "250k",
        "-c:a", "aac",
        "-b:a", "64k",
        outFile
      ] : [
        "-i", direct,
        "-vf", "scale=320:240",
        "-r", "20",
        "-c:v", "libx264",
        "-profile:v", "baseline",
        "-level", "3.0",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-b:v", "300k",
        "-c:a", "aac",
        "-b:a", "64k",
        "-movflags", "+faststart",
        outFile
      ];

      const ff = spawn("ffmpeg", ffargs);
      ff.stderr.on("data", d => console.error("ffmpeg:", d.toString()));
      ff.on("close", () => {
        if (!fs.existsSync(outFile)) return res.status(500).json({ error: "Transcode failed" });
        streamFileWithRange(req, res, outFile, format);
      });
    });

    ytdlp.on("error", e => {
      console.error("yt-dlp error", e);
      res.status(500).json({ error: "yt-dlp spawn error" });
    });

  } catch (e) {
    console.error("stream error", e);
    res.status(500).json({ error: "internal" });
  }
});

function streamFileWithRange(req, res, filePath, format) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = (format === "3gp") ? "video/3gpp" : "video/mp4";

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
