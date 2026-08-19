import { firebaseConfig } from "./firebase-config.js";

const V = "10.12.5";
const $ = (id) => document.getElementById(id);

/* ---------- 設定チェック ---------- */
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  $("setup").hidden = false;
  throw new Error("firebase-config.js が未設定です");
}

const { initializeApp } =
  await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup,
  signOut, updateProfile, setPersistence, browserLocalPersistence
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, getDoc, updateDoc, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, arrayUnion
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// オフラインでも直近のログを読めるように、端末側にキャッシュを持たせる
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
await setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ============================================================
   エラー表示（黙って失敗させない）
   ============================================================ */
const EMPTY_HTML = $("empty").innerHTML;

function showError(what, e) {
  const code = e?.code || "error";
  const msg = e?.message || String(e);
  // 複合インデックスが無いときは、作成用の URL が message に入っている。
  // URL はそのまま出すと長すぎるので本文から外し、リンクとして添える
  const url = msg.match(/https:\/\/console\.firebase\.google\.com\/\S+/)?.[0];
  const link = $("err-link");
  link.hidden = !url;
  if (url) link.href = url.replace(/[).,]+$/, "");

  $("err-code").textContent = code;
  $("err-text").textContent = `${what}。${url ? msg.replace(url, "").trim() : msg}`;
  $("err").hidden = false;
  $("side-msg").textContent = `${what}（${code}）`;
  console.error(what, e);
}

function clearError() {
  $("err").hidden = true;
  $("err-link").hidden = true;
}

/* ============================================================
   状態
   ============================================================ */
let me = null;          // 現在のユーザー
let rooms = [];         // 参加中のプロジェクト
let roomId = null;      // 表示中のプロジェクト
let stopRooms = null;   // 購読解除関数
let stopMsgs = null;
let review = false;     // レビュー表示中か
let stopProfile = null; // 既読情報の購読解除
let reads = {};         // roomId -> 最終既読時刻(ms)
let shown = [];         // いま描画しているログ
let replyTo = null;     // 引用中の発言
let attachment = null;  // 添付待ちのファイル
let jumpBottom = false; // 次の描画で末尾へ送るか

// Firestore の 1 ドキュメント上限は 1MiB。base64 で約 1.34 倍になるぶんを見込む
const MAX_FILE = 680 * 1024;
const kb = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const LAST_ROOM = "tasklog:last-room";
const DRAFT = (id) => `tasklog:draft:${id}`;

/* ============================================================
   サインイン画面
   ============================================================ */
let mode = "signin";

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    mode = t.dataset.mode;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-on", x === t));
    $("f-name").hidden = mode !== "signup";
    $("btn-auth").textContent = mode === "signup" ? "登録して開始" : "サインイン";
    $("in-pass").autocomplete = mode === "signup" ? "new-password" : "current-password";
    $("auth-msg").textContent = "";
  });
});

const authError = (e) => ({
  "auth/invalid-email": "メールアドレスの形式が正しくありません。",
  "auth/missing-password": "パスワードを入力してください。",
  "auth/weak-password": "パスワードは6文字以上にしてください。",
  "auth/email-already-in-use": "このメールアドレスは登録済みです。サインインに切り替えてください。",
  "auth/invalid-credential": "メールアドレスまたはパスワードが一致しません。",
  "auth/popup-closed-by-user": "ウィンドウが閉じられたため中断しました。",
  "auth/unauthorized-domain": "このドメインは Firebase の承認済みドメインに未登録です。"
}[e.code] || `サインインできませんでした（${e.code || e.message}）。`);

$("btn-auth").addEventListener("click", async () => {
  const mail = $("in-mail").value.trim();
  const pass = $("in-pass").value;
  const name = $("in-name").value.trim();
  $("auth-msg").textContent = "";
  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, mail, pass);
      await updateProfile(cred.user, { displayName: name || mail.split("@")[0] });
      await saveProfile(cred.user, name);
    } else {
      await signInWithEmailAndPassword(auth, mail, pass);
    }
  } catch (e) { $("auth-msg").textContent = authError(e); }
});

$("btn-google").addEventListener("click", async () => {
  $("auth-msg").textContent = "";
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await saveProfile(cred.user);
  } catch (e) { $("auth-msg").textContent = authError(e); }
});

$("in-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-auth").click(); });
$("btn-out").addEventListener("click", () => signOut(auth));

async function saveProfile(user, name) {
  await setDoc(doc(db, "profiles", user.uid), {
    name: name || user.displayName || user.email.split("@")[0],
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/* ============================================================
   認証状態の切り替え
   ============================================================ */
onAuthStateChanged(auth, (user) => {
  stopRooms?.(); stopMsgs?.(); stopProfile?.();
  stopRooms = stopMsgs = stopProfile = null;
  clearError();
  me = user;

  if (!user) {
    resetWorkspace();
    $("app").hidden = true;
    $("auth").hidden = false;
    return;
  }
  $("auth").hidden = true;
  $("app").hidden = false;
  $("me").textContent = user.displayName || user.email;
  $("me-uid").textContent = user.uid;
  // setDoc はオフライン時、書き込みがサーバーに届くまで解決しない。ここで await すると
  // 一覧の購読が始まらないまま止まってしまうので、待たずに走らせて失敗だけ拾う
  saveProfile(user).catch((e) => showError("表示名を保存できませんでした", e));
  watchProfile();
  watchRooms();
});

// 別アカウントで入り直したときに前の表示が残らないようにする
function resetWorkspace() {
  rooms = [];
  roomId = null;
  $("rooms").innerHTML = "";
  $("crumb").textContent = "プロジェクト未選択";
  $("compose").hidden = true;
  $("me-uid").textContent = "";
  $("side-msg").textContent = "";
  $("btn-copy").hidden = true;
  reads = {}; shown = [];
  setReply(null); clearAttach();
  $("log").querySelectorAll(".row,.day").forEach((n) => n.remove());
  $("empty").innerHTML = EMPTY_HTML;
  $("empty").hidden = false;
}

/* ============================================================
   未読の管理
   ------------------------------------------------------------
   既読位置は profiles/{uid}.reads に置く。端末を変えても引き継げる
   ============================================================ */
function watchProfile() {
  stopProfile = onSnapshot(doc(db, "profiles", me.uid), (snap) => {
    // 書き込み直後はサーバー時刻が未確定なので、推定値で埋めて表示のちらつきを防ぐ
    const r = snap.data({ serverTimestamps: "estimate" })?.reads || {};
    reads = {};
    for (const [k, v] of Object.entries(r)) reads[k] = v?.toMillis?.() ?? 0;
    drawRooms();
  }, (e) => console.warn("既読情報を取得できません", e));
}

const isUnread = (r) => {
  const last = r.lastAt?.toMillis?.() ?? 0;
  return last > 0 && r.lastBy !== me?.uid && last > (reads[r.id] ?? 0);
};

function markRead(id) {
  if (!id || !me) return;
  reads[id] = Date.now();
  drawRooms();
  setDoc(doc(db, "profiles", me.uid), { reads: { [id]: serverTimestamp() } }, { merge: true })
    .catch((e) => console.warn("既読を保存できません", e));
}

let touchWarned = false;
// 未読判定のため、送信のたびにプロジェクト側へ最終更新を書き戻す
function touchRoom(id) {
  updateDoc(doc(db, "rooms", id), { lastAt: serverTimestamp(), lastBy: me.uid })
    .catch((e) => {
      if (touchWarned) return;
      touchWarned = true;
      showError("未読表示を更新できません（firestore.rules を貼り直してください）", e);
    });
}

/* ============================================================
   プロジェクト（＝チャットルーム）
   ============================================================ */
function watchRooms() {
  const q = query(
    collection(db, "rooms"),
    where("members", "array-contains", me.uid),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  stopRooms = onSnapshot(q, (snap) => {
    rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    drawRooms();
    const saved = localStorage.getItem(LAST_ROOM);
    if (!roomId && rooms.length) openRoom(rooms.some(r => r.id === saved) ? saved : rooms[0].id);
  }, (e) => showError("プロジェクト一覧を取得できません", e));
}

function drawRooms() {
  const ul = $("rooms");
  ul.innerHTML = "";
  for (const r of rooms) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const unread = isUnread(r);
    b.className = (r.id === roomId ? "is-on" : "") + (unread ? " has-new" : "");
    b.innerHTML = `<span class="code">${r.id}</span><span class="nm"></span>` +
      (unread ? `<span class="new" title="新しい記録があります">新着</span>` : "");
    b.querySelector(".nm").textContent = r.name;
    b.addEventListener("click", () => { openRoom(r.id); $("side").classList.remove("is-open"); });
    li.appendChild(b);
    ul.appendChild(li);
  }
}

const newCode = () => {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return "TL-" + Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((n) => cs[n % cs.length]).join("");
};

$("btn-new").addEventListener("click", async () => {
  const name = $("in-room").value.trim();
  if (!name) return ($("side-msg").textContent = "プロジェクト名を入力してください。");
  const id = newCode();
  try {
    await setDoc(doc(db, "rooms", id), {
      name, members: [me.uid], createdAt: serverTimestamp(), createdBy: me.uid
    });
  } catch (e) { return showError("プロジェクトを作成できませんでした", e); }
  $("in-room").value = "";
  $("side-msg").textContent = `参加コード ${id} を友達に共有してください。`;
  openRoom(id);
});

$("btn-join").addEventListener("click", async () => {
  const id = $("in-room").value.trim().toUpperCase();
  if (!id) return ($("side-msg").textContent = "参加コードを入力してください。");
  let snap;
  try {
    snap = await getDoc(doc(db, "rooms", id));
    if (!snap.exists()) return ($("side-msg").textContent = "そのコードのプロジェクトは見つかりません。");
    await updateDoc(doc(db, "rooms", id), { members: arrayUnion(me.uid) });
  } catch (e) { return showError("プロジェクトに参加できませんでした", e); }
  $("in-room").value = "";
  $("side-msg").textContent = "";
  openRoom(id);
});

/* ============================================================
   ログの購読と描画
   ============================================================ */
function openRoom(id) {
  if (roomId === id) return;
  saveDraft();
  stopMsgs?.();
  roomId = id;
  localStorage.setItem(LAST_ROOM, id);
  drawRooms();

  const room = rooms.find((r) => r.id === id);
  $("crumb").textContent = room ? `${id} / ${room.name}` : id;
  $("empty").hidden = true;
  $("compose").hidden = false;
  $("btn-copy").hidden = false;
  $("in-msg").value = localStorage.getItem(DRAFT(id)) || "";
  $("draft-note").textContent = $("in-msg").value ? "下書きを復元しました" : "";
  fitArea();

  // 切り替えたら、そのプロジェクトのログを最新の位置で開き直す
  shown = [];
  $("log").querySelectorAll(".row,.day").forEach((n) => n.remove());
  jumpBottom = true;
  $("side").classList.remove("is-open");
  setReply(null); clearAttach();
  markRead(id);
  if (matchMedia("(min-width:721px)").matches) area.focus();

  // 直近 400 件を取りたいので降順で取得し、描画前に時系列へ戻す
  const q = query(collection(db, "rooms", id, "messages"), orderBy("createdAt", "desc"), limit(400));
  stopMsgs = onSnapshot(q, (snap) => {
    drawLog(snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse());
    if (document.visibilityState === "visible") markRead(id);
  }, (e) => showError("ログを取得できません", e));
}

const fmtDay = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function drawLog(list) {
  const log = $("log");
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  // #empty は使い回すので消さない（消すと openRoom が参照できなくなる）
  log.querySelectorAll(".row,.day").forEach((n) => n.remove());

  const empty = $("empty");
  if (!list.length) {
    empty.innerHTML = `<p class="eyebrow">NO ENTRIES</p>
      <p>まだ記録がありません。最初の一件を書き込んでみてください。</p>`;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  shown = list;

  let day = "";
  for (const m of list) {
    const at = m.createdAt?.toDate?.() ?? new Date();
    const d = fmtDay(at);
    if (d !== day) {
      day = d;
      const h = document.createElement("div");
      h.className = "day eyebrow";
      h.textContent = d;
      log.appendChild(h);
    }

    const mine = m.uid === me.uid;
    const row = document.createElement("article");
    row.className = "row" + (mine ? " row--mine" : "");
    row.dataset.id = m.id;
    row.innerHTML = `
      <div class="row__head">
        <span class="row__who"></span>
        <span class="row__at">${fmtTime(at)}</span>
        <span class="chip ${mine ? "" : "chip--dim"}">${mine ? "自分" : "更新"}</span>
        <button class="row__act" data-reply="${m.id}">引用</button>
      </div>
      <div class="row__body"></div>`;
    row.querySelector(".row__who").textContent = m.name || "不明";
    row.querySelector(".row__body").textContent = m.text || "";
    if (!m.text) row.querySelector(".row__body").hidden = true;

    if (m.replyTo) row.insertBefore(quoteNode(m.replyTo), row.querySelector(".row__body"));
    if (m.file) row.appendChild(fileNode(m.file));

    log.appendChild(row);
  }
  if (stick || jumpBottom) log.scrollTop = log.scrollHeight;
  jumpBottom = false;
}

/* ============================================================
   引用（特定の発言への返信）
   ============================================================ */
function quoteNode(q) {
  const el = document.createElement("button");
  el.className = "quote";
  el.dataset.to = q.id || "";
  el.innerHTML = `<span class="quote__who"></span><span class="quote__text"></span>`;
  el.querySelector(".quote__who").textContent = q.name || "不明";
  el.querySelector(".quote__text").textContent = q.text || "";
  return el;
}

function setReply(m) {
  replyTo = m
    ? {
        id: m.id,
        name: m.name || "不明",
        text: (m.text || (m.file ? `［ファイル］${m.file.name}` : "")).slice(0, 120)
      }
    : null;
  $("reply-box").hidden = !replyTo;
  if (!replyTo) return;
  $("reply-who").textContent = replyTo.name;
  $("reply-text").textContent = replyTo.text;
  area.focus();
}

function jumpTo(id) {
  const el = $("log").querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (!el) return ($("draft-note").textContent = "引用元は表示範囲にありません。");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("row--flash");
  setTimeout(() => el.classList.remove("row--flash"), 1200);
}

$("log").addEventListener("click", (ev) => {
  const rep = ev.target.closest("[data-reply]");
  if (rep) return setReply(shown.find((x) => x.id === rep.dataset.reply));
  const q = ev.target.closest(".quote[data-to]");
  if (q && q.dataset.to) jumpTo(q.dataset.to);
});
$("reply-cancel").addEventListener("click", () => setReply(null));

/* ============================================================
   ファイル共有
   ------------------------------------------------------------
   実体は rooms/{id}/files に置き、ログ本体には名前とサイズだけ載せる。
   ログを開くたびに全ファイルを読み込まずに済む
   ============================================================ */
const fileCache = new Map();

function loadFile(rid, id) {
  const key = `${rid}/${id}`;
  if (!fileCache.has(key)) {
    fileCache.set(key, getDoc(doc(db, "rooms", rid, "files", id)).then((s) => s.data()?.data || ""));
  }
  return fileCache.get(key);
}

function fileNode(f) {
  const rid = roomId;
  const wrap = document.createElement("div");
  wrap.className = "att";

  if ((f.type || "").startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "att__img";
    img.alt = f.name;
    wrap.appendChild(img);
    loadFile(rid, f.id).then((d) => { if (d) img.src = d; }).catch(() => {});
  }

  const btn = document.createElement("button");
  btn.className = "att__dl";
  btn.textContent = `${f.name}（${kb(f.size || 0)}）を保存`;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const data = await loadFile(rid, f.id);
      if (!data) throw new Error("ファイルの実体が見つかりません");
      const a = document.createElement("a");
      a.href = data;
      a.download = f.name;
      a.click();
    } catch (e) { showError("ファイルを取得できませんでした", e); }
    btn.disabled = false;
  });
  wrap.appendChild(btn);
  return wrap;
}

function clearAttach() {
  attachment = null;
  $("attach").hidden = true;
  $("attach-name").textContent = "";
  $("in-file").value = "";
}

$("btn-file").addEventListener("click", () => $("in-file").click());
$("attach-cancel").addEventListener("click", clearAttach);

$("in-file").addEventListener("change", () => {
  const f = $("in-file").files?.[0];
  if (!f) return;
  if (f.size > MAX_FILE) {
    $("in-file").value = "";
    $("draft-note").textContent = `添付は ${kb(MAX_FILE)} までです（選択したファイル: ${kb(f.size)}）。`;
    return;
  }
  const fr = new FileReader();
  fr.onload = () => {
    attachment = {
      name: f.name, type: f.type || "application/octet-stream", size: f.size, data: fr.result
    };
    $("attach-name").textContent = `${f.name}（${kb(f.size)}）`;
    $("attach").hidden = false;
    $("draft-note").textContent = "";
  };
  fr.onerror = () => { $("draft-note").textContent = "ファイルを読み込めませんでした。"; };
  fr.readAsDataURL(f);
});

/* ============================================================
   送信・下書き
   ============================================================ */
const area = $("in-msg");

function fitArea() {
  area.style.height = "auto";
  area.style.height = Math.min(area.scrollHeight, 140) + "px";
}
function saveDraft() {
  if (!roomId) return;
  const v = area.value;
  v ? localStorage.setItem(DRAFT(roomId), v) : localStorage.removeItem(DRAFT(roomId));
}

area.addEventListener("input", () => { fitArea(); saveDraft(); $("draft-note").textContent = ""; });
window.addEventListener("beforeunload", saveDraft);
document.addEventListener("visibilitychange", saveDraft);

area.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});
$("btn-send").addEventListener("click", send);

async function send() {
  const text = area.value.trim();
  if ((!text && !attachment) || !roomId) return;

  const rid = roomId;
  const pending = attachment;
  const reply = replyTo;
  area.value = "";
  localStorage.removeItem(DRAFT(rid));
  clearAttach();
  setReply(null);
  fitArea();

  const body = {
    text, uid: me.uid,
    name: me.displayName || me.email.split("@")[0],
    createdAt: serverTimestamp()
  };
  if (reply) body.replyTo = reply;

  if (pending) {
    // ID だけ先に採番して書き込みは待たない（オフライン時に止まらないように）
    const fref = doc(collection(db, "rooms", rid, "files"));
    setDoc(fref, {
      name: pending.name, type: pending.type, size: pending.size,
      data: pending.data, uid: me.uid, createdAt: serverTimestamp()
    }).catch((e) => showError("ファイルを保存できませんでした", e));
    fileCache.set(`${rid}/${fref.id}`, Promise.resolve(pending.data));
    body.file = { id: fref.id, name: pending.name, type: pending.type, size: pending.size };
  }

  touchRoom(rid);
  try {
    await addDoc(collection(db, "rooms", rid, "messages"), body);
  } catch (e) {
    area.value = text;               // 失敗しても入力を失わない
    saveDraft(); fitArea();
    setReply(reply);
    $("draft-note").textContent = "送信できませんでした。通信を確認して再度お試しください。";
  }
}

/* ---------- 参加コードのコピー ---------- */
$("btn-copy").addEventListener("click", async () => {
  if (!roomId) return;
  try {
    await navigator.clipboard.writeText(roomId);
  } catch {
    // クリップボード API が使えない環境向けの逃げ道
    const t = document.createElement("textarea");
    t.value = roomId;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  const b = $("btn-copy");
  b.textContent = "複写しました";
  setTimeout(() => (b.textContent = "コード複写"), 1400);
});

/* ============================================================
   レビュー表示（Esc で本文を伏せる）
   ============================================================ */
function setReview(on) {
  review = on;
  document.body.classList.toggle("is-review", on);
  $("btn-review").classList.toggle("chip--warn", on);
  $("btn-review").textContent = on ? "レビュー表示 中" : "レビュー表示";
  if (!on) area.focus();
}
$("btn-review").addEventListener("click", () => setReview(!review));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("app").hidden) { e.preventDefault(); setReview(!review); }
});

/* ---------- モバイルのサイドバー ---------- */
$("btn-nav").addEventListener("click", () => $("side").classList.toggle("is-open"));
$("log").addEventListener("click", () => $("side").classList.remove("is-open"));
