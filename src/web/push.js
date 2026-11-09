// @ts-check
// Push: notifications on a phone that is locked, from the computer.
import { TEXT } from "./text.js";
import { switchRow } from "./pieces.js";
import { post, run } from "./server.js";
import { ON_THIS_MACHINE } from "./state.js";

/** Whether this device is subscribed; null until known. @type {boolean | null} */
export let pushOn = null;
/** @type {PushSubscription | null} */
let pushSubscription = null;
let pushRenewed = false;
const canPush = "serviceWorker" in navigator && "PushManager" in window;
/** Learns whether this phone is subscribed, then `known` redraws what shows it. @param {() => void} known */
export function watchPush(known) {
  if (canPush && !ON_THIS_MACHINE) {
    run(navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => ((pushOn = sub !== null), (pushSubscription = sub), known())));
  }
}
/** Once per load, when the desk answers: tells it this device has the PIN in, and until when (a new unlock reloads the page). */
export function renewPush() {
  if (pushRenewed || !pushSubscription) return;
  pushRenewed = true;
  run(post("/api/push/subscribe", pushSubscription.toJSON()));
}
/**
 * The row that subscribes this phone; on iOS push exists only in the app added to the Home Screen.
 * @param {() => void} changed redraws the menu that holds it
 */
export function pushRow(changed) {
  return switchRow(
    "push",
    TEXT.alerts.push,
    (box) => run((box.checked ? subscribePush() : unsubscribePush()).then(() => ((pushOn = box.checked), changed())), changed),
    { checked: pushOn === true, disabled: !canPush || pushOn === null, hint: canPush ? TEXT.alerts.pushHint : TEXT.alerts.pushInstall, off: !canPush },
  );
}
async function subscribePush() {
  // Asked first, inside the tap: iOS grants the permission only from a gesture.
  if ((await Notification.requestPermission()) !== "granted") throw new Error(TEXT.alerts.pushDenied);
  const res = await fetch("/api/push/key");
  if (!res.ok) throw new Error(`push key: ${res.status} ${res.statusText}`);
  const { key } = /** @type {{ key: string }} */ (await res.json());
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
  await post("/api/push/subscribe", sub.toJSON());
  pushSubscription = sub;
  pushRenewed = true;
}
async function unsubscribePush() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) return;
  await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
  pushSubscription = null;
}
