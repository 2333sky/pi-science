import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceLockAvailable } from "./doctor.mjs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("a zombie is exited, while its live parent retains a process identity", { skip: process.platform !== "linux" }, async () => {
  const parent = spawn("python3", ["-u", "-c", "import os,sys\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\nsys.stdin.readline()\nos.waitpid(pid,0)"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const [chunk] = await once(parent.stdout, "data"); const zombie = Number(String(chunk).trim());
    for (let i = 0; i < 100; i++) { const text = await readFile(`/proc/${zombie}/stat`, "utf8"); if (text.slice(text.lastIndexOf(")") + 2).startsWith("Z ")) break; await delay(10); }
    const script = fileURLToPath(new URL("./pi-science.sh", import.meta.url));
    const checked = spawnSync("bash", ["-c", 'source "$1"; process_is_running "$2" && exit 10; test -z "$(process_start_identity "$2")" || exit 11; process_is_running "$3" || exit 12; test -n "$(process_start_identity "$3")"', "_", script, String(zombie), String(parent.pid)], { env: { ...process.env, PI_SCIENCE_SOURCE_ONLY: "1" }, encoding: "utf8", timeout: 5000 });
    assert.equal(checked.status, 0, checked.stderr);
    const state = await mkdtemp(join(tmpdir(), "zombie-doctor-"));
    try {
      const lock = join(state, "instance.lock"); await writeFile(lock, JSON.stringify({ pid: zombie }));
      const old = new Date(Date.now() - 60000); await utimes(lock, old, old);
      assert.match(await instanceLockAvailable(state), /stale lock/);
    } finally { await rm(state, { recursive: true, force: true }); }
  } finally { parent.stdin.end("reap\n"); await once(parent, "exit"); }
});
