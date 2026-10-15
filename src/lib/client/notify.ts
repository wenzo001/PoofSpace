export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function currentPermission(): NotifyPermission {
  if (!supported()) return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotifyPermission> {
  if (!supported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

const TITLE = '收到一条加密消息';

/**
 * Foreground notifications are suppressed entirely and the body is a fixed phrase:
 * neither message text nor filenames may ever reach the notification surface.
 */
export function notifyEncrypted(): void {
  if (!supported() || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const n = new Notification(TITLE, { body: '', tag: 'poofspace-room', silent: false });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* notification construction can fail on some platforms; never block chat */
  }
}
