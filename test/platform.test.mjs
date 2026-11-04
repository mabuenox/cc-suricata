import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { notifyCommand, findVsCode } from '../platform.mjs'

test('notifyCommand: one notifier per platform, text passed as arguments (never quoted into a script)', () => {
  const title = 'acme-shop: is asking you'
  const text = `Ascending or "descending"? \\ 'quotes'`
  const win = notifyCommand('win32', title, text, 'C:\\suricata')
  assert.deepEqual([win.cmd, win.args.at(-1), win.env], ['powershell.exe', join('C:\\suricata', 'notify.ps1'), { CC_TITLE: title, CC_TEXT: text }])
  const mac = notifyCommand('darwin', title, text, '/suricata')
  assert.deepEqual([mac.cmd, mac.args.slice(-2)], ['osascript', [title, text]])
  const linux = notifyCommand('linux', title, text, '/suricata')
  assert.deepEqual([linux.cmd, linux.args.slice(-3)], ['notify-send', ['--', title, text]])
  assert.equal(notifyCommand('freebsd', title, text, '/suricata'), null)
})

test('findVsCode: Code.exe next to the PATH entry on Windows, the `code` launcher elsewhere, null when absent', () => {
  const codeExe = 'C:\\Program Files\\Microsoft VS Code\\Code.exe' // Windows separators whatever the host: the lookup follows the target platform
  const exists = (p) => [codeExe, '/usr/local/bin/code'].includes(p)
  assert.equal(findVsCode('win32', 'C:\\Windows;C:\\Program Files\\Microsoft VS Code\\bin', exists), codeExe)
  assert.equal(findVsCode('darwin', '/usr/bin:/usr/local/bin', exists), '/usr/local/bin/code')
  assert.equal(findVsCode('linux', '/usr/bin::', exists), null)
})
