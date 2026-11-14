/**
 * Which Codex build this machine runs. One table for the client (bundled and
 * node_modules binaries) and the updater (npm version tags, the binary
 * inside a downloaded tarball), so they cannot disagree.
 *
 * The triples are read off the published tarballs
 * (package/vendor/<triple>/bin/codex[.exe]). Windows was pinned to
 * x86_64-pc-windows-msvc, so ARM Windows looked for the x64 binary inside
 * the ARM package and found nothing.
 */
export interface CodexPlatform {
  /** npm version tag suffix: 0.153.4-<tag> */
  tag: string
  /** the per-platform npm package @openai/codex depends on (an alias of a tagged version) */
  pkg: string
  /** Rust target triple: the directory under package/vendor/ */
  triple: string
  exe: string
  /** file name of a build-time copy in resources/bin */
  bundled: string
}

const TRIPLES: Record<string, Record<string, string>> = {
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
}

const SHORT: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' }

export function codexPlatform(platform: string, arch: string): CodexPlatform | null {
  const triple = TRIPLES[platform]?.[arch]
  if (!triple) return null
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  return {
    tag: `${platform}-${arch}`,
    pkg: `codex-${platform}-${arch}`,
    triple,
    exe,
    bundled: `codex-${SHORT[platform]}-${arch}${platform === 'win32' ? '.exe' : ''}`,
  }
}
