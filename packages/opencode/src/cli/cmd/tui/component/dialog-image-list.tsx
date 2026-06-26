import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Global } from "@/global"
import { createResource, onCleanup } from "solid-js"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { BUILTIN_BGS } from "./bg-registry"
import { useTheme } from "../context/theme"

const BG_DIR = path.join(Global.Path.config, "backgrounds")
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const NONE_VALUE = "__mimocode_image_none__"
export const SOLID_VALUE = "__mimocode_image_solid__"
const IMPORT_VALUE = "__mimocode_image_import__"

async function listBackgrounds() {
  await fs.mkdir(BG_DIR, { recursive: true }).catch(() => {})
  const items = await fs.readdir(BG_DIR).catch(() => [] as string[])
  return items
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

function expandHome(p: string) {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

export function DialogImageList() {
  const dialog = useDialog()
  const kv = useKV()
  const toast = useToast()
  const { t } = useLanguage()
  const [files] = createResource(listBackgrounds)
  const initial = kv.get("background_image")
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) kv.set("background_image", initial)
  })

  const hexColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

  const pickColor = async () => {
    const current = kv.get("background_color")
    const raw = await DialogPrompt.show(dialog, t("tui.dialog.image.solid"), {
      placeholder: t("tui.dialog.image.solid.prompt"),
      value: typeof current === "string" && hexColor.test(current) ? current : "#1a1b26",
    })
    if (raw === null) return
    const color = raw.trim()
    if (!hexColor.test(color)) {
      toast.show({ message: t("tui.dialog.image.solid.invalid"), variant: "error" })
      return
    }
    kv.set("background_color", color)
    kv.set("background_image", SOLID_VALUE)
    confirmed = true
    dialog.clear()
  }

  const importImage = async () => {
    const raw = await DialogPrompt.show(dialog, t("tui.dialog.image.import.title"), {
      placeholder: t("tui.dialog.image.import.placeholder"),
    })
    if (raw === null) return
    const src = expandHome(raw.trim().replace(/^['"]|['"]$/g, ""))
    if (!src) return
    if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) {
      toast.show({ message: t("tui.dialog.image.import.invalid"), variant: "error" })
      return
    }
    if (!(await Bun.file(src).exists())) {
      toast.show({ message: t("tui.dialog.image.import.not_found"), variant: "error" })
      return
    }
    await fs.mkdir(BG_DIR, { recursive: true })
    const base = path.basename(src)
    const dst = path.join(BG_DIR, base)
    await fs.copyFile(src, dst).catch((err) => {
      toast.show({ message: String(err), variant: "error" })
      throw err
    })
    kv.set("background_image", base)
    toast.show({ message: t("tui.dialog.image.import.success"), variant: "info" })
  }

  const options = (): DialogSelectOption<string>[] => {
    const list: DialogSelectOption<string>[] = [
      {
        title: t("tui.dialog.image.import.option"),
        value: IMPORT_VALUE,
        onSelect: () => {
          void importImage()
        },
      },
    ]
    for (const f of files() ?? []) list.push({ title: f, value: f })
    for (const bg of BUILTIN_BGS) {
      list.push({ title: t(bg.i18nKey), value: bg.value })
    }
    list.push({ title: t("tui.dialog.image.solid"), value: SOLID_VALUE })
    list.push({ title: t("tui.dialog.image.none"), value: NONE_VALUE })
    return list
  }

  return (
    <DialogSelect
      title={t("tui.dialog.image.title")}
      options={options()}
      current={initial}
      onMove={(opt) => {
        // 只在 onSelect 确认时才实际切换背景，避免方向键预览导致动画组件频繁卸载/挂载引起黑屏
      }}
      onSelect={(opt) => {
        if (opt.value === IMPORT_VALUE) return
        if (opt.value === SOLID_VALUE) {
          void pickColor()
          return
        }
        if (opt.value === NONE_VALUE) {
          kv.set("background_image", undefined)
        } else {
          kv.set("background_image", opt.value)
        }
        confirmed = true
        dialog.clear()
      }}
    />
  )
}
