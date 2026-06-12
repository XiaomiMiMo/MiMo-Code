import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmpRoots: string[] = []

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-install-script-"))
  tmpRoots.push(dir)
  return dir
}

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content)
  fs.chmodSync(file, 0o755)
}

describe("install script windows binary selection", () => {
  test("downloads the windows x64 baseline archive even when avx2 is available", () => {
    const root = tmpdir()
    const bin = path.join(root, "bin")
    const urlFile = path.join(root, "download-url")
    fs.mkdirSync(bin)
    writeExecutable(
      path.join(bin, "uname"),
      `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  echo MINGW64_NT-10.0
elif [ "$1" = "-m" ]; then
  echo x86_64
else
  echo MINGW64_NT-10.0
fi
`,
    )
    writeExecutable(path.join(bin, "powershell.exe"), "#!/usr/bin/env bash\necho True\n")
    writeExecutable(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
if [[ " $* " == *" -w "* ]]; then
  printf 200
  exit 0
fi

output=""
last=""
for arg in "$@"; do
  if [ "$last" = "-o" ]; then
    output="$arg"
  fi
  last="$arg"
done

printf "%s" "$*" > "$RECORDED_URL_FILE"
mkdir -p "$(dirname "$output")"
printf archive > "$output"
`,
    )
    writeExecutable(
      path.join(bin, "unzip"),
      `#!/usr/bin/env bash
last=""
dest=""
for arg in "$@"; do
  if [ "$last" = "-d" ]; then
    dest="$arg"
  fi
  last="$arg"
done
mkdir -p "$dest"
printf mimo > "$dest/mimo"
`,
    )

    const result = spawnSync("bash", [path.join(__dirname, "../../../..", "install"), "--version", "0.1.0", "--no-modify-path"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        RECORDED_URL_FILE: urlFile,
        SHELL: "/bin/bash",
        TMPDIR: root,
      },
      encoding: "utf8",
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(fs.readFileSync(urlFile, "utf8")).toContain("mimocode-windows-x64-baseline.zip")
  })
})
