#!/usr/bin/env bun
// Xiaomi FDS upload for release artifacts. Galaxy-V2 signing reimplemented with
// Node's built-in crypto (no Python/SDK), matching galaxy-fds-sdk's
// fds/auth/signature/signer.py. Pure signing logic is unit-testable; HTTP PUT is
// the IO shell.
//
// Upload host (path-style, with /bucket) differs from the public download host
// (CDN, bucket already in the subdomain). install reads from the CDN host.
//
// Env:
//   MIMO_FDS_AK / MIMO_FDS_SK            credentials (required to upload)
//   MIMO_FDS_ENDPOINT                    upload+signing host (default cnbj1 prod)
//   MIMO_FDS_BUCKET / MIMO_FDS_PREFIX    object layout (default mimocode/mimocode)
//
// CLI: bun script/fds-upload.ts <localFile> <objectSubPath> [--content-type=...]
//   objectSubPath is relative to "<bucket>/<prefix>/", e.g. "releases/latest".
import crypto from "node:crypto"

export const FDS_ENDPOINT = process.env.MIMO_FDS_ENDPOINT || "cnbj1-fds.api.xiaomi.net"
export const FDS_BUCKET = process.env.MIMO_FDS_BUCKET || "mimocode"
export const FDS_PREFIX = process.env.MIMO_FDS_PREFIX || "mimocode"

// signer.py SubResource.get_all_subresource: only these query keys are signed.
const SUBRESOURCES = new Set(["acl", "quota", "uploads", "partNumber", "uploadId", "storageAccessToken", "metadata"])

// signer._canonicalize_resource: path + sorted signed sub-resource query.
export function canonicalizeResource(urlStr: string) {
  const u = new URL(urlStr)
  let result = decodeURIComponent(u.pathname)
  const raw = u.search.startsWith("?") ? u.search.slice(1) : u.search
  const parts = raw ? raw.split("&") : []
  let i = 0
  for (const q of [...parts].sort()) {
    const [k, v] = q.split("=")
    if (SUBRESOURCES.has(k!)) {
      result += i === 0 ? "?" : "&"
      result += v === undefined ? k : `${k}=${v}`
      i++
    }
  }
  return result
}

// signer._construct_string_to_sign: method\n md5\n type\n date\n + canonical resource.
export function buildStringToSign(input: {
  method: string
  url: string
  contentType?: string
  date: string
  contentMd5?: string
}) {
  return `${input.method}\n${input.contentMd5 ?? ""}\n${input.contentType ?? ""}\n${input.date}\n${canonicalizeResource(input.url)}`
}

export function authHeader(input: {
  accessKey: string
  secret: string
  method: string
  url: string
  contentType?: string
  date: string
  contentMd5?: string
}) {
  const sig = crypto.createHmac("sha1", input.secret).update(buildStringToSign(input), "utf8").digest("base64")
  return `Galaxy-V2 ${input.accessKey}:${sig}`
}

// galaxy_fds_client._acl_to_acp: public READ for ALL_USERS group. Not added by
// put_object automatically, so anonymous download returns 403 without it.
function publicReadAclBody(accessKey: string) {
  return {
    owner: { id: accessKey },
    accessControlList: [{ grantee: { id: "ALL_USERS" }, type: "GROUP", permission: "READ" }],
  }
}

// Full object name under the bucket, e.g. "mimocode/releases/latest".
export function objectName(subPath: string) {
  return `${FDS_PREFIX}/${subPath.replace(/^\/+/, "")}`
}

// Upload host, path-style: endpoint/bucket/object. Used for PUT and signing.
function uploadUrl(name: string) {
  return `https://${FDS_ENDPOINT}/${FDS_BUCKET}/${name}`
}

async function safeText(res: Response) {
  try {
    return await res.text()
  } catch {
    return "<no body>"
  }
}

// Upload one object and set public-read ACL.
export async function putObject(input: {
  accessKey: string
  secret: string
  name: string
  body: Uint8Array | string
  contentType: string
}) {
  const url = uploadUrl(input.name)
  const date1 = new Date().toUTCString()
  const putRes = await fetch(url, {
    method: "PUT",
    headers: {
      date: date1,
      "content-type": input.contentType,
      "cache-control": "no-cache",
      authorization: authHeader({ ...input, method: "PUT", url, contentType: input.contentType, date: date1 }),
    },
    body: input.body as BodyInit,
  })
  if (!putRes.ok) throw new Error(`FDS put failed ${putRes.status}: ${await safeText(putRes)}`)

  const aclUrl = `${url}?acl=true`
  const date2 = new Date().toUTCString()
  const aclRes = await fetch(aclUrl, {
    method: "PUT",
    headers: {
      date: date2,
      "content-type": "application/json",
      authorization: authHeader({
        ...input,
        method: "PUT",
        url: aclUrl,
        contentType: "application/json",
        date: date2,
      }),
    },
    body: JSON.stringify(publicReadAclBody(input.accessKey)),
  })
  if (!aclRes.ok) throw new Error(`FDS set acl failed ${aclRes.status}: ${await safeText(aclRes)}`)
}

function contentTypeFor(file: string) {
  if (file.endsWith(".zip")) return "application/zip"
  if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) return "application/gzip"
  if (file.endsWith(".json")) return "application/json"
  return "application/octet-stream"
}

// Upload a local file to "<prefix>/<subPath>". Returns the object name.
export async function uploadFile(localFile: string, subPath: string, contentType?: string) {
  const accessKey = process.env.MIMO_FDS_AK
  const secret = process.env.MIMO_FDS_SK
  if (!accessKey || !secret) throw new Error("MIMO_FDS_AK / MIMO_FDS_SK must be set to upload to FDS")
  const name = objectName(subPath)
  await putObject({
    accessKey,
    secret,
    name,
    body: new Uint8Array(await Bun.file(localFile).arrayBuffer()),
    contentType: contentType ?? contentTypeFor(localFile),
  })
  return name
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"))
  const ctFlag = process.argv.find((a) => a.startsWith("--content-type="))?.split("=")[1]
  const [localFile, subPath] = args
  if (!localFile || !subPath) {
    console.error("Usage: bun script/fds-upload.ts <localFile> <objectSubPath> [--content-type=...]")
    process.exit(1)
  }
  const name = await uploadFile(localFile, subPath, ctFlag)
  console.log(`Uploaded ${localFile} -> ${FDS_BUCKET}/${name}`)
}
