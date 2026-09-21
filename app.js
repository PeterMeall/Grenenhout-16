import { firebaseConfig } from "./firebase-config.js";
import { ROOM_PHOTOS, PLANS, HERO_PHOTO } from "./assets-data.js";
import { SEED_ROOMS } from "./seed-data.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, connectFirestoreEmulator, getDoc
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
  var listsCol = collection(db, "lists");
  var expensesCol = collection(db, "expenses");
  var budgetRef = doc(db, "budget", "main");

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

  var state = { rooms: [], lists: [], budgetTotal: null, expenses: [] };
  var seeded = false;
  var budgetLoaded = false;

  var readOnly = false; // stays false; kept for minimal diff vs original UI code
  var activeTab = "rooms"; // "rooms" | "lists" | "budget" — local to this device, not synced

  var addingItemFor = null;
  var addingRoom = false;
  var confirmDeleteRoom = null;
  var editingItem = null;

  var addingListItemFor = null;
  var addingList = false;
  var confirmDeleteList = null;
  var editingListItem = null;

  var editingBudgetTotal = false;
  var addingExpense = false;
  var editingExpenseId = null;
  var confirmDeleteExpenseId = null;

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

  function budgetSummary() {
    var itemsSpent = 0, itemsBoughtCount = 0;
    state.rooms.forEach(function (r) {
      r.items.forEach(function (it) {
        if (it.bought && it.price != null && !isNaN(it.price)) { itemsSpent += Number(it.price); itemsBoughtCount++; }
      });
    });
    var expensesSpent = state.expenses.reduce(function (sum, e) { return sum + (Number(e.amount) || 0); }, 0);
    var totalSpent = itemsSpent + expensesSpent;
    var total = state.budgetTotal;
    var remaining = (total != null) ? (total - totalSpent) : null;
    return {
      itemsSpent: itemsSpent, itemsBoughtCount: itemsBoughtCount,
      expensesSpent: expensesSpent, totalSpent: totalSpent,
      total: total, remaining: remaining
    };
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

  // ---------- lists (notes / inventory) ----------

  function listItemHtml(list, item) {
    var isEditing = editingListItem && editingListItem.listId === list.id && editingListItem.itemId === item.id;
    if (isEditing) {
      return '' +
        '<li class="item editing">' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="edit-text" value="' + esc(item.text) + '" placeholder="Line item"></div>' +
        '<div class="row"><input type="text" class="edit-note" value="' + esc(item.note || "") + '" placeholder="Note (optional)"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-edit-list-item">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-action="save-edit-list-item" data-list="' + list.id + '" data-item="' + item.id + '">Save</button>' +
        '</div>' +
        '</div>' +
        '</li>';
    }
    return '' +
      '<li class="item' + (item.checked ? ' bought' : '') + '">' +
      '<input type="checkbox" class="check" ' + (item.checked ? 'checked' : '') +
      ' data-action="toggle-list-item" data-list="' + list.id + '" data-item="' + item.id + '" aria-label="Mark ' + esc(item.text) + ' as done">' +
      '<div class="item-body">' +
      '<div class="item-main"><span class="item-text">' + esc(item.text) + '</span></div>' +
      (item.note ? '<div class="item-note">' + esc(item.note) + '</div>' : '') +
      '</div>' +
      '<div class="item-actions">' +
      '<button type="button" class="icon-btn" data-action="edit-list-item" data-list="' + list.id + '" data-item="' + item.id + '" title="Edit">✎</button>' +
      '<button type="button" class="icon-btn danger" data-action="delete-list-item" data-list="' + list.id + '" data-item="' + item.id + '" title="Remove">✕</button>' +
      '</div>' +
      '</li>';
  }

  function listHtml(list) {
    var checkedCount = list.items.filter(function (i) { return i.checked; }).length;
    var tallyHtml = list.items.length ? ('<span class="room-tally">' + checkedCount + '/' + list.items.length + '</span>') : '';
    var itemsHtml = list.items.length
      ? list.items.map(function (it) { return listItemHtml(list, it); }).join("")
      : '<div class="empty-hint">Nothing on this list yet.</div>';

    var addRowHtml;
    if (addingListItemFor === list.id) {
      addRowHtml = '' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="new-text" placeholder="Line item"></div>' +
        '<div class="row"><input type="text" class="new-note" placeholder="Note (optional)"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-add-list-item">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-action="confirm-add-list-item" data-list="' + list.id + '">Add</button>' +
        '</div>' +
        '</div>';
    } else {
      addRowHtml = '<button type="button" class="add-toggle" data-action="start-add-list-item" data-list="' + list.id + '">+ add line</button>';
    }

    var listHeadRight;
    if (confirmDeleteList === list.id) {
      listHeadRight = '' +
        '<span class="room-delete-confirm">' +
        '<span>Delete list?</span>' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-delete-list">No</button>' +
        '<button type="button" class="btn btn-danger" data-action="confirm-delete-list" data-list="' + list.id + '">Yes, delete</button>' +
        '</span>';
    } else {
      listHeadRight = '<span style="display:flex; align-items:center;">' + tallyHtml + '<button type="button" class="room-delete-btn" data-action="start-delete-list" data-list="' + list.id + '" title="Delete list">✕</button></span>';
    }

    return '' +
      '<div class="list-card" data-list-id="' + list.id + '">' +
      '<div class="room-head"><h2>' + esc(list.name) + '</h2>' + listHeadRight + '</div>' +
      '<ul class="items">' + itemsHtml + '</ul>' +
      '<div class="add-row">' + addRowHtml + '</div>' +
      '</div>';
  }

  function listsSectionHtml() {
    var listsHtml = state.lists.length
      ? '<div class="rooms">' + state.lists.map(listHtml).join("") + '</div>'
      : '<div class="empty-hint" style="padding:1rem 0;">No lists yet — add one below to start noting down what movers should take, what to buy, and so on.</div>';
    return '' +
      listsHtml +
      '<div class="add-room-block">' + (addingList ?
        '<div class="edit-form" style="max-width:26rem; margin:0 auto;">' +
        '<div class="row"><input type="text" id="new-list-name" placeholder="List name, e.g. “To buy”"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" id="cancel-list-btn">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="confirm-list-btn">Add</button>' +
        '</div>' +
        '</div>'
        : '<button type="button" id="add-list-btn">+ add a list</button>') + '</div>';
  }

  // ---------- budget ----------

  function expenseRowHtml(e) {
    var isEditing = editingExpenseId === e.id;
    if (isEditing) {
      return '' +
        '<li class="item editing">' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="edit-exp-desc" value="' + esc(e.description) + '" placeholder="What was it?"></div>' +
        '<div class="row"><input type="text" class="edit-exp-amount price" value="' + esc(e.amount != null ? e.amount : "") + '" placeholder="Amount"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-edit-expense">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-action="save-edit-expense" data-expense="' + e.id + '">Save</button>' +
        '</div>' +
        '</div>' +
        '</li>';
    }
    if (confirmDeleteExpenseId === e.id) {
      return '' +
        '<li class="item">' +
        '<div class="item-body"><div class="item-main"><span class="item-text">' + esc(e.description) + '</span></div></div>' +
        '<span class="room-delete-confirm"><span>Remove?</span>' +
        '<button type="button" class="btn btn-ghost" data-action="cancel-delete-expense">No</button>' +
        '<button type="button" class="btn btn-danger" data-action="confirm-delete-expense" data-expense="' + e.id + '">Yes</button>' +
        '</span>' +
        '</li>';
    }
    return '' +
      '<li class="item">' +
      '<div class="item-body"><div class="item-main">' +
      '<span class="item-text">' + esc(e.description) + '</span>' +
      '<span class="price-chip">' + esc(fmtPrice(e.amount)) + '</span>' +
      '</div></div>' +
      '<div class="item-actions">' +
      '<button type="button" class="icon-btn" data-action="edit-expense" data-expense="' + e.id + '" title="Edit">✎</button>' +
      '<button type="button" class="icon-btn danger" data-action="start-delete-expense" data-expense="' + e.id + '" title="Remove">✕</button>' +
      '</div>' +
      '</li>';
  }

  function budgetSectionHtml() {
    var b = budgetSummary();
    var pct = (b.total && b.total > 0) ? Math.round(100 * b.totalSpent / b.total) : 0;
    var overBudget = b.remaining != null && b.remaining < 0;

    var totalHtml = editingBudgetTotal
      ? '<div class="edit-form" style="max-width:20rem;">' +
        '<div class="row"><input type="text" id="budget-total-input" class="price" value="' + (b.total != null ? esc(b.total) : "") + '" placeholder="e.g. 15000"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" id="cancel-budget-total-btn">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="save-budget-total-btn">Save</button>' +
        '</div>' +
        '</div>'
      : (b.total != null
        ? '<button type="button" class="add-toggle" id="edit-budget-total-btn" style="width:auto; display:inline-block;">Budget: ' + esc(fmtPrice(b.total)) + ' — edit</button>'
        : '<button type="button" class="add-toggle" id="edit-budget-total-btn" style="width:auto; display:inline-block;">+ set a budget</button>');

    var statsHtml = '';
    if (b.total != null) {
      statsHtml = '' +
        '<div class="hero-progress" style="margin-top:1rem;">' +
        '<div class="count">' + esc(fmtPrice(b.totalSpent)) + '<span> spent of ' + esc(fmtPrice(b.total)) + '</span></div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + Math.min(pct, 100) + '%; ' + (overBudget ? 'background:var(--danger);' : '') + '"></div></div>' +
        '</div>' +
        '<div class="room-note" style="' + (overBudget ? 'color:var(--danger); font-style:normal; font-weight:600;' : '') + '">' +
        (overBudget
          ? (esc(fmtPrice(Math.abs(b.remaining))) + ' over budget')
          : (esc(fmtPrice(b.remaining)) + ' remaining')) +
        '</div>';
    }

    var breakdownHtml = '' +
      '<div class="room-note" style="margin-top:.6rem;">' +
      'From checklist (' + b.itemsBoughtCount + ' item' + (b.itemsBoughtCount === 1 ? '' : 's') + ' ticked): ' + esc(fmtPrice(b.itemsSpent)) + '<br>' +
      'Other purchases: ' + esc(fmtPrice(b.expensesSpent)) +
      '</div>';

    var expensesHtml = state.expenses.length
      ? '<ul class="items">' + state.expenses.map(expenseRowHtml).join("") + '</ul>'
      : '<div class="empty-hint">No purchases logged outside the checklist yet.</div>';

    var addExpenseHtml = addingExpense
      ? '' +
        '<div class="edit-form">' +
        '<div class="row"><input type="text" class="new-exp-desc" placeholder="What was it?"></div>' +
        '<div class="row"><input type="text" class="new-exp-amount price" placeholder="Amount"></div>' +
        '<div class="buttons" style="justify-content:flex-end;">' +
        '<button type="button" class="btn btn-ghost" id="cancel-expense-btn">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="confirm-expense-btn">Add</button>' +
        '</div>' +
        '</div>'
      : '<button type="button" class="add-toggle" id="add-expense-btn">+ log a purchase made outside the app</button>';

    return '' +
      '<div class="list-card">' +
      '<div class="room-head"><h2>Budget</h2></div>' +
      totalHtml +
      statsHtml +
      breakdownHtml +
      '</div>' +
      '<div class="list-card" style="margin-top:1.1rem;">' +
      '<div class="room-head"><h2>Other purchases</h2></div>' +
      expensesHtml +
      '<div class="add-row">' + addExpenseHtml + '</div>' +
      '</div>';
  }

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
      tabsHtml() +
      '<div id="tab-content">' + tabContentHtml() + '</div>';
  }

  function tabsHtml() {
    var tabs = [["rooms", "Rooms"], ["lists", "Lists"], ["budget", "Budget"]];
    return '<div class="tab-bar">' + tabs.map(function (t) {
      return '<button type="button" class="tab-btn' + (activeTab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join("") + '</div>';
  }

  function tabContentHtml() {
    if (activeTab === "lists") return listsSectionHtml();
    if (activeTab === "budget") return budgetSectionHtml();
    return '' +
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
    if (addingListItemFor) {
      var liInput = document.querySelector('.list-card[data-list-id="' + addingListItemFor + '"] .new-text');
      if (liInput) liInput.focus();
    }
    if (addingList) {
      var listInput = document.getElementById("new-list-name");
      if (listInput) listInput.focus();
    }
    if (editingBudgetTotal) {
      var budgetInput = document.getElementById("budget-total-input");
      if (budgetInput) budgetInput.focus();
    }
    if (addingExpense) {
      var expInput = document.querySelector(".new-exp-desc");
      if (expInput) expInput.focus();
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
  function findList(id) { return state.lists.find(function (l) { return l.id === id; }); }
  function findListItem(list, id) { return list.items.find(function (i) { return i.id === id; }); }

  function isRoomBeingEdited(roomId) {
    return addingItemFor === roomId ||
      (editingItem && editingItem.roomId === roomId) ||
      confirmDeleteRoom === roomId;
  }
  function isListBeingEdited(listId) {
    return addingListItemFor === listId ||
      (editingListItem && editingListItem.listId === listId) ||
      confirmDeleteList === listId;
  }

  var dirtyRooms = {}; // roomId -> true
  var dirtyLists = {}; // listId -> true
  var deletedRooms = {}; // roomId -> true, so a lagging snapshot can't resurrect it
  var deletedLists = {};
  var flushTimer = null;

  function markDirty(kind, id) {
    (kind === "list" ? dirtyLists : dirtyRooms)[id] = true;
    setStatus("saving…");
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushDirty, 500);
  }

  function roomDocData(room) {
    return { name: room.name, order: room.order, note: room.note || null, items: room.items };
  }
  function listDocData(list) {
    return { name: list.name, order: list.order, items: list.items };
  }

  function flushDirty() {
    flushTimer = null;
    var roomIds = Object.keys(dirtyRooms); dirtyRooms = {};
    var listIds = Object.keys(dirtyLists); dirtyLists = {};
    if (!roomIds.length && !listIds.length) return;
    var writes = [];
    roomIds.forEach(function (id) {
      var room = findRoom(id);
      if (room) writes.push(setDoc(doc(roomsCol, id), roomDocData(room)));
    });
    listIds.forEach(function (id) {
      var list = findList(id);
      if (list) writes.push(setDoc(doc(listsCol, id), listDocData(list)));
    });
    Promise.all(writes).then(function () {
      setStatus("saved");
      setTimeout(function () { if (statusMsg === "saved") setStatus(""); }, 1200);
    }).catch(function (err) {
      console.error("save failed", err);
      // Firestore's own offline queue already retries writes once the
      // connection returns — nothing is lost — so this just reflects that
      // back to whoever's looking at the screen right now.
      setStatus(navigator.onLine ? "couldn't save — will retry" : "offline — will save once back online");
      roomIds.forEach(function (id) { dirtyRooms[id] = true; });
      listIds.forEach(function (id) { dirtyLists[id] = true; });
      flushTimer = setTimeout(flushDirty, 3000);
    });
  }

  // ---------- mutations ----------

  function toggleItem(roomId, itemId) {
    var room = findRoom(roomId); if (!room) return;
    var item = findItem(room, itemId); if (!item) return;
    item.bought = !item.bought;
    render(); markDirty("room", roomId);
  }

  function deleteItem(roomId, itemId) {
    var room = findRoom(roomId); if (!room) return;
    room.items = room.items.filter(function (i) { return i.id !== itemId; });
    render(); markDirty("room", roomId);
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
    render(); markDirty("room", roomId);
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
    render(); markDirty("room", roomId);
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
    render(); markDirty("room", room.id);
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
    render(); markDirty("room", roomId);
  }

  // ---------- list mutations ----------

  function toggleListItem(listId, itemId) {
    var list = findList(listId); if (!list) return;
    var item = findListItem(list, itemId); if (!item) return;
    item.checked = !item.checked;
    render(); markDirty("list", listId);
  }

  function deleteListItem(listId, itemId) {
    var list = findList(listId); if (!list) return;
    list.items = list.items.filter(function (i) { return i.id !== itemId; });
    render(); markDirty("list", listId);
  }

  function startAddListItem(listId) { addingListItemFor = listId; render(); }
  function cancelAddListItem() { addingListItemFor = null; render(); }
  function confirmAddListItem(listId) {
    var scope = document.querySelector('.list-card[data-list-id="' + listId + '"] .add-row');
    var text = scope.querySelector(".new-text").value.trim();
    if (!text) { addingListItemFor = null; render(); return; }
    var note = scope.querySelector(".new-note").value.trim();
    var list = findList(listId);
    list.items.push({ id: makeId("i"), text: text, note: note || null, checked: false });
    addingListItemFor = null;
    render(); markDirty("list", listId);
  }

  function startEditListItem(listId, itemId) { editingListItem = { listId: listId, itemId: itemId }; render(); }
  function cancelEditListItem() { editingListItem = null; render(); }
  function saveEditListItem(listId, itemId) {
    var scope = document.querySelector('.list-card[data-list-id="' + listId + '"] .item.editing');
    var list = findList(listId);
    var item = list ? findListItem(list, itemId) : null;
    if (!scope || !list || !item) { editingListItem = null; render(); return; }
    var text = scope.querySelector(".edit-text").value.trim();
    if (text) item.text = text;
    var note = scope.querySelector(".edit-note").value.trim();
    item.note = note || null;
    editingListItem = null;
    render(); markDirty("list", listId);
  }

  function startAddList() { addingList = true; render(); }
  function cancelAddList() { addingList = false; render(); }
  function confirmAddList() {
    var input = document.getElementById("new-list-name");
    var name = input ? input.value.trim() : "";
    if (!name) { addingList = false; render(); return; }
    var maxOrder = state.lists.reduce(function (m, l) { return Math.max(m, l.order || 0); }, -1);
    var list = { id: makeId("list-"), name: name, items: [], order: maxOrder + 1 };
    state.lists.push(list);
    addingList = false;
    render(); markDirty("list", list.id);
  }

  function startDeleteList(listId) { confirmDeleteList = listId; render(); }
  function cancelDeleteList() { confirmDeleteList = null; render(); }
  function deleteList(listId) {
    state.lists = state.lists.filter(function (l) { return l.id !== listId; });
    confirmDeleteList = null;
    delete dirtyLists[listId];
    deletedLists[listId] = true;
    render();
    deleteDoc(doc(listsCol, listId)).catch(function (err) { console.error("delete failed", err); });
  }

  // ---------- budget / expense mutations ----------

  function startEditBudgetTotal() { editingBudgetTotal = true; render(); }
  function cancelEditBudgetTotal() { editingBudgetTotal = false; render(); }
  function saveBudgetTotal() {
    var input = document.getElementById("budget-total-input");
    var raw = input ? input.value.trim() : "";
    var val = raw ? parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    state.budgetTotal = (val != null && !isNaN(val)) ? val : null;
    editingBudgetTotal = false;
    render();
    setStatus("saving…");
    setDoc(budgetRef, { total: state.budgetTotal }).then(function () {
      setStatus("saved");
      setTimeout(function () { if (statusMsg === "saved") setStatus(""); }, 1200);
    }).catch(function (err) {
      console.error("save failed", err);
      setStatus(navigator.onLine ? "couldn't save — will retry" : "offline — will save once back online");
    });
  }

  function startAddExpense() { addingExpense = true; render(); }
  function cancelAddExpense() { addingExpense = false; render(); }
  function confirmAddExpense() {
    var scope = document.querySelector(".add-row");
    var descInput = document.querySelector(".new-exp-desc");
    var amountInput = document.querySelector(".new-exp-amount");
    var desc = descInput ? descInput.value.trim() : "";
    if (!desc) { addingExpense = false; render(); return; }
    var raw = amountInput ? amountInput.value.trim() : "";
    var amount = raw ? parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    var expense = { id: makeId("exp-"), description: desc, amount: (amount != null && !isNaN(amount)) ? amount : 0 };
    state.expenses.push(expense);
    addingExpense = false;
    render();
    saveExpense(expense);
  }

  function startEditExpense(id) { editingExpenseId = id; render(); }
  function cancelEditExpense() { editingExpenseId = null; render(); }
  function saveEditExpense(id) {
    var scope = document.querySelector('.item.editing');
    var expense = state.expenses.find(function (e) { return e.id === id; });
    if (!scope || !expense) { editingExpenseId = null; render(); return; }
    var desc = scope.querySelector(".edit-exp-desc").value.trim();
    if (desc) expense.description = desc;
    var raw = scope.querySelector(".edit-exp-amount").value.trim();
    var amount = raw ? parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    expense.amount = (amount != null && !isNaN(amount)) ? amount : 0;
    editingExpenseId = null;
    render();
    saveExpense(expense);
  }

  function startDeleteExpense(id) { confirmDeleteExpenseId = id; render(); }
  function cancelDeleteExpense() { confirmDeleteExpenseId = null; render(); }
  function deleteExpense(id) {
    state.expenses = state.expenses.filter(function (e) { return e.id !== id; });
    confirmDeleteExpenseId = null;
    render();
    deleteDoc(doc(expensesCol, id)).catch(function (err) { console.error("delete failed", err); });
  }

  function saveExpense(expense) {
    setStatus("saving…");
    setDoc(doc(expensesCol, expense.id), { description: expense.description, amount: expense.amount }).then(function () {
      setStatus("saved");
      setTimeout(function () { if (statusMsg === "saved") setStatus(""); }, 1200);
    }).catch(function (err) {
      console.error("save failed", err);
      setStatus(navigator.onLine ? "couldn't save — will retry" : "offline — will save once back online");
    });
  }

  // ---------- event delegation ----------

  document.getElementById("wrap").addEventListener("click", function (e) {
    if (e.target.id === "add-room-btn") { startAddRoom(); return; }
    if (e.target.id === "cancel-room-btn") { cancelAddRoom(); return; }
    if (e.target.id === "confirm-room-btn") { confirmAddRoom(); return; }
    if (e.target.id === "add-list-btn") { startAddList(); return; }
    if (e.target.id === "cancel-list-btn") { cancelAddList(); return; }
    if (e.target.id === "confirm-list-btn") { confirmAddList(); return; }
    if (e.target.id === "edit-budget-total-btn") { startEditBudgetTotal(); return; }
    if (e.target.id === "cancel-budget-total-btn") { cancelEditBudgetTotal(); return; }
    if (e.target.id === "save-budget-total-btn") { saveBudgetTotal(); return; }
    if (e.target.id === "add-expense-btn") { startAddExpense(); return; }
    if (e.target.id === "cancel-expense-btn") { cancelAddExpense(); return; }
    if (e.target.id === "confirm-expense-btn") { confirmAddExpense(); return; }
    var tabBtn = e.target.closest(".tab-btn");
    if (tabBtn) { activeTab = tabBtn.getAttribute("data-tab"); render(); return; }
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");
    var roomId = t.getAttribute("data-room");
    var itemId = t.getAttribute("data-item");
    var listId = t.getAttribute("data-list");
    var expenseId = t.getAttribute("data-expense");
    if (action === "toggle-list-item") { toggleListItem(listId, itemId); return; }
    if (action === "delete-list-item") { deleteListItem(listId, itemId); return; }
    if (action === "edit-list-item") { startEditListItem(listId, itemId); return; }
    if (action === "cancel-edit-list-item") { cancelEditListItem(); return; }
    if (action === "save-edit-list-item") { saveEditListItem(listId, itemId); return; }
    if (action === "start-add-list-item") { startAddListItem(listId); return; }
    if (action === "cancel-add-list-item") { cancelAddListItem(); return; }
    if (action === "confirm-add-list-item") { confirmAddListItem(listId); return; }
    if (action === "start-delete-list") { startDeleteList(listId); return; }
    if (action === "cancel-delete-list") { cancelDeleteList(); return; }
    if (action === "confirm-delete-list") { deleteList(listId); return; }
    if (action === "edit-expense") { startEditExpense(expenseId); return; }
    if (action === "cancel-edit-expense") { cancelEditExpense(); return; }
    if (action === "save-edit-expense") { saveEditExpense(expenseId); return; }
    if (action === "start-delete-expense") { startDeleteExpense(expenseId); return; }
    if (action === "cancel-delete-expense") { cancelDeleteExpense(); return; }
    if (action === "confirm-delete-expense") { deleteExpense(expenseId); return; }
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
    } else if (e.target.matches(".new-text, .new-note") && e.target.closest(".list-card")) {
      var listCard = e.target.closest(".list-card");
      e.preventDefault(); confirmAddListItem(listCard.getAttribute("data-list-id"));
    } else if (e.target.matches(".edit-text, .edit-note") && e.target.closest(".list-card")) {
      if (editingListItem) { e.preventDefault(); saveEditListItem(editingListItem.listId, editingListItem.itemId); }
    } else if (e.target.id === "new-list-name") {
      e.preventDefault(); confirmAddList();
    } else if (e.target.id === "budget-total-input") {
      e.preventDefault(); saveBudgetTotal();
    } else if (e.target.matches(".new-exp-desc, .new-exp-amount")) {
      e.preventDefault(); confirmAddExpense();
    } else if (e.target.matches(".edit-exp-desc, .edit-exp-amount")) {
      if (editingExpenseId != null) { e.preventDefault(); saveEditExpense(editingExpenseId); }
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
    attachListsListener();
    attachExpensesListener();
    attachBudgetListener();
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

  function attachListsListener() {
    onSnapshot(listsCol, function (snapshot) {
      snapshot.docChanges().forEach(function (change) {
        var listId = change.doc.id;
        if (change.type === "removed") {
          if (!isListBeingEdited(listId)) {
            state.lists = state.lists.filter(function (l) { return l.id !== listId; });
          }
          return;
        }
        if (deletedLists[listId]) return; // our own delete is still propagating
        if (isListBeingEdited(listId)) return; // don't clobber an open form
        var data = change.doc.data();
        var list = { id: listId, name: data.name, order: data.order || 0, items: data.items || [] };
        var idx = state.lists.findIndex(function (l) { return l.id === listId; });
        if (idx === -1) state.lists.push(list); else state.lists[idx] = list;
      });
      state.lists.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      render();
    }, function (err) { console.error("lists listener error", err); });
  }

  function attachExpensesListener() {
    onSnapshot(expensesCol, function (snapshot) {
      snapshot.docChanges().forEach(function (change) {
        var id = change.doc.id;
        if (change.type === "removed") {
          if (editingExpenseId !== id && confirmDeleteExpenseId !== id) {
            state.expenses = state.expenses.filter(function (e) { return e.id !== id; });
          }
          return;
        }
        if (editingExpenseId === id) return; // don't clobber an open edit form
        var data = change.doc.data();
        var expense = { id: id, description: data.description, amount: data.amount };
        var idx = state.expenses.findIndex(function (e) { return e.id === id; });
        if (idx === -1) state.expenses.push(expense); else state.expenses[idx] = expense;
      });
      render();
    }, function (err) { console.error("expenses listener error", err); });
  }

  function attachBudgetListener() {
    onSnapshot(budgetRef, function (snapshot) {
      budgetLoaded = true;
      if (editingBudgetTotal) return; // don't clobber an open edit
      var data = snapshot.data();
      state.budgetTotal = (data && data.total != null) ? data.total : null;
      render();
    }, function (err) { console.error("budget listener error", err); });
  }

})();
