// What differs per OS: the desktop notification and where VS Code is. Pure (argv in, argv out) so it runs under test; server.mjs spawns.
import { join, win32, posix } from 'node:path'

// Command for a desktop notification, or null when the platform has none we know.
export function notifyCommand(platform, title, text, here) {
  if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'notify.ps1')], env: { CC_TITLE: title, CC_TEXT: text } }
  // Title and text travel as argv, not inside the AppleScript source: no quoting to get wrong.
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "default"', '-e', 'end run', title, text], env: {} }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--app-name=cc-suricata', '--', title, text], env: {} }
  return null
}

// VS Code on the PATH: on Windows the real Code.exe next to the PATH entry (bin\code.cmd would need cmd.exe); elsewhere the `code` launcher.
export function findVsCode(platform, path, exists) {
  const { join: joinAs, delimiter } = platform === 'win32' ? win32 : posix // the target platform's rules, whatever the host
  const candidate = (dir) => (platform === 'win32' ? joinAs(dir, '..', 'Code.exe') : joinAs(dir, 'code'))
  return path.split(delimiter).filter(Boolean).map(candidate).find(exists) ?? null
}
