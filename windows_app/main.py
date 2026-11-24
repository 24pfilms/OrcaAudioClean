"""OrcaAudioCleanup window app.

A small desktop window around the Booth engine (.venv\\Scripts\\booth.exe):
drop videos in, they are cleaned one at a time, then you can listen before and
after, move the Speech / Background / Music sliders and save a new mix.

Pieces:
  - Jobs: the queue, saved to <ORCA_AUDIO_HOME>\\app\\jobs.json so it survives a restart.
  - Worker: one thread that runs the engine on the next waiting file and reads
    its progress messages (one JSON line each, see docs\\app-protocol.md).
  - Server: a tiny web server on 127.0.0.1 that gives the window its page,
    the preview sounds and the original video (with seeking).
  - Api: the functions the page calls (add, remove, cancel, save mix ...).

Run: OrcaAudioCleanupApp.cmd (or pythonw windows_app\\main.py [files...]).
"""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = Path(__file__).resolve().parent / "ui"
ENGINE = ROOT / ".venv" / "Scripts" / "booth.exe"
# Models, queue and preview sounds; set ORCA_AUDIO_HOME to keep them on another drive.
HOME = Path(os.environ.get("ORCA_AUDIO_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "OrcaAudioCleanup")
DATA = HOME / "app"
STEMS = HOME / "stems"
JOBS_FILE = DATA / "jobs.json"
PORT_FILE = DATA / "port.txt"

# Orca appearance shared with OrcaWorld, OrcaRecipes and the other Orca apps:
# change the palette in one and the others follow (same file and rules as OrcaRecipes).
APPEARANCE = Path.home() / ".orca" / "appearance.json"
THEMES = ("twilight", "ocean", "ember", "scarlet", "forest", "arctic", "solar", "sakura", "obsidian")
RANGES = {"brightness": (30, 100), "saturation": (0, 200), "glass": (15, 80)}
APPEARANCE_LOCK = threading.Lock()
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/javascript", ".js")

MEDIA = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mts",
         ".wav", ".mp3", ".m4a", ".flac", ".aac"}
NO_WINDOW = 0x08000000          # CREATE_NO_WINDOW: no black console boxes

ENV = dict(os.environ, HF_HOME=str(HOME / "hf"), TORCH_HOME=str(HOME / "torch"),
           PYTHONIOENCODING="utf-8")


def clean_appearance(a) -> dict | None:
    if not isinstance(a, dict) or a.get("theme") not in THEMES:
        return None
    out = {"theme": a["theme"]}
    for k, (lo, hi) in RANGES.items():
        v = a.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
            return None
        out[k] = round(min(hi, max(lo, v)))
    return out


def read_appearance() -> dict | None:
    try:
        return clean_appearance(json.loads(APPEARANCE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def write_appearance(d) -> dict:
    a = clean_appearance(d)
    if not a:
        raise ValueError("expected { theme, brightness, saturation, glass }")
    APPEARANCE.parent.mkdir(parents=True, exist_ok=True)
    tmp = APPEARANCE.with_name(f"appearance.json.{os.getpid()}.tmp")
    with APPEARANCE_LOCK:
        tmp.write_text(json.dumps(a, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, APPEARANCE)
    return a


# -- jobs ----------------------------------------------------------------------

class Jobs:
    """The queue. Every change is saved; the page reads it with state()."""

    KEEP = ("id", "input", "name", "status", "meta", "duration", "has_video", "output",
            "wav", "stems", "mix", "music", "error", "added", "took")

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.items: list[dict] = []
        self.wake = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.running_id: str | None = None
        self.closing = False
        self.load()

    def load(self) -> None:
        try:
            self.items = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.items = []
        for j in self.items:        # a run cut off by closing the app starts again
            if j["status"] == "running":
                j["status"] = "queued"
            j.update(progress=1.0 if j["status"] == "done" else 0.0, label="", eta=None)

    def save(self) -> None:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = JOBS_FILE.with_suffix(".tmp")
        with self.lock:
            data = [{k: j.get(k) for k in self.KEEP} for j in self.items]
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, JOBS_FILE)

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            return next((j for j in self.items if j["id"] == job_id), None)

    def add(self, paths: list[str]) -> int:
        added = 0
        with self.lock:
            for p in paths:
                path = Path(p)
                if path.is_dir():
                    self.add([str(x) for x in sorted(path.iterdir())])
                    continue
                if path.suffix.lower() not in MEDIA or not path.is_file():
                    continue
                if "-enhanced" in path.stem:          # our own output: skip
                    continue
                if any(j["input"] == str(path) and j["status"] in ("queued", "running")
                       for j in self.items):
                    continue
                self.items.append({
                    "id": uuid.uuid4().hex[:10], "input": str(path), "name": path.name,
                    "status": "queued", "progress": 0.0, "label": "Waiting", "eta": None,
                    "meta": "", "duration": None, "has_video": None, "output": None,
                    "wav": None, "stems": None, "mix": None, "music": False,
                    "error": None, "added": time.time(), "took": None})
                added += 1
        if added:
            self.save()
            self.wake.set()
        return added

    def update(self, job_id: str, **fields) -> None:
        with self.lock:
            j = self.get(job_id)
            if j:
                j.update(fields)


jobs = Jobs()


def kill_tree(proc: subprocess.Popen) -> None:
    """End the engine and everything it started (by its exact process id)."""
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                   capture_output=True, creationflags=NO_WINDOW)


def remove_partials(job: dict) -> None:
    """A stopped run can leave hidden half-written files beside the input."""
    inp = Path(job["input"])
    for f in inp.parent.glob(f".{inp.stem}-enhanced.*.partial*"):
        f.unlink(missing_ok=True)


def worker() -> None:
    while True:
        with jobs.lock:
            job = next((j for j in jobs.items if j["status"] == "queued"), None)
            if job:
                job.update(status="running", label="Starting", progress=0.0, error=None)
                jobs.running_id = job["id"]
        if not job:
            jobs.wake.wait()
            jobs.wake.clear()
            continue
        jobs.save()
        run_job(job)
        jobs.running_id = None
        jobs.save()


def run_job(job: dict) -> None:
    stems_dir = STEMS / job["id"]
    if stems_dir.exists():
        shutil.rmtree(stems_dir, ignore_errors=True)
    cmd = [str(ENGINE), job["input"], "--events", "--stems-dir", str(stems_dir)]
    log_path = DATA / f"{job['id']}.log"
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log, env=ENV,
                                creationflags=NO_WINDOW)
        jobs.proc = proc
        last_error = None
        for raw in proc.stdout:
            try:
                ev = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                continue
            kind = ev.get("event")
            if kind == "start":
                jobs.update(job["id"], meta=ev.get("meta", ""), duration=ev.get("duration"),
                            has_video=ev.get("has_video"), eta=ev.get("eta"),
                            label="Starting")
            elif kind == "progress":
                jobs.update(job["id"], progress=ev.get("progress", 0.0),
                            label=ev.get("label", ""), eta=ev.get("eta"))
            elif kind == "done":
                jobs.update(job["id"], status="done", progress=1.0, label="Done", eta=0,
                            output=ev.get("video") or ev.get("wav"), wav=ev.get("wav"),
                            stems=ev.get("stems"), mix=ev.get("mix"),
                            music=ev.get("music", False), took=ev.get("took"))
            elif kind == "error":
                last_error = ev.get("message") or ev.get("code")
        proc.wait()
        jobs.proc = None
    if jobs.closing:                    # the window closed mid-run: it restarts next time
        return
    j = jobs.get(job["id"])
    if j is None:                       # removed while running
        shutil.rmtree(stems_dir, ignore_errors=True)
        return
    if j["status"] == "cancelled":
        remove_partials(j)
        shutil.rmtree(stems_dir, ignore_errors=True)
    elif j["status"] != "done":
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-600:].strip()
        fallback = tail.splitlines()[-1] if tail else "The engine stopped."
        jobs.update(job["id"], status="error", label="Failed", error=last_error or fallback)


# -- page API --------------------------------------------------------------------

class Api:
    """Called from the page as window.pywebview.api.<name>(...)."""

    def __init__(self) -> None:
        self._window = None

    def state(self) -> dict:
        with jobs.lock:
            return {"jobs": [dict(j) for j in jobs.items], "port": SERVER_PORT}

    def add_files(self, paths: list[str]) -> int:
        return jobs.add(paths)

    def pick_files(self) -> int:
        import webview
        picked = self._window.create_file_dialog(
            webview.FileDialog.OPEN, allow_multiple=True,
            file_types=("Videos and audio (*.mp4;*.mov;*.mkv;*.webm;*.m4v;*.avi;*.mts;"
                        "*.wav;*.mp3;*.m4a;*.flac;*.aac)", "All files (*.*)"))
        return jobs.add(list(picked or []))

    def cancel(self, job_id: str) -> None:
        j = jobs.get(job_id)
        if not j:
            return
        if j["status"] == "running" and jobs.proc and jobs.running_id == job_id:
            jobs.update(job_id, status="cancelled", label="Stopped")
            kill_tree(jobs.proc)
        elif j["status"] == "queued":
            jobs.update(job_id, status="cancelled", label="Stopped")
        jobs.save()

    def retry(self, job_id: str) -> None:
        jobs.update(job_id, status="queued", progress=0.0, label="Waiting", error=None)
        jobs.save()
        jobs.wake.set()

    def remove(self, job_id: str) -> None:
        """Take a file off the list. Its cleaned files stay; its previews go."""
        j = jobs.get(job_id)
        if not j:
            return
        if j["status"] == "running":
            self.cancel(job_id)
        with jobs.lock:
            jobs.items = [x for x in jobs.items if x["id"] != job_id]
        if j["status"] != "running":
            shutil.rmtree(STEMS / job_id, ignore_errors=True)
        jobs.save()

    def clear(self, which: str = "all") -> None:
        """which = "all" or "finished" (done, failed, stopped)."""
        with jobs.lock:
            ids = [j["id"] for j in jobs.items
                   if which == "all" or j["status"] in ("done", "error", "cancelled")]
        for job_id in ids:
            self.remove(job_id)

    def save_mix(self, job_id: str, speech: float, background: float, music: float) -> dict:
        j = jobs.get(job_id)
        if not j or not j.get("stems"):
            return {"ok": False, "error": "This file has no previews to remix."}
        cmd = [str(ENGINE), "remix", j["stems"], "-s", f"{speech:g}", "-b", f"{background:g}",
               "-m", f"{music:g}", "--events"]
        r = subprocess.run(cmd, capture_output=True, env=ENV, creationflags=NO_WINDOW)
        done = err = None
        for line in r.stdout.decode("utf-8", errors="replace").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("event") == "done":
                done = ev
            elif ev.get("event") == "error":
                err = ev.get("message")
        if not done:
            return {"ok": False, "error": err or r.stderr.decode(errors="replace")[-300:]}
        jobs.update(job_id, mix=done.get("mix"), output=done.get("video") or done.get("wav"),
                    wav=done.get("wav"))
        jobs.save()
        return {"ok": True, "output": done.get("video") or done.get("wav"),
                "took": done.get("took")}

    def reveal(self, job_id: str) -> None:
        j = jobs.get(job_id)
        if j:
            target = j.get("output") if j.get("output") and Path(j["output"]).exists() else j["input"]
            subprocess.Popen(["explorer", "/select,", target])

    def open_file(self, job_id: str) -> None:
        j = jobs.get(job_id)
        if j and j.get("output") and Path(j["output"]).exists():
            os.startfile(j["output"])

    def open_site(self) -> None:
        """Footer link: open squarecirclelabs.com in the normal web browser."""
        os.startfile("https://squarecirclelabs.com")


api = Api()


# -- local web server -------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """/ -> page, /ui/<file>, /stems/<id>/<preview>.wav, /media/<id> (original, seekable)."""

    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        parts = [urllib.parse.unquote(p) for p in self.path.split("?")[0].split("/") if p]
        try:
            if not parts:
                return self.send_file(UI / "index.html")
            if parts[0] == "ui" and len(parts) >= 2:
                f = UI.joinpath(*parts[1:]).resolve()
                if f.is_relative_to(UI):          # never serve anything outside ui\
                    return self.send_file(f)
            if parts == ["api", "appearance"]:
                return self.send_json({"appearance": read_appearance()})
            if parts[0] == "stems" and len(parts) == 3:
                name = Path(parts[2]).name
                if name.startswith("preview_") and name.endswith(".wav"):
                    return self.send_file(STEMS / Path(parts[1]).name / name)
            if parts[0] == "stems" and len(parts) == 3 and parts[2] == "manifest.json":
                return self.send_file(STEMS / Path(parts[1]).name / "manifest.json")
            if parts[0] == "media" and len(parts) == 2:
                j = jobs.get(parts[1])
                if j:
                    return self.send_file(Path(j["input"]))
        except (ConnectionError, OSError):
            return
        self.send_error(404)

    def do_POST(self) -> None:
        """A second launch hands its files to this window: POST /add (JSON list)."""
        if self.path == "/add":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                paths = json.loads(body or b"[]")
            except ValueError:
                return self.send_error(400, "Expected a JSON list of file paths")
            n = jobs.add([str(p) for p in paths] if isinstance(paths, list) else [])
            self.send_response(200)
            self.end_headers()
            self.wfile.write(str(n).encode())
            if api._window:
                api._window.restore()
                api._window.show()
            return
        if self.path == "/api/appearance":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                return self.send_json({"appearance": write_appearance(json.loads(body or b"null"))})
            except (ValueError, OSError) as e:
                return self.send_error(400, str(e))
        if self.path == "/test-eval" and os.environ.get("ORCA_TEST") == "1" and api._window:
            # Test hook, only when started with ORCA_TEST=1: run page code, return the result.
            code = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
            out = json.dumps(api._window.evaluate_js(code), default=str).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_error(404)

    def send_json(self, obj) -> None:
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            if a:
                start, end = int(a), int(b) if b else size - 1
            else:
                start = max(0, size - int(b))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


SERVER_PORT = 0


def hand_to_running_window(paths: list[str]) -> bool:
    """If the window is already open, give it the files and return True."""
    try:
        port = int(PORT_FILE.read_text().strip())
        req = urllib.request.Request(f"http://127.0.0.1:{port}/add",
                                     data=json.dumps(paths).encode(), method="POST")
        urllib.request.urlopen(req, timeout=2).read()
        return True
    except (OSError, ValueError):
        return False


def main() -> None:
    global SERVER_PORT
    import webview
    from webview.dom import DOMEventHandler

    args = [str(Path(a).resolve()) for a in sys.argv[1:]]
    if hand_to_running_window(args):
        return

    DATA.mkdir(parents=True, exist_ok=True)
    STEMS.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    SERVER_PORT = server.server_address[1]
    PORT_FILE.write_text(str(SERVER_PORT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()
    if args:
        jobs.add(args)

    window = webview.create_window(
        "OrcaAudioCleanup", f"http://127.0.0.1:{SERVER_PORT}/", js_api=api,
        width=1280, height=820, min_size=(900, 600), background_color="#14161a")
    api._window = window

    def on_drop(e) -> None:
        files = e.get("dataTransfer", {}).get("files", [])
        jobs.add([f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")])

    def on_loaded() -> None:
        window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)

    def on_closing() -> None:
        jobs.closing = True
        if jobs.proc:
            j = jobs.get(jobs.running_id or "")
            if j:
                j["status"] = "queued"      # starts again next time the app opens
            kill_tree(jobs.proc)
            if j:
                remove_partials(j)
        jobs.save()
        PORT_FILE.unlink(missing_ok=True)

    window.events.loaded += on_loaded
    window.events.closing += on_closing
    webview.start(gui="edgechromium", private_mode=False,
                  storage_path=str(DATA / "webview"),
                  icon=str(Path(__file__).resolve().parent / "OrcaAudioCleanup.ico"))


if __name__ == "__main__":
    main()
