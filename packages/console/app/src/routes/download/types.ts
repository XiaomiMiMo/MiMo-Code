export type DownloadPlatform =
  | `darwin-${"x64" | "arm64"}-zip`
  | "windows-x64-zip"
  | `linux-${"x64" | "arm64"}-tar`
