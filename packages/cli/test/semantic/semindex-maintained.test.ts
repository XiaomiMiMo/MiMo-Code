import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = await mkdtemp(join(tmpdir(), "semindex-maintained-"))
const script = new URL("../../script/semindex.py", import.meta.url).pathname
const queryHelper = new URL("../../script/semindex-semantic.py", import.meta.url).pathname
const home = join(root, "index")
const memory = join(root, "memory")
const dimension = 16
const documentTemplate = "passage: {title} | {text}"
const queryPrefix = "query: "
let server: ReturnType<typeof Bun.serve>
let delayEmbeddings = false
let residentDigest = "fixture-digest"
let embeddingCalls = 0

beforeAll(async () => {
  await Bun.$`mkdir -p ${memory}`
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/tags") return Response.json({ models: [
        { name: "test/model:latest", digest: residentDigest },
        { name: "test/model:alternate", digest: "different-tag-digest" },
      ] })
      if (url.pathname !== "/api/embed") return new Response("missing", { status: 404 })
      embeddingCalls += 1
      if (delayEmbeddings) await new Promise((resolve) => setTimeout(resolve, 400))
      const body = await request.json() as { input?: string[] }
      const embeddings = (body.input ?? []).map((input) => {
        const vector = Array(dimension).fill(0)
        vector[Array.from(input).reduce((sum, char) => sum + char.charCodeAt(0), 0) % dimension] = 1
        return vector
      })
      return Response.json({ embeddings })
    },
  })
})

afterAll(async () => {
  server.stop(true)
  await Bun.$`chmod -R u+w ${root}`
  await rm(root, { recursive: true, force: true })
})

async function invoke(command: "build" | "update", corpus = "memory", indexRoot = home, dbPath = join(root, "history.db")) {
  const child = await invokeRaw(command, indexRoot, dbPath, corpus)
  if (child.code !== 0) throw new Error(`semindex ${command} failed: ${child.stderr}`)
  return child.stdout
}

async function invokeRaw(command: "build" | "update", indexRoot = home, dbPath = join(root, "history.db"), corpus = "memory") {
  const process = Bun.spawn(["python3", script, command, corpus], {
    env: {
      ...globalThis.process.env,
      SEMINDEX_HOME: indexRoot,
      SEMINDEX_MEMORY_DIR: memory,
      SEMINDEX_DB: dbPath,
      SEMINDEX_OLLAMA: `http://127.0.0.1:${server.port}`,
      SEMINDEX_MODEL: "test/model",
      SEMINDEX_DOCUMENT_TEMPLATE: documentTemplate,
      SEMINDEX_QUERY_PREFIX: queryPrefix,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  return { stdout, stderr, code: exitCode }
}

async function generation(corpus = "memory") {
  return (await readFile(join(home, `${corpus}.current`), "utf8")).trim()
}

async function metadata(id: string, corpus = "memory") {
  return JSON.parse(await readFile(join(home, "generations", corpus, id, `${corpus}.json`), "utf8")) as Array<{
    text: string
    source: string
    session_id?: string
    message_id?: string
    kind?: string
    time?: number
  }>
}

async function semanticLookup(source: string) {
  const child = Bun.spawn(["python3", queryHelper], {
    env: {
      ...globalThis.process.env,
      SEMINDEX_HOME: home,
      SEMINDEX_OLLAMA: `http://127.0.0.1:${server.port}`,
      SEMINDEX_MODEL: "test/model",
      SEMINDEX_DOCUMENT_TEMPLATE: documentTemplate,
      SEMINDEX_QUERY_PREFIX: queryPrefix,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(JSON.stringify({ corpus: "memory", query: "synthetic query", allowed: [source], limit: 1 }))
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`semantic helper failed: ${stderr}`)
  return JSON.parse(stdout) as Array<{ source: string }>
}

test("maintained writer publishes incremental, empty, and deleted-source generations", async () => {
  const source = join(memory, "note.md")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "memory.writer.lock"), "stale lock from a dead writer")
  const original = "# Original\n\n" + "Original note content remains long enough to form one indexed chunk. ".repeat(4)
  await writeFile(source, original)
  await invoke("build")
  const built = await generation()
  expect(await metadata(built)).toHaveLength(1)
  const published = join(home, "generations", "memory", built)
  expect((await stat(published)).mode & 0o777).toBe(0o500)
  for (const name of ["memory.npy", "memory.json", "memory.manifest.json"]) {
    expect((await stat(join(published, name))).mode & 0o777).toBe(0o400)
  }
  expect((await semanticLookup(source))[0]?.source).toBe(source)

  residentDigest = "changed-model-digest"
  await writeFile(source, "# Unpublished model change\n\n" + "This content must wait for a consistent embedding model before publication. ".repeat(4))
  const beforeModelChange = await generation()
  expect((await invokeRaw("update")).code).not.toBe(0)
  expect(await generation()).toBe(beforeModelChange)
  residentDigest = "fixture-digest"

  await writeFile(source, "# Revised\n\n" + "Revised note content is distinct and long enough to form a replacement indexed chunk. ".repeat(4))
  await invoke("update")
  const revised = await generation()
  expect(revised).not.toBe(built)
  expect((await metadata(revised))[0]?.text).toContain("Revised")

  await writeFile(source, "short")
  await invoke("update")
  const empty = await generation()
  expect(await metadata(empty)).toHaveLength(0)

  await writeFile(source, original)
  await invoke("update")
  expect(await metadata(await generation())).toHaveLength(1)
  await Bun.$`rm ${source}`
  await invoke("update")
  const deleted = await generation()
  expect(await metadata(deleted)).toHaveLength(0)
  await writeFile(source, original)
  await invoke("update")
  expect(await metadata(await generation())).toHaveLength(1)

  await unlink(source)
  await symlink(join(root, "missing-target.md"), source)
  const beforeReadFailure = await generation()
  expect((await invokeRaw("update")).code).not.toBe(0)
  expect(await generation()).toBe(beforeReadFailure)
  await unlink(source)
  await invoke("update")
  expect(await metadata(await generation())).toHaveLength(0)
})

test("writer lock rejects a concurrent update without changing the published snapshot", async () => {
  const source = join(memory, "concurrent.md")
  await writeFile(source, "# Concurrent\n\n" + "Concurrent content is long enough to make an indexed synthetic chunk. ".repeat(4))
  await invoke("update")
  const before = await generation()
  await writeFile(source, "# Changed\n\n" + "Changed content is a newly indexed synthetic chunk. ".repeat(5))
  const env = {
    ...globalThis.process.env,
    SEMINDEX_HOME: home,
    SEMINDEX_MEMORY_DIR: memory,
    SEMINDEX_OLLAMA: `http://127.0.0.1:${server.port}`,
    SEMINDEX_MODEL: "test/model",
    SEMINDEX_DOCUMENT_TEMPLATE: documentTemplate,
    SEMINDEX_QUERY_PREFIX: queryPrefix,
  }
  delayEmbeddings = true
  const first = Bun.spawn(["python3", script, "update", "memory"], { env, stdout: "pipe", stderr: "pipe" })
  const second = Bun.spawn(["python3", script, "update", "memory"], { env, stdout: "pipe", stderr: "pipe" })
  const attest = Bun.spawn(["python3", queryHelper, "--attest", "memory"], { env, stdout: "ignore", stderr: "ignore" })
  const concurrentRead = semanticLookup(source)
  const results = await Promise.all([first, second].map(async (child) => ({
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  })))
  delayEmbeddings = false
  expect(await attest.exited).not.toBe(0)
  expect((await concurrentRead)[0]?.source).toBe(source)
  expect(results.filter((result) => result.code === 0)).toHaveLength(1)
  expect(results.filter((result) => result.code !== 0)).toHaveLength(1)
  expect(await generation()).not.toBe(before)
  expect(await metadata(await generation())).toHaveLength(1)
})

test("legacy indexes require explicit attestation before incremental update", async () => {
  const legacyHome = join(root, "legacy-index")
  const setup = String.raw`import numpy as np,sys; from pathlib import Path; p=Path(sys.argv[1]); p.mkdir(parents=True); np.save(p/'memory.npy',np.empty((0,16),dtype=np.float32)); (p/'memory.json').write_text('[]')`
  const setupResult = Bun.spawnSync({ cmd: ["python3", "-c", setup, legacyHome], stdout: "pipe", stderr: "pipe" })
  expect(setupResult.exitCode).toBe(0)
  const result = await invokeRaw("update", legacyHome)
  expect(result.code).not.toBe(0)
  expect(await Bun.file(join(legacyHome, "memory.current")).exists()).toBe(false)

  const emptyHome = join(root, "empty-index")
  const empty = await invokeRaw("update", emptyHome)
  expect(empty.code).not.toBe(0)
  expect(empty.stderr).toContain("run the explicit build command first")
})

test("missing model configuration fails before indexing", async () => {
  const missingModelHome = join(root, "missing-model-index")
  const env: Record<string, string> = {
    ...globalThis.process.env,
    SEMINDEX_HOME: missingModelHome,
    SEMINDEX_MEMORY_DIR: memory,
  }
  delete env.SEMINDEX_MODEL
  const child = Bun.spawn(["python3", script, "build", "memory"], { env, stdout: "pipe", stderr: "pipe" })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(code).not.toBe(0)
  expect(stderr).toContain("set SEMINDEX_MODEL")
  expect(await Bun.file(join(missingModelHome, "memory.current")).exists()).toBe(false)
})

test("post-pointer fsync failure keeps the published attestation generation", async () => {
  const fixtureRoot = join(root, "fault-attestation")
  const setup = String.raw`
import hashlib,json,sys
import numpy as np
from pathlib import Path
r=Path(sys.argv[1]); r.mkdir(parents=True)
text='synthetic attestation text'; title='Synthetic'; framed=f'passage: {title} | {text}'
v=np.zeros((1,16),dtype=np.float32); v[0,sum(map(ord,framed))%16]=1
np.save(r/'memory.npy',v)
(r/'memory.json').write_text(json.dumps([{'source':'/tmp/example','text':text,'sig':hashlib.sha1(text.encode()).hexdigest()[:12],'title':title}]))
(r/'memory.manifest.json').write_text(json.dumps({'corpus':'memory','model':'test/model','chunks':1,'files':{}}))
`
  const setupResult = Bun.spawnSync({ cmd: ["python3", "-c", setup, fixtureRoot], stdout: "pipe", stderr: "pipe" })
  expect(setupResult.exitCode).toBe(0)
  const fault = String.raw`
import importlib.util,sys
from pathlib import Path
source,root=sys.argv[1],Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('semantic_helper',source); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
original=module.fsync_path
def injected(path,directory=False):
    if directory and Path(path)==root and (root/'memory.current').exists(): raise OSError('injected parent fsync failure')
    return original(path,directory)
module.fsync_path=injected
try: module.attest_unlocked('memory',root)
except OSError as error: print('injected exception:',error)
else: raise AssertionError('fault was not injected')
generation=(root/'memory.current').read_text().strip()
published=root/'generations'/'memory'/generation
assert (published/'memory.npy').is_file() and (published/'memory.json').is_file() and (published/'memory.manifest.json').is_file()
assert published.stat().st_mode & 0o777 == 0o500
assert all((published/name).stat().st_mode & 0o777 == 0o400 for name in ('memory.npy','memory.json','memory.manifest.json'))
`
  const child = Bun.spawn(["python3", "-c", fault, queryHelper, fixtureRoot], {
    env: { ...globalThis.process.env, SEMINDEX_OLLAMA: `http://127.0.0.1:${server.port}`, SEMINDEX_MODEL: "test/model", SEMINDEX_DOCUMENT_TEMPLATE: documentTemplate, SEMINDEX_QUERY_PREFIX: queryPrefix },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(exitCode).toBe(0)
})

test("first generation syncs every new parent directory before publishing its pointer", async () => {
  const maintainedRoot = join(root, "durable-maintained")
  await mkdir(maintainedRoot, { recursive: true })
  const maintained = String.raw`
import importlib.util,os,sys
from pathlib import Path
import numpy as np
source,root=sys.argv[1],Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('maintained',source); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
events=[]; original_fsync=module.fsync_path; original_replace=module.os.replace
def record_fsync(path,directory=False):
    original_fsync(path,directory)
    if directory: events.append(('fsync',str(Path(path))))
def record_replace(source,destination):
    events.append(('replace',str(destination)))
    original_replace(source,destination)
module.fsync_path=record_fsync; module.os.replace=record_replace
vectors=np.zeros((1,16),dtype=np.float32); vectors[0,0]=1
module.save('memory',vectors,[{'source':'/tmp/example','sig':'synthetic','text':'synthetic'}],{'model_digest':'fixture-digest','resident_model_digest':'fixture-digest'})
pointer=str(root/'memory.current'); published=next(i for i,event in enumerate(events) if event==('replace',pointer))
for directory in (root/'generations',root/'generations'/'memory',root):
    assert any(event==('fsync',str(directory)) for event in events[:published]), (directory,events)
`
  const maintainedChild = Bun.spawn(["python3", "-c", maintained, script, maintainedRoot], {
    env: { ...globalThis.process.env, SEMINDEX_HOME: maintainedRoot },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [maintainedOut, maintainedErr, maintainedCode] = await Promise.all([
    new Response(maintainedChild.stdout).text(),
    new Response(maintainedChild.stderr).text(),
    maintainedChild.exited,
  ])
  if (maintainedCode !== 0) throw new Error(`${maintainedOut}\n${maintainedErr}`)

  const attestRoot = join(root, "durable-attestation")
  const setup = String.raw`
import hashlib,json,sys
import numpy as np
from pathlib import Path
r=Path(sys.argv[1]); r.mkdir(parents=True)
text='synthetic attestation text'; title='Synthetic'; framed=f'passage: {title} | {text}'
v=np.zeros((1,16),dtype=np.float32); v[0,sum(map(ord,framed))%16]=1
np.save(r/'memory.npy',v)
(r/'memory.json').write_text(json.dumps([{'source':'/tmp/example','text':text,'sig':hashlib.sha1(text.encode()).hexdigest()[:12],'title':title}]))
(r/'memory.manifest.json').write_text(json.dumps({'corpus':'memory','model':'test/model','chunks':1,'files':{}}))
`
  const setupChild = Bun.spawnSync({ cmd: ["python3", "-c", setup, attestRoot], stdout: "pipe", stderr: "pipe" })
  expect(setupChild.exitCode).toBe(0)
  const attest = String.raw`
import importlib.util,os,sys
from pathlib import Path
source,root=sys.argv[1],Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('attester',source); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
events=[]; original_fsync=module.fsync_path; original_replace=module.os.replace
def record_fsync(path,directory=False):
    original_fsync(path,directory)
    if directory: events.append(('fsync',str(Path(path))))
def record_replace(source,destination):
    events.append(('replace',str(destination)))
    original_replace(source,destination)
module.fsync_path=record_fsync; module.os.replace=record_replace
module.attest_unlocked('memory',root)
pointer=str(root/'memory.current'); published=next(i for i,event in enumerate(events) if event==('replace',pointer))
for directory in (root/'generations',root/'generations'/'memory',root):
    assert any(event==('fsync',str(directory)) for event in events[:published]), (directory,events)
`
  const attestChild = Bun.spawn(["python3", "-c", attest, queryHelper, attestRoot], {
    env: { ...globalThis.process.env, SEMINDEX_OLLAMA: `http://127.0.0.1:${server.port}`, SEMINDEX_MODEL: "test/model", SEMINDEX_DOCUMENT_TEMPLATE: documentTemplate, SEMINDEX_QUERY_PREFIX: queryPrefix },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [attestOut, attestErr, attestCode] = await Promise.all([
    new Response(attestChild.stdout).text(),
    new Response(attestChild.stderr).text(),
    attestChild.exited,
  ])
  if (attestCode !== 0) throw new Error(`${attestOut}\n${attestErr}`)
})

test("trajectory refresh reconciles old edits, short sources, and deletion", async () => {
  const dbPath = join(root, "trajectory.db")
  const body = "Original older trajectory evidence. " + "This synthetic historical message contains enough text for one semantic chunk. ".repeat(4)
  const setup = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table history_fts(part_id text,session_id text,message_id text,kind text,time_created integer,body text)'); c.execute('insert into history_fts values(?,?,?,?,?,?)',('part-test-1','session-test-1','message-test-1','user_text',1,sys.argv[2])); c.commit(); c.close()`
  const created = Bun.spawnSync({ cmd: ["python3", "-c", setup, dbPath, body], stdout: "pipe", stderr: "pipe" })
  expect(created.exitCode).toBe(0)
  await invoke("build", "traj", home, dbPath)
  let current = await generation("traj")
  expect(await metadata(current, "traj")).toHaveLength(1)

  const edited = "Edited older trajectory evidence. " + "The historical message changed while its timestamp remained old, so reconciliation must find it. ".repeat(4)
  const update = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update history_fts set body=? where part_id=?',(sys.argv[2],'part-test-1')); c.commit(); c.close()`
  const changed = Bun.spawnSync({ cmd: ["python3", "-c", update, dbPath, edited], stdout: "pipe", stderr: "pipe" })
  expect(changed.exitCode).toBe(0)
  await invoke("update", "traj", home, dbPath)
  current = await generation("traj")
  expect((await metadata(current, "traj"))[0]?.text).toContain("Edited older")

  const beforeMetadataOnly = current
  const embeddingsBeforeMetadataOnly = embeddingCalls
  const metadataUpdate = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update history_fts set session_id=?,message_id=?,time_created=? where part_id=?',('session-test-2','message-test-2',2,'part-test-1')); c.commit(); c.close()`
  const metadataResult = Bun.spawnSync({ cmd: ["python3", "-c", metadataUpdate, dbPath], stdout: "pipe", stderr: "pipe" })
  expect(metadataResult.exitCode).toBe(0)
  await invoke("update", "traj", home, dbPath)
  current = await generation("traj")
  expect(current).not.toBe(beforeMetadataOnly)
  expect(embeddingCalls).toBe(embeddingsBeforeMetadataOnly)
  const refreshed = (await metadata(current, "traj"))[0]
  expect(refreshed?.session_id).toBe("session-test-2")
  expect(refreshed?.message_id).toBe("message-test-2")
  expect(refreshed?.kind).toBe("user_text")
  expect(refreshed?.time).toBe(2)

  const beforeTitleEmbedding = embeddingCalls
  const titleUpdate = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update history_fts set kind=? where part_id=?',('assistant_text','part-test-1')); c.commit(); c.close()`
  const titleChanged = Bun.spawnSync({ cmd: ["python3", "-c", titleUpdate, dbPath], stdout: "pipe", stderr: "pipe" })
  expect(titleChanged.exitCode).toBe(0)
  await invoke("update", "traj", home, dbPath)
  current = await generation("traj")
  expect((await metadata(current, "traj"))[0]?.kind).toBe("assistant_text")
  expect(embeddingCalls).toBe(beforeTitleEmbedding + 1)

  const short = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update history_fts set body=? where part_id=?',('short','part-test-1')); c.commit(); c.close()`
  const shortened = Bun.spawnSync({ cmd: ["python3", "-c", short, dbPath], stdout: "pipe", stderr: "pipe" })
  expect(shortened.exitCode).toBe(0)
  await invoke("update", "traj", home, dbPath)
  expect(await metadata(await generation("traj"), "traj")).toHaveLength(0)

  const deleted = String.raw`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('delete from history_fts where part_id=?',('part-test-1',)); c.commit(); c.close()`
  const removed = Bun.spawnSync({ cmd: ["python3", "-c", deleted, dbPath], stdout: "pipe", stderr: "pipe" })
  expect(removed.exitCode).toBe(0)
  await invoke("update", "traj", home, dbPath)
  expect(await metadata(await generation("traj"), "traj")).toHaveLength(0)
})
