import { spawn } from 'node:child_process';
import { log } from './events.js';

/**
 * Windows のトースト通知。追加モジュール不要で、PowerShell の WinRT 経由で出す。
 * 失敗しても本体の動作には影響させない。
 */
let lastKey = '';
let lastAt = 0;

export function toast(title: string, body: string, key = ''): void {
  if (process.platform !== 'win32') return;
  const now = Date.now();
  if (key && key === lastKey && now - lastAt < 60_000) return; // 同じ内容の連打を抑える
  lastKey = key;
  lastAt = now;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(@'\n${xml}\n'@)`,
    '$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
    p.on('error', (e) => log(`[notify] toast failed: ${e.message}`));
  } catch (e) {
    log(`[notify] toast failed: ${(e as Error).message}`);
  }
}
