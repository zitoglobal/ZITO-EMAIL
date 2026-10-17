import { api } from './api.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('[sw]', e.message);
    return null;
  }
}

export async function enableWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('当前浏览器不支持推送');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('未授予通知权限');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
  if (!reg) throw new Error('Service Worker 注册失败');
  const { publicKey } = await api('/push/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return true;
}

export async function disableWebPush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint } }).catch(() => {});
  } else {
    await api('/push/unsubscribe', { method: 'POST', body: {} }).catch(() => {});
  }
}

export async function pushStatus() {
  try {
    return await api('/push/status');
  } catch {
    return { subscriptions: [] };
  }
}
