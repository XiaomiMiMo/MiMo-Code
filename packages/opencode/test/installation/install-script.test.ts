import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

async function writeExecutable(file: string, content: string) {
  await Bun.write(file, content)
  await Bun.$`chmod 755 ${file}`.quiet()
}

describe("install script", () => {
  test("resolves latest version from the release asset redirect without GitHub API", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bin = path.join(dir, "bin")
        const home = path.join(dir, "home")
        const tmpdir = path.join(dir, "tmp")
        await Bun.$`mkdir -p ${bin} ${home} ${tmpdir}`.quiet()
        await writeExecutable(
          path.join(bin, "uname"),
          `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then echo Darwin; exit 0; fi
if [ "$1" = "-m" ]; then echo arm64; exit 0; fi
echo Darwin
`,
        )
        await writeExecutable(
          path.join(bin, "curl"),
          `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MIMO_TEST_CURL_LOG"
for arg in "$@"; do
  if [[ "$arg" == *api.github.com* ]]; then
    echo "unexpected GitHub API call" >&2
    exit 22
  fi
done

output=""
write_out=""
url=""
head=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -I|-*I*)
      head=true
      shift
      ;;
    -o)
      output="$2"
      shift 2
      ;;
    -w)
      write_out="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

effective="$url"
if [[ "$url" == *releases/latest/download/* ]]; then
  effective="https://github.com/XiaomiMiMo/MiMo-Code/releases/download/v0.1.0/\${url##*/}"
fi
if [ -n "$output" ] && [ "$output" != "/dev/null" ]; then
  printf 'archive' > "$output"
fi
if [ -n "$write_out" ]; then
  printf '%s' "\${write_out//\\%\\{url_effective\\}/$effective}"
fi
if [ "$head" = "true" ]; then
  printf 'HTTP/2 302\\nlocation: %s\\n' "$effective"
fi
`,
        )
        await writeExecutable(
          path.join(bin, "unzip"),
          `#!/usr/bin/env bash
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    dest="$2"
    shift 2
    continue
  fi
  shift
done
printf '#!/usr/bin/env bash\\necho 0.1.0\\n' > "$dest/mimo"
chmod 755 "$dest/mimo"
`,
        )
        return { bin, home, tmpdir, curlLog: path.join(dir, "curl.log") }
      },
    })

    const proc = Bun.spawn(["bash", path.join(import.meta.dir, "../../../../install"), "--no-modify-path"], {
      env: {
        ...process.env,
        PATH: `${tmp.extra.bin}:${process.env.PATH}`,
        HOME: tmp.extra.home,
        TMPDIR: tmp.extra.tmpdir,
        SHELL: "/bin/zsh",
        MIMO_TEST_CURL_LOG: tmp.extra.curlLog,
      },
      stderr: "pipe",
      stdout: "pipe",
    })

    expect(await proc.exited).toBe(0)
    expect(await Bun.file(path.join(tmp.extra.home, ".mimocode/bin/mimo")).exists()).toBe(true)
    expect(await Bun.file(tmp.extra.curlLog).text()).toContain("releases/latest/download")
    expect(await Bun.file(tmp.extra.curlLog).text()).not.toContain("api.github.com")
  })
})
