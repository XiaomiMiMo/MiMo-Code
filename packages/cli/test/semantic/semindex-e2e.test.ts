import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { search } from "../../src/semantic/candidates"

const root = await mkdtemp(join(tmpdir(), "semindex-e2e-"))
const helper = new URL("../../script/semindex-semantic.py", import.meta.url).pathname
const documentTemplate = "passage: {title} | {text}"
const queryPrefix = "query: "
const oldEnv = {
  helper: process.env.MIMOCODE_SEMINDEX_HELPER,
  home: process.env.SEMINDEX_HOME,
  ollama: process.env.SEMINDEX_OLLAMA,
  model: process.env.SEMINDEX_MODEL,
  documentTemplate: process.env.SEMINDEX_DOCUMENT_TEMPLATE,
  queryPrefix: process.env.SEMINDEX_QUERY_PREFIX,
  python: process.env.PYTHON,
  testPython: process.env.MIMOCODE_TEST_PYTHON,
}
const slowPython = join(root, "slow-python")
let mode = "valid"
let server: ReturnType<typeof Bun.serve>
const dimension = 16

const setup = String.raw`
import hashlib,json,os,sys
import numpy as np
from pathlib import Path
root=Path(sys.argv[1]); gen='fixture-generation'; d=root/'generations'/'memory'/gen; d.mkdir(parents=True)
texts=['hidden content that must not crowd out scoped results','eligible scoped content','other scoped content']
meta=[{'source':'hidden','text':texts[0],'sig':hashlib.sha1(texts[0].encode()).hexdigest()[:12],'title':'hidden'},
      {'source':'eligible','text':texts[1],'sig':hashlib.sha1(texts[1].encode()).hexdigest()[:12],'title':'eligible'},
      {'source':'other','text':texts[2],'sig':hashlib.sha1(texts[2].encode()).hexdigest()[:12],'title':'other'}]
for i in range(5000):
 text=f'synthetic bulk chunk {i}'
 meta.append({'source':f'bulk-{i}','text':text,'sig':hashlib.sha1(text.encode()).hexdigest()[:12],'title':f'bulk-{i}'})
v=np.zeros((len(meta),16),dtype=np.float32); v[0,0]=1; v[1,0]=.8; v[1,1]=.6; v[2,1]=1; v[3:,2]=1
np.save(d/'memory.npy',v); (d/'memory.json').write_text(json.dumps(meta))
stats={}
for name in ('memory.npy','memory.json'):
 (d/name).chmod(0o400)
 s=(d/name).stat(); stats[name]={'size':s.st_size,'mtime_ns':s.st_mtime_ns,'inode':s.st_ino}
 stats[name].update({'ctime_ns':s.st_ctime_ns,'mode':s.st_mode & 0o777})
m={'semantic_protocol':2,'generation':gen,'provenance':{'memory.npy':'fixture','memory.json':'fixture'},
   'corpus':'memory','model':'test/model','model_digest':'fixture-digest','chunks':len(meta),'dimension':16,
   'dtype':'float32','normalization':'l2','document_prefix':'passage: {title} | {text}','query_prefix':'query: ',
   'chunker':'semindex-chars-1200-150-v1','file_stats':stats}
(d/'memory.manifest.json').write_text(json.dumps(m)); (d/'memory.manifest.json').chmod(0o400); d.chmod(0o500); (root/'memory.current').write_text(gen)
`

beforeAll(async () => {
  const proc = Bun.spawnSync({ cmd: ["python3", "-c", setup, root], stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  await writeFile(slowPython, "#!/usr/bin/env python3\nimport os,sys,time\ntime.sleep(10)\nreal=os.environ['MIMOCODE_TEST_PYTHON']\nos.execvp(real,[real,*sys.argv[1:]])\n")
  await chmod(slowPython, 0o755)
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/tags") {
        const digest = mode === "digest" ? "changed" : "fixture-digest"
        const models = mode === "wrong-tag"
          ? [{ name: "test/model:alternate", digest }]
          : [
              { name: "test/model:latest", digest },
              { name: "test/model:alternate", digest: "other-tag-digest" },
            ]
        if (mode === "ambiguous") models.push({ name: "test/model", digest })
        return Response.json({ models })
      }
      if (url.pathname !== "/api/embed") return new Response("missing", { status: 404 })
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 7_000))
      if (mode === "wrong-dimension") return Response.json({ embeddings: [[1, 0]] })
      if (mode === "zero") return Response.json({ embeddings: [Array(dimension).fill(0)] })
      if (mode === "nan") return new Response('{"embeddings":[[' + ["NaN", ...Array(dimension - 1).fill("0")].join(",") + "]]}", { headers: { "content-type": "application/json" } })
      if (mode === "large-y") return Response.json({ embeddings: [Array.from({ length: dimension }, (_, i) => i === 1 ? 1e38 : 0)] })
      return Response.json({ embeddings: [Array.from({ length: dimension }, (_, i) => i === 0 ? 1 : 0)] })
    },
  })
  process.env.MIMOCODE_SEMINDEX_HELPER = helper
  process.env.SEMINDEX_HOME = root
  process.env.SEMINDEX_OLLAMA = `http://127.0.0.1:${server.port}`
  process.env.SEMINDEX_MODEL = "test/model"
  process.env.SEMINDEX_DOCUMENT_TEMPLATE = documentTemplate
  process.env.SEMINDEX_QUERY_PREFIX = queryPrefix
})

afterAll(async () => {
  server.stop(true)
  for (const [key, value] of Object.entries({
    MIMOCODE_SEMINDEX_HELPER: oldEnv.helper,
    SEMINDEX_HOME: oldEnv.home,
    SEMINDEX_OLLAMA: oldEnv.ollama,
    SEMINDEX_MODEL: oldEnv.model,
    SEMINDEX_DOCUMENT_TEMPLATE: oldEnv.documentTemplate,
    SEMINDEX_QUERY_PREFIX: oldEnv.queryPrefix,
    PYTHON: oldEnv.python,
    MIMOCODE_TEST_PYTHON: oldEnv.testPython,
  })) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  await Bun.$`chmod -R u+w ${root}`
  await rm(root, { recursive: true, force: true })
})

test("verified generation filters allowed sources before top-k", async () => {
  const result = await search({ corpus: "memory", query: "synthetic query", allowed: ["eligible"], limit: 1 })
  expect(result.status).toBe("ok")
  if (result.status === "ok") {
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.source).toBe("eligible")
    expect(result.hits[0]?.signature).toBe(createHash("sha1").update("eligible scoped content").digest("hex").slice(0, 12))
  }
})

test("stable normalization and batched scoring preserve ranking across large eligible sets", async () => {
  mode = "large-y"
  const allowed = ["eligible", "other", ...Array.from({ length: 5_000 }, (_, index) => `bulk-${index}`)]
  const result = await search({ corpus: "memory", query: "synthetic query", allowed, limit: 2 })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.hits.map((hit) => hit.source)).toEqual(["other", "eligible"])
  mode = "valid"
})

test("bounded allow transport supports large histories without dropping eligible IDs", async () => {
  const allowed = Array.from({ length: 12_000 }, (_, index) => `scope-${index}`)
  allowed.push("eligible")
  const result = await search({ corpus: "memory", query: "synthetic query", allowed, limit: 1 })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.hits[0]?.source).toBe("eligible")
})

test("bad model digest and invalid vectors fail closed", async () => {
  for (const invalidMode of ["digest", "wrong-tag", "ambiguous", "wrong-dimension", "zero", "nan"]) {
    mode = invalidMode
    expect(await search({ corpus: "memory", query: "synthetic query", allowed: ["eligible"], limit: 1 })).toEqual({ status: "unavailable" })
  }
  mode = "valid"
})

test("abort cancels and reaps a helper waiting on the local model", async () => {
  mode = "slow"
  const controller = new AbortController()
  const result = search({ corpus: "memory", query: "synthetic query", allowed: ["eligible"], limit: 1, signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  expect(await result).toEqual({ status: "unavailable" })
  mode = "valid"
})

test("helper deadline kills a stalled model request", async () => {
  process.env.PYTHON = slowPython
  process.env.MIMOCODE_TEST_PYTHON = "python3"
  try {
    const started = Date.now()
    expect(await search({ corpus: "memory", query: "synthetic query", allowed: ["eligible"], limit: 1 })).toEqual({ status: "unavailable" })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)
  } finally {
    if (oldEnv.python == null) delete process.env.PYTHON
    else process.env.PYTHON = oldEnv.python
    if (oldEnv.testPython == null) delete process.env.MIMOCODE_TEST_PYTHON
    else process.env.MIMOCODE_TEST_PYTHON = oldEnv.testPython
  }
}, 10_000)

test("provider caps concurrent helper processes", async () => {
  mode = "slow"
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const first = search({ corpus: "memory", query: "synthetic one", allowed: ["eligible"], limit: 1, signal: firstAbort.signal })
  const second = search({ corpus: "memory", query: "synthetic two", allowed: ["eligible"], limit: 1, signal: secondAbort.signal })
  expect(await search({ corpus: "memory", query: "synthetic three", allowed: ["eligible"], limit: 1 })).toEqual({ status: "unavailable" })
  firstAbort.abort()
  secondAbort.abort()
  await Promise.all([first, second])
  mode = "valid"
})
