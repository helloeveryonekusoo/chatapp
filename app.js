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
   状態
   ============================================================ */
let me = null;          // 現在のユーザー
let rooms = [];         // 参加中のプロジェクト
let roomId = null;      // 表示中のプロジェクト
let stopRooms = null;   // 購読解除関数
let stopMsgs = null;
let review = false;     // レビュー表示中か

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
onAuthStateChanged(auth, async (user) => {
  stopRooms?.(); stopMsgs?.();
  stopRooms = stopMsgs = null;
  me = user;

  if (!user) {
    $("app").hidden = true;
    $("auth").hidden = false;
    return;
  }
  $("auth").hidden = true;
  $("app").hidden = false;
  $("me").textContent = user.displayName || user.email;
  await saveProfile(user);
  watchRooms();
});

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
  }, (e) => { $("side-msg").textContent = "一覧を取得できません（" + e.code + "）"; });
}

function drawRooms() {
  const ul = $("rooms");
  ul.innerHTML = "";
  for (const r of rooms) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = r.id === roomId ? "is-on" : "";
    b.innerHTML = `<span class="code">${r.id}</span><span class="nm"></span>`;
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
  await setDoc(doc(db, "rooms", id), {
    name, members: [me.uid], createdAt: serverTimestamp(), createdBy: me.uid
  });
  $("in-room").value = "";
  $("side-msg").textContent = `参加コード ${id} を友達に共有してください。`;
  openRoom(id);
});

$("btn-join").addEventListener("click", async () => {
  const id = $("in-room").value.trim().toUpperCase();
  if (!id) return ($("side-msg").textContent = "参加コードを入力してください。");
  const snap = await getDoc(doc(db, "rooms", id));
  if (!snap.exists()) return ($("side-msg").textContent = "そのコードのプロジェクトは見つかりません。");
  await updateDoc(doc(db, "rooms", id), { members: arrayUnion(me.uid) });
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
  $("in-msg").value = localStorage.getItem(DRAFT(id)) || "";
  $("draft-note").textContent = $("in-msg").value ? "下書きを復元しました" : "";
  fitArea();

  const q = query(collection(db, "rooms", id, "messages"), orderBy("createdAt", "asc"), limit(400));
  stopMsgs = onSnapshot(q, (snap) => {
    drawLog(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (e) => { $("log").textContent = "ログを取得できません（" + e.code + "）"; });
}

// doc ID から見た目用の連番風 ID をつくる（表示だけの用途）
const ticket = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 10000;
  return "#" + String(h).padStart(4, "0");
};

const fmtDay = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function drawLog(list) {
  const log = $("log");
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.innerHTML = "";

  if (!list.length) {
    log.innerHTML = `<div class="empty"><p class="eyebrow">NO ENTRIES</p>
      <p>まだ記録がありません。最初の一件を書き込んでみてください。</p></div>`;
    return;
  }

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
    row.innerHTML = `
      <div class="row__id">${ticket(m.id)}</div>
      <div>
        <div class="row__head">
          <span class="row__who"></span>
          <span class="row__at">${fmtTime(at)}</span>
          <span class="chip ${mine ? "" : "chip--dim"}">${mine ? "自分" : "更新"}</span>
        </div>
        <div class="row__body"></div>
      </div>`;
    row.querySelector(".row__who").textContent = m.name || "不明";
    row.querySelector(".row__body").textContent = m.text;
    log.appendChild(row);
  }
  if (stick) log.scrollTop = log.scrollHeight;
}

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
  if (!text || !roomId) return;
  area.value = "";
  localStorage.removeItem(DRAFT(roomId));
  fitArea();
  try {
    await addDoc(collection(db, "rooms", roomId, "messages"), {
      text, uid: me.uid,
      name: me.displayName || me.email.split("@")[0],
      createdAt: serverTimestamp()
    });
  } catch (e) {
    area.value = text;               // 失敗しても入力を失わない
    saveDraft(); fitArea();
    $("draft-note").textContent = "送信できませんでした。通信を確認して再度お試しください。";
  }
}

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
