const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = path.join(__dirname, "public");
const RUNTIME_DIR = path.join(__dirname, "runtime");
const jobs = new Map();

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function getJobDirById(id) {
  return path.join(RUNTIME_DIR, id);
}

function getJobStatePathById(id) {
  return path.join(getJobDirById(id), "job.json");
}

function serializeJob(job) {
  return {
    id: job.id,
    channelUrl: job.channelUrl,
    channelTitle: job.channelTitle,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    total: job.total,
    downloaded: job.downloaded,
    failed: job.failed,
    failures: Array.isArray(job.failures) ? job.failures : [],
    error: job.error || "",
    zipPath: job.zipPath || "",
    filename: job.filename || "",
    tempDir: job.tempDir,
    updatedAt: job.updatedAt || Date.now()
  };
}

async function saveJobState(job) {
  const statePath = getJobStatePathById(job.id);
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, JSON.stringify(serializeJob(job), null, 2), "utf8");
}

async function loadJobState(id) {
  try {
    const statePath = getJobStatePathById(id);
    const raw = await fs.promises.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveJob(id) {
  const inMemory = jobs.get(id);
  if (inMemory) return inMemory;
  const fromDisk = await loadJobState(id);
  if (!fromDisk) return null;
  jobs.set(id, fromDisk);
  return fromDisk;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(createHttpError(413, "Payload too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function findExecutableInPath(binaryName) {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const probe = spawnSync(cmd, [binaryName], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    if (probe.status !== 0) return "";
    return String(probe.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

function findPythonExecutable() {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const item of candidates) {
    const found = findExecutableInPath(item);
    if (found) return found;
  }
  return "";
}

function findYtDlpCommand() {
  const direct = findExecutableInPath("yt-dlp");
  if (direct) {
    const probe = spawnSync(direct, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    if (probe.status === 0) return { executable: direct, prefixArgs: [] };
  }

  const python = findPythonExecutable();
  if (!python) return null;
  const probe = spawnSync(python, ["-m", "yt_dlp", "--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  if (probe.status === 0) return { executable: python, prefixArgs: ["-m", "yt_dlp"] };
  return null;
}

const ytDlpCommand = findYtDlpCommand();

function createJobId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeBaseName(input, fallback = `tiktok_${Date.now()}`) {
  const cleaned = String(input || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
  return cleaned || fallback;
}

function normalizeTikTokChannelUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw createHttpError(400, "Vui long nhap link kenh TikTok.");

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw createHttpError(400, "Link TikTok khong hop le.");
  }

  if (!parsed.hostname.toLowerCase().endsWith("tiktok.com")) {
    throw createHttpError(400, "Link nay khong phai TikTok.");
  }

  const parts = String(parsed.pathname || "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length || !parts[0].startsWith("@")) {
    throw createHttpError(400, "Hay nhap link kenh dang @username.");
  }
  if (parts[1] && parts[1].toLowerCase() === "video") {
    throw createHttpError(400, "Day la link video, khong phai link kenh.");
  }

  return `https://www.tiktok.com/${parts[0]}`;
}

function pickJsonFromStdout(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // ignore
    }
  }
  return null;
}

function runCommandCapture(executable, args, tempDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      windowsHide: true,
      env: {
        ...process.env,
        TMP: tempDir,
        TEMP: tempDir
      }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(createHttpError(502, stderr.trim() || "yt-dlp failed."));
    });
  });
}

async function listChannelEntries(channelUrl, tempDir) {
  if (!ytDlpCommand) throw createHttpError(500, "Khong tim thay yt-dlp tren may.");
  const args = [...ytDlpCommand.prefixArgs, "--flat-playlist", "--dump-single-json", "--no-warnings", channelUrl];
  const { stdout } = await runCommandCapture(ytDlpCommand.executable, args, tempDir);
  const info = pickJsonFromStdout(stdout);
  const entries = Array.isArray(info?.entries) ? info.entries : [];

  const mapped = entries.map((entry, index) => {
    const id = String(entry?.id || "").trim();
    const title = String(entry?.title || "").trim();
    const url = id ? `${channelUrl}/video/${id}` : String(entry?.url || entry?.webpage_url || "").trim();
    if (!url) return null;
    return { index: index + 1, id: id || `video_${index + 1}`, title, url };
  }).filter(Boolean);

  if (!mapped.length) throw createHttpError(404, "Khong tim thay video nao trong kenh.");
  return {
    title: String(info?.uploader || info?.channel || info?.title || "").trim(),
    entries: mapped
  };
}

function downloadSingleVideo(pageUrl, outputPath, tempDir) {
  return new Promise((resolve, reject) => {
    const args = [
      ...ytDlpCommand.prefixArgs,
      "--no-warnings",
      "--no-playlist",
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", outputPath,
      pageUrl
    ];
    const proc = spawn(ytDlpCommand.executable, args, {
      windowsHide: true,
      env: {
        ...process.env,
        TMP: tempDir,
        TEMP: tempDir
      }
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(createHttpError(502, stderr.trim() || "Tai video that bai."));
    });
  });
}

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

function createZip(sourceDir, outputZip) {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const command = `$ErrorActionPreference='Stop'; Compress-Archive -Path '${escapePs(path.join(sourceDir, "*"))}' -DestinationPath '${escapePs(outputZip)}' -Force`;
      const proc = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk || "");
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(createHttpError(500, stderr.trim() || "Nen zip that bai."));
      });
      return;
    }

    const zipExec = findExecutableInPath("zip");
    if (!zipExec) {
      reject(createHttpError(500, "Khong tim thay cong cu zip."));
      return;
    }
    const proc = spawn(zipExec, ["-r", outputZip, "."], { cwd: sourceDir, windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(createHttpError(500, stderr.trim() || "Nen zip that bai."));
    });
  });
}

function setJobProgress(job, progress, stage) {
  job.progress = Math.max(0, Math.min(100, Math.floor(progress)));
  job.stage = stage;
  job.updatedAt = Date.now();
}

async function runJob(job) {
  try {
    setJobProgress(job, 5, "Dang lay danh sach video");
    await saveJobState(job);
    const playlist = await listChannelEntries(job.channelUrl, job.tempDir);
    job.channelTitle = playlist.title;
    job.total = playlist.entries.length;
    await saveJobState(job);

    const videosDir = path.join(job.tempDir, "videos");
    fs.mkdirSync(videosDir, { recursive: true });

    for (let index = 0; index < playlist.entries.length; index += 1) {
      const item = playlist.entries[index];
      setJobProgress(job, 10 + Math.floor((index / Math.max(1, job.total)) * 75), `Dang tai video ${index + 1}/${job.total}`);
      const filename = `${String(index + 1).padStart(4, "0")}_${sanitizeBaseName(item.title || item.id)}.mp4`;
      const outputPath = path.join(videosDir, filename);
      try {
        await downloadSingleVideo(item.url, outputPath, job.tempDir);
        job.downloaded += 1;
      } catch (error) {
        job.failed += 1;
        job.failures.push(`#${index + 1} | ${item.url} | ${error.message || "Tai that bai."}`);
      }
      await saveJobState(job);
    }

    if (job.downloaded === 0) throw createHttpError(502, "Khong tai duoc video nao.");

    if (job.failures.length) {
      fs.writeFileSync(path.join(videosDir, "_download_report.txt"), job.failures.join(os.EOL), "utf8");
    }

    setJobProgress(job, 92, "Dang nen zip");
    const zipName = `${sanitizeBaseName(job.channelTitle || "tiktok_channel")}.zip`;
    const zipPath = path.join(job.tempDir, zipName);
    await createZip(videosDir, zipPath);

    job.filename = zipName;
    job.zipPath = zipPath;
    job.status = "done";
    setJobProgress(job, 100, "Hoan tat");
    await saveJobState(job);
  } catch (error) {
    job.status = "error";
    job.error = error.message || "Xu ly that bai.";
    job.updatedAt = Date.now();
    await saveJobState(job).catch(() => {});
  }
}

function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Internal server error");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`[req] ${req.method} ${req.url}`);

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/healthz") {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end();
      return;
    }
    sendJson(res, 200, {
      ok: true,
      yt_dlp: !!ytDlpCommand,
      uptime: process.uptime()
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/start") {
    try {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const channelUrl = normalizeTikTokChannelUrl(body.url);
      const id = createJobId();
      const tempDir = getJobDirById(id);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const job = {
        id,
        channelUrl,
        channelTitle: "",
        status: "processing",
        stage: "Dang khoi tao",
        progress: 0,
        total: 0,
        downloaded: 0,
        failed: 0,
        failures: [],
        error: "",
        zipPath: "",
        filename: "",
        tempDir,
        updatedAt: Date.now()
      };
      jobs.set(id, job);
      await saveJobState(job);
      runJob(job);
      sendJson(res, 200, { id, status: job.status });
    } catch (error) {
      sendJson(res, Number(error?.statusCode) || 500, { error: error.message || "Khong tao duoc job." });
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/status/")) {
    const id = decodeURIComponent(req.url.slice("/api/status/".length));
    const job = await resolveJob(id);
    if (!job) {
      sendJson(res, 404, { error: "Khong tim thay job." });
      return;
    }
    sendJson(res, 200, {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      total: job.total,
      downloaded: job.downloaded,
      failed: job.failed,
      error: job.error,
      channelTitle: job.channelTitle,
      downloadUrl: job.status === "done" ? `/api/file/${encodeURIComponent(job.id)}` : ""
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/file/")) {
    const id = decodeURIComponent(req.url.slice("/api/file/".length));
    const job = await resolveJob(id);
    if (!job) {
      sendJson(res, 404, { error: "Khong tim thay job." });
      return;
    }
    if (job.status !== "done" || !job.zipPath) {
      sendJson(res, 409, { error: "File chua san sang." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${job.filename}"`,
      "Cache-Control": "no-store"
    });
    const stream = fs.createReadStream(job.zipPath);
    stream.on("error", () => {
      if (!res.headersSent) sendJson(res, 500, { error: "Khong doc duoc file zip." });
      else res.destroy();
    });
    stream.on("close", async () => {
      await fs.promises.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(job.id);
    });
    stream.pipe(res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TikTok app running at http://localhost:${PORT}`);
  console.log(`yt-dlp: ${ytDlpCommand ? "found" : "not found"}`);
});
