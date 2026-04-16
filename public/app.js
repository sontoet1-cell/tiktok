const form = document.getElementById("form");
const urlInput = document.getElementById("url");
const submitBtn = document.getElementById("submit");
const pasteBtn = document.getElementById("paste");
const statusEl = document.getElementById("status");
const fillEl = document.getElementById("fill");
const totalEl = document.getElementById("total");
const downloadedEl = document.getElementById("downloaded");
const failedEl = document.getElementById("failed");
const progressEl = document.getElementById("progress");
const downloadEl = document.getElementById("download");

let currentJobId = "";
let pollHandle = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#f87171" : "#e2e8f0";
}

function setProgress(value) {
  const safe = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
  fillEl.style.width = `${safe}%`;
  progressEl.textContent = `${safe}%`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

async function pollJob() {
  if (!currentJobId) return;
  try {
    const data = await requestJson(`/api/status/${encodeURIComponent(currentJobId)}`);
    totalEl.textContent = String(data.total || 0);
    downloadedEl.textContent = String(data.downloaded || 0);
    failedEl.textContent = String(data.failed || 0);
    setProgress(data.progress || 0);
    setStatus(data.stage || "Dang xu ly...");

    if (data.status === "done" && data.downloadUrl) {
      downloadEl.href = data.downloadUrl;
      downloadEl.classList.remove("hidden");
      submitBtn.disabled = false;
      setStatus("Hoan tat. Bam de tai file ZIP.");
      return;
    }

    if (data.status === "error") {
      submitBtn.disabled = false;
      setStatus(data.error || "Job that bai.", true);
      return;
    }

    pollHandle = setTimeout(pollJob, 1500);
  } catch (error) {
    submitBtn.disabled = false;
    setStatus(error.message || "Khong doc duoc tien trinh.", true);
  }
}

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
  } catch {
    setStatus("Khong doc duoc clipboard.", true);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pollHandle) clearTimeout(pollHandle);
  downloadEl.classList.add("hidden");
  submitBtn.disabled = true;
  totalEl.textContent = "0";
  downloadedEl.textContent = "0";
  failedEl.textContent = "0";
  setProgress(2);
  setStatus("Dang tao job...");

  try {
    const data = await requestJson("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value.trim() })
    });
    currentJobId = data.id;
    pollJob();
  } catch (error) {
    submitBtn.disabled = false;
    setStatus(error.message || "Khong tao duoc job.", true);
  }
});
