import { firebaseConfig } from "./firebase-config.js";
import { ROOM_PHOTOS, PLANS, HERO_PHOTO } from "./assets-data.js";
import { SEED_ROOMS } from "./seed-data.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

(function () {
  "use strict";

  var PHOTOS_ALBUM_URL = "https://photos.icloud.com/shared/album/0679GjzNsTuc5ZxbU4BYimLaw";

  // ---------- Firebase setup ----------

  var app = initializeApp(firebaseConfig);
  var auth = getAuth(app);
  var db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
  var roomsCol = collection(db, "rooms");

  // Local development only: when this page is opened from localhost, talk
  // to local Firebase emulators instead of the real project. Has no effect
  // once this is deployed to GitHub Pages (a real hostname).
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }

  var uid = null; // becomes non-null once signed in
  var everConnected = false;

  // ---------- local state ----------
  // state.rooms is the single source of truth for rendering. It is kept in
  // sync with Firestore in both directions: local edits are written out
  // (debounced, per room) and remote changes come back through the
  // onSnapshot listener below and get merged in — except for whichever
  // room the user currently has an open add/edit form on, so a live
  // update from Arjen's phone can never wipe out what you're mid-typing.

  var state = { rooms: [] };
  var seeded = false;

  var readOnly = false; // stays false; kept for minimal diff vs original UI code
  var addingItemFor = null;
  var addingRoom = false;
  var confirmDeleteRoom = null;
  var editingItem = null;
  var statusMsg = "";
  var roomPhotoIndex = {};
  var lightboxData = null; // {src, caption}

  function makeId(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtPrice(p) {
    if (p == null || p === "" || isNaN(p)) return "";
    return "€" + Number(p).toLocaleString("nl-NL", { maximumFractionDigits: 2 });
  }

  function tally() {
    var total = 0, bought = 0;
    state.rooms.forEach(function (r) { r.items.forEach(function (it) { total++; if (it.bought) bought++; }); });
    return { total: total, bought: bought };
  }

  var KEY_HANDOVER = Date.UTC(2026, 11, 1); // 1 December 2026

  function daysToHandover() {
    var now = new Date();
    var todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((KEY_HANDOVER - todayUTC) / 86400000);
  }

  function countdownChipHtml() {
    var d = daysToHandover();
    var num, lbl;
    if (d > 0) { num = d; lbl = (d === 1 ? "day" : "days") + " to key handover"; }
    else if (d === 0) { num = "🔑"; lbl = "Key handover is today!"; }
    else { num = Math.abs(d); lbl = "days since key handover"; }
    return '<div class="countdown-chip"><span class="num" id="countdown-num">' + num + '</span><span class="lbl">' + lbl + '<br>1 Dec 2026</span></div>';
  }

  function refreshCountdown() {
    var el = document.getElementById("countdown-num");
    if (!el) return;
    var d = daysToHandover();
    el.textContent = d > 0 ? d : (d === 0 ? "🔑" : Math.abs(d));
  }

  // ---------- image handling ----------

  function resizeImageFile(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- pure string rendering ----------

  function itemHtml(room, item) {
    var isEditing = editingItem && editingItem.roomId === room.id && editingItem.itemId === item.id;
    var thumbHtml = item.image
      ? '<div class="item-thumb has-photo" data-action="zoom-item" data-room="' + room.id + '" data-item="' + item.id + '"><img src="' + item.image + '" alt=""></div>'
      : ('<label class="item-thumb" title="Add a photo">+' + (readOnly ? '' : '<input type="file" accept="image/*" data-action="item-photo" data-room="' + room.id + '" data-item="' + item.id + '">') + '</label>');

    if (isEditing) {
      var editPhoto = item.image
        ? '<label class="photo-pick has-photo"><img src="' + item.image + '" alt="">Change photo<input type="file" accept="image/*" data-action="edit-photo" data-room="' + room.id + '" data-item="' + item.id + '"></label>'
        : '<label class="photo-pick">+ Add photo<input type="file" accept="image/*" data-action="edit-photo" data-room="' + room.id + '" data-item="' + item.id + '"></label>';
      return '' +
        '<li class="item editing">' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="edit-text" value="' + esc(item.text) + '" placeholder="Item"></div>' +
        '<div class="row">' +
        '<input type="url" class="edit-link" value="' + esc(item.link || "") + '" placeholder="Link (optional)">' +
        '<input type="text" class="edit-price price" value="' + esc(item.price != null ? item.price : "") + '" placeholder="Price">' +
        '</div>' +
        '<div class="buttons">' + editPhoto +
        '<span style="display:flex;gap:.4rem;">' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-edit">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-action="save-edit" data-room="' + room.id + '" data-item="' + item.id + '">Save</button>' +
        '</span>' +
        '</div>' +
        '</div>' +
        '</li>';
    }
    var linkHtml = item.link ? '<a class="link-btn" href="' + esc(item.link) + '" target="_blank" rel="noopener">link ↗</a>' : '';
    var priceHtml = (item.price != null && item.price !== "") ? '<span class="price-chip">' + esc(fmtPrice(item.price)) + '</span>' : '';
    return '' +
      '<li class="item' + (item.bought ? ' bought' : '') + '">' +
      '<input type="checkbox" class="check" ' + (item.bought ? 'checked' : '') + ' ' + (readOnly ? 'disabled' : '') +
      ' data-action="toggle" data-room="' + room.id + '" data-item="' + item.id + '" aria-label="Mark ' + esc(item.text) + ' as bought">' +
      thumbHtml +
      '<div class="item-body">' +
      '<div class="item-main">' + '<span class="item-text">' + esc(item.text) + '</span>' + priceHtml + '</div>' +
      (linkHtml ? '<div>' + linkHtml + '</div>' : '') +
      '</div>' +
      '<div class="item-actions">' +
      '<button type="button" class="icon-btn" data-action="edit" data-room="' + room.id + '" data-item="' + item.id + '" title="Edit" ' + (readOnly ? 'disabled' : '') + '>✎</button>' +
      '<button type="button" class="icon-btn danger" data-action="delete" data-room="' + room.id + '" data-item="' + item.id + '" title="Remove" ' + (readOnly ? 'disabled' : '') + '>✕</button>' +
      '</div>' +
      '</li>';
  }

  function roomPhotoHtml(room) {
    var photos = ROOM_PHOTOS[room.id] || [];
    if (!photos.length) {
      return '<div class="room-photo"><div class="room-photo-main no-photo">No advert photo</div></div>';
    }
    var idx = roomPhotoIndex[room.id] || 0;
    if (idx >= photos.length) idx = 0;
    var thumbs = photos.length > 1
      ? '<div class="room-thumbs">' + photos.map(function (src, i) {
        return '<button type="button" class="' + (i === idx ? 'active' : '') + '" data-action="room-photo" data-room="' + room.id + '" data-idx="' + i + '"><img src="' + src + '" alt=""></button>';
      }).join("") + '</div>'
      : '';
    return '' +
      '<div class="room-photo">' +
      '<div class="room-photo-main" data-action="zoom-room" data-room="' + room.id + '"><img src="' + photos[idx] + '" alt="' + esc(room.name) + '"></div>' +
      thumbs +
      '</div>';
  }

  function roomHtml(room) {
    var boughtCount = room.items.filter(function (i) { return i.bought; }).length;
    var tallyHtml = room.items.length ? ('<span class="room-tally">' + boughtCount + '/' + room.items.length + '</span>') : '';
    var itemsHtml = room.items.length
      ? room.items.map(function (it) { return itemHtml(room, it); }).join("")
      : '<div class="empty-hint">Nothing listed yet.</div>';

    var addRowHtml;
    if (addingItemFor === room.id) {
      addRowHtml = '' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="new-text" placeholder="Item name"></div>' +
        '<div class="row">' +
        '<input type="url" class="new-link" placeholder="Link (optional)">' +
        '<input type="text" class="new-price price" placeholder="Price">' +
        '</div>' +
        '<div class="buttons">' +
        '<label class="photo-pick" id="new-photo-pick" data-room="' + room.id + '">+ Add photo<input type="file" accept="image/*" data-action="new-photo" data-room="' + room.id + '"></label>' +
        '<span style="display:flex;gap:.4rem;">' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-add">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-action="confirm-add" data-room="' + room.id + '">Add</button>' +
        '</span>' +
        '</div>' +
        '</div>';
    } else {
      addRowHtml = '<button type="button" class="add-toggle" data-action="start-add" data-room="' + room.id + '" ' + (readOnly ? 'disabled' : '') + '>+ add item</button>';
    }

    var roomHeadRight;
    if (confirmDeleteRoom === room.id) {
      roomHeadRight = '' +
        '<span class="room-delete-confirm">' +
        '<span>Delete room?</span>' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-delete-room">No</button>' +
        '<button type="button" class="btn btn-danger" data-action="confirm-delete-room" data-room="' + room.id + '">Yes, delete</button>' +
        '</span>';
    } else {
      roomHeadRight = '<span style="display:flex; align-items:center;">' + tallyHtml + (readOnly ? '' : '<button type="button" class="room-delete-btn" data-action="start-delete-room" data-room="' + room.id + '" title="Delete room">✕</button>') + '</span>';
    }

    return '' +
      '<div class="room" data-room-id="' + room.id + '">' +
      roomPhotoHtml(room) +
      '<div class="room-content">' +
      '<div class="room-head"><h2>' + esc(room.name) + '</h2>' + roomHeadRight + '</div>' +
      (room.note ? '<div class="room-note">' + esc(room.note) + '</div>' : '') +
      '<ul class="items">' + itemsHtml + '</ul>' +
      '<div class="add-row">' + addRowHtml + '</div>' +
      '</div>' +
      '</div>';
  }

  function roomsGridHtml() { return state.rooms.map(roomHtml).join(""); }

  function plansHtml() {
    return '' +
      '<div class="plans-section">' +
      '<div class="plans-head"><h2>Floor plans</h2><a class="photos-link" href="' + PHOTOS_ALBUM_URL + '" target="_blank" rel="noopener">View all photos ↗</a></div>' +
      (PLANS.length ? '<div class="plans">' +
        PLANS.map(function (p, i) {
          return '<button type="button" class="plan-thumb" data-action="zoom-plan" data-idx="' + i + '"><img src="' + p.src + '" alt="' + esc(p.label) + '"><div class="plan-label">' + esc(p.label) + '</div></button>';
        }).join("") +
        '</div>' : '') +
      '</div>';
  }

  function wrapInnerHtml() {
    var t = tally();
    var pct = t.total ? Math.round(100 * t.bought / t.total) : 0;
    return '' +
      '<div class="hero"><img src="' + HERO_PHOTO + '" alt="Grenenhout 16"></div>' +
      '<div class="header-block">' +
      '<div class="header-top">' +
      '<h1>Grenenhout 16</h1>' +
      countdownChipHtml() +
      '</div>' +
      '<p class="subtitle">Room-by-room shopping list for the new house</p>' +
      '<div class="hero-progress">' +
      '<div class="count">' + t.bought + '<span> / ' + t.total + ' bought</span></div>' +
      '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '</div>' +
      '<div id="status-line">' + esc(statusMsg) + '</div>' +
      '</div>' +
      plansHtml() +
      '<div class="rooms" id="rooms">' + roomsGridHtml() + '</div>' +
      '<div class="add-room-block">' + (addingRoom ?
        '<div class="edit-form" style="max-width:26rem; margin:0 auto;">' +
        '<div class="row"><input type="text" id="new-room-name" placeholder="Room name"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" id="cancel-room-btn">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="confirm-room-btn">Add</button>' +
        '</div>' +
        '</div>'
        : '<button type="button" id="add-room-btn">+ add a room</button>') + '</div>';
  }

  function renderLightbox() {
    var lb = document.getElementById("lightbox");
    if (!lightboxData) { lb.classList.remove("show"); return; }
    document.getElementById("lightbox-img").src = lightboxData.src;
    document.getElementById("lightbox-caption").textContent = lightboxData.caption || "";
    lb.classList.add("show");
  }

  function render() {
    document.getElementById("wrap").innerHTML = wrapInnerHtml();
    renderLightbox();
    if (addingItemFor) {
      var input = document.querySelector('.room[data-room-id="' + addingItemFor + '"] .new-text');
      if (input) input.focus();
    }
    if (addingRoom) {
      var roomInput = document.getElementById("new-room-name");
      if (roomInput) roomInput.focus();
    }
  }

  // ---------- status line ----------

  function setStatus(msg) {
    statusMsg = msg || "";
    var el = document.getElementById("status-line");
    if (el) {
      el.textContent = statusMsg;
      var isWarn = statusMsg.indexOf("offline") === 0 || statusMsg.indexOf("couldn't") === 0;
      el.classList.toggle("status-warn", isWarn);
    }
  }

  // ---------- Firestore sync ----------

  function findRoom(id) { return state.rooms.find(function (r) { return r.id === id; }); }
  function findItem(room, id) { return room.items.find(function (i) { return i.id === id; }); }

  function isRoomBeingEdited(roomId) {
    return addingItemFor === roomId ||
      (editingItem && editingItem.roomId === roomId) ||
      confirmDeleteRoom === roomId;
  }

  var dirtyRooms = {}; // roomId -> true
  var deletedRooms = {}; // roomId -> true, so a lagging snapshot can't resurrect it
  var flushTimer = null;

  function markDirty(roomId) {
    dirtyRooms[roomId] = true;
    setStatus("saving…");
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushDirty, 500);
  }

  function roomDocData(room) {
    return { name: room.name, order: room.order, note: room.note || null, items: room.items };
  }

  function flushDirty() {
    flushTimer = null;
    var ids = Object.keys(dirtyRooms);
    dirtyRooms = {};
    if (!ids.length) return;
    Promise.all(ids.map(function (id) {
      var room = findRoom(id);
      if (!room) return Promise.resolve();
      return setDoc(doc(roomsCol, id), roomDocData(room));
    })).then(function () {
      setStatus("saved");
      setTimeout(function () { if (statusMsg === "saved") setStatus(""); }, 1200);
    }).catch(function (err) {
      console.error("save failed", err);
      // Firestore's own offline queue already retries writes once the
      // connection returns — nothing is lost — so this just reflects that
      // back to whoever's looking at the screen right now.
      setStatus(navigator.onLine ? "couldn't save — will retry" : "offline — will save once back online");
      ids.forEach(function (id) { dirtyRooms[id] = true; });
      flushTimer = setTimeout(flushDirty, 3000);
    });
  }

  // ---------- mutations ----------

  function toggleItem(roomId, itemId) {
    var room = findRoom(roomId); if (!room) return;
    var item = findItem(room, itemId); if (!item) return;
    item.bought = !item.bought;
    render(); markDirty(roomId);
  }

  function deleteItem(roomId, itemId) {
    var room = findRoom(roomId); if (!room) return;
    room.items = room.items.filter(function (i) { return i.id !== itemId; });
    render(); markDirty(roomId);
  }

  function startAdd(roomId) { addingItemFor = roomId; render(); }
  function cancelAdd() { addingItemFor = null; render(); }

  var pendingNewPhoto = null;
  function confirmAdd(roomId) {
    var scope = document.querySelector('.room[data-room-id="' + roomId + '"] .add-row');
    var text = scope.querySelector(".new-text").value.trim();
    if (!text) { addingItemFor = null; pendingNewPhoto = null; render(); return; }
    var link = scope.querySelector(".new-link").value.trim();
    var priceRaw = scope.querySelector(".new-price").value.trim();
    var price = priceRaw ? parseFloat(priceRaw.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    var room = findRoom(roomId);
    room.items.push({ id: makeId("i"), text: text, link: link || null, price: (price != null && !isNaN(price)) ? price : null, bought: false, image: pendingNewPhoto });
    addingItemFor = null; pendingNewPhoto = null;
    render(); markDirty(roomId);
  }

  function startEdit(roomId, itemId) { editingItem = { roomId: roomId, itemId: itemId }; render(); }
  function cancelEdit() { editingItem = null; render(); }
  function saveEdit(roomId, itemId) {
    var scope = document.querySelector('.room[data-room-id="' + roomId + '"] .item.editing');
    var room = findRoom(roomId);
    var item = room ? findItem(room, itemId) : null;
    if (!scope || !room || !item) { editingItem = null; render(); return; }
    var text = scope.querySelector(".edit-text").value.trim();
    if (text) item.text = text;
    var link = scope.querySelector(".edit-link").value.trim();
    item.link = link || null;
    var priceRaw = scope.querySelector(".edit-price").value.trim();
    var price = priceRaw ? parseFloat(priceRaw.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    item.price = (price != null && !isNaN(price)) ? price : null;
    editingItem = null;
    render(); markDirty(roomId);
  }

  function startAddRoom() { addingRoom = true; render(); }
  function cancelAddRoom() { addingRoom = false; render(); }
  function confirmAddRoom() {
    var input = document.getElementById("new-room-name");
    var name = input ? input.value.trim() : "";
    if (!name) { addingRoom = false; render(); return; }
    var maxOrder = state.rooms.reduce(function (m, r) { return Math.max(m, r.order || 0); }, -1);
    var room = { id: makeId("room-"), name: name, note: null, items: [], order: maxOrder + 1 };
    state.rooms.push(room);
    addingRoom = false;
    render(); markDirty(room.id);
  }

  function startDeleteRoom(roomId) { confirmDeleteRoom = roomId; render(); }
  function cancelDeleteRoom() { confirmDeleteRoom = null; render(); }
  function deleteRoom(roomId) {
    state.rooms = state.rooms.filter(function (r) { return r.id !== roomId; });
    confirmDeleteRoom = null;
    delete dirtyRooms[roomId];
    deletedRooms[roomId] = true;
    render();
    deleteDoc(doc(roomsCol, roomId)).catch(function (err) { console.error("delete failed", err); });
  }

  function setItemPhoto(roomId, itemId, dataUri) {
    var room = findRoom(roomId); if (!room) return;
    var item = findItem(room, itemId); if (!item) return;
    item.image = dataUri;
    render(); markDirty(roomId);
  }

  // ---------- event delegation ----------

  document.getElementById("wrap").addEventListener("click", function (e) {
    if (e.target.id === "add-room-btn") { startAddRoom(); return; }
    if (e.target.id === "cancel-room-btn") { cancelAddRoom(); return; }
    if (e.target.id === "confirm-room-btn") { confirmAddRoom(); return; }
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");
    var roomId = t.getAttribute("data-room");
    var itemId = t.getAttribute("data-item");
    if (action === "delete") deleteItem(roomId, itemId);
    else if (action === "edit") startEdit(roomId, itemId);
    else if (action === "cancel-edit") cancelEdit();
    else if (action === "save-edit") saveEdit(roomId, itemId);
    else if (action === "start-add") startAdd(roomId);
    else if (action === "cancel-add") cancelAdd();
    else if (action === "confirm-add") confirmAdd(roomId);
    else if (action === "start-delete-room") startDeleteRoom(roomId);
    else if (action === "cancel-delete-room") cancelDeleteRoom();
    else if (action === "confirm-delete-room") deleteRoom(roomId);
    else if (action === "room-photo") {
      roomPhotoIndex[roomId] = parseInt(t.getAttribute("data-idx"), 10) || 0;
      render();
    }
    else if (action === "zoom-room") {
      var photos = ROOM_PHOTOS[roomId] || [];
      var idx = roomPhotoIndex[roomId] || 0;
      if (photos.length) { lightboxData = { src: photos[idx], caption: findRoom(roomId).name }; render(); }
    }
    else if (action === "zoom-item") {
      var room = findRoom(roomId); var item = room ? findItem(room, itemId) : null;
      if (item && item.image) { lightboxData = { src: item.image, caption: item.text }; render(); }
    }
    else if (action === "zoom-plan") {
      var idx2 = parseInt(t.getAttribute("data-idx"), 10);
      var plan = PLANS[idx2];
      if (plan) { lightboxData = { src: plan.src, caption: plan.label }; render(); }
    }
  });

  document.getElementById("wrap").addEventListener("change", function (e) {
    var t = e.target;
    if (t.matches('[data-action="toggle"]')) {
      toggleItem(t.getAttribute("data-room"), t.getAttribute("data-item"));
      return;
    }
    if (t.matches('[data-action="item-photo"], [data-action="edit-photo"]') && t.files && t.files[0]) {
      var roomId = t.getAttribute("data-room"), itemId = t.getAttribute("data-item");
      resizeImageFile(t.files[0], 640, 0.75).then(function (dataUri) {
        setItemPhoto(roomId, itemId, dataUri);
      });
      return;
    }
    if (t.matches('[data-action="new-photo"]') && t.files && t.files[0]) {
      var roomId2 = t.getAttribute("data-room");
      resizeImageFile(t.files[0], 640, 0.75).then(function (dataUri) {
        pendingNewPhoto = dataUri;
        var pick = document.getElementById("new-photo-pick");
        if (pick) { pick.classList.add("has-photo"); pick.innerHTML = '<img src="' + dataUri + '" alt="">Photo added<input type="file" accept="image/*" data-action="new-photo" data-room="' + roomId2 + '">'; }
      });
      return;
    }
  });

  document.getElementById("wrap").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    if (e.target.matches(".new-text, .new-link, .new-price")) {
      var room = e.target.closest(".room");
      if (room) { e.preventDefault(); confirmAdd(room.getAttribute("data-room-id")); }
    } else if (e.target.matches(".edit-text, .edit-link, .edit-price")) {
      var editRoom = e.target.closest(".room");
      if (editRoom && editingItem) { e.preventDefault(); saveEdit(editingItem.roomId, editingItem.itemId); }
    } else if (e.target.id === "new-room-name") {
      e.preventDefault(); confirmAddRoom();
    }
  });

  document.getElementById("lightbox-close").addEventListener("click", function () { lightboxData = null; renderLightbox(); });
  document.getElementById("lightbox").addEventListener("click", function (e) {
    if (e.target.id === "lightbox") { lightboxData = null; renderLightbox(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && lightboxData) { lightboxData = null; renderLightbox(); }
  });

  window.addEventListener("online", function () { if (statusMsg.indexOf("offline") === 0) flushDirty(); });

  // ---------- init ----------

  render();
  setInterval(refreshCountdown, 60 * 60 * 1000);
  setStatus("connecting…");

  onAuthStateChanged(auth, function (user) {
    if (!user) return;
    uid = user.uid;
    if (everConnected) return; // don't re-attach listener on token refresh etc.
    everConnected = true;
    setStatus("");
    attachRoomsListener();
  });

  signInAnonymously(auth).catch(function (err) {
    console.error("anonymous sign-in failed", err);
    setStatus("couldn't connect — check your internet and reload");
  });

  function attachRoomsListener() {
    onSnapshot(roomsCol, function (snapshot) {
      if (snapshot.metadata.fromCache && snapshot.empty && !seeded) {
        // Nothing cached and nothing from the server yet — wait for a
        // real answer before deciding whether to seed, so we never
        // wipe real data out from under a slow first load.
        return;
      }
      if (snapshot.empty && !seeded && !snapshot.metadata.hasPendingWrites) {
        seeded = true;
        seedInitialData();
        return;
      }
      snapshot.docChanges().forEach(function (change) {
        var roomId = change.doc.id;
        if (change.type === "removed") {
          if (!isRoomBeingEdited(roomId)) {
            state.rooms = state.rooms.filter(function (r) { return r.id !== roomId; });
          }
          return;
        }
        if (deletedRooms[roomId]) return; // our own delete is still propagating
        if (isRoomBeingEdited(roomId)) return; // don't clobber an open form
        var data = change.doc.data();
        var room = { id: roomId, name: data.name, note: data.note || null, order: data.order || 0, items: data.items || [] };
        var idx = state.rooms.findIndex(function (r) { return r.id === roomId; });
        if (idx === -1) state.rooms.push(room); else state.rooms[idx] = room;
      });
      state.rooms.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      render();
    }, function (err) {
      console.error("listener error", err);
      setStatus("couldn't connect — check your internet and reload");
    });
  }

  function seedInitialData() {
    Promise.all(SEED_ROOMS.map(function (room) {
      return setDoc(doc(roomsCol, room.id), roomDocData(room));
    })).catch(function (err) { console.error("seeding failed", err); });
  }

})();
